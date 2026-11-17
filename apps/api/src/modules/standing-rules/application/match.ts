// SPDX-License-Identifier: AGPL-3.0-only
// An Item reaches Needs approval and a rule may approve it. Count, reserve and approve are separate
// transactions, in an order that fails safe: a crash leaves it waiting for a person, or over-counted.
import type { Ledger, SnapshotEntry } from "../../ledger";
import { nextMailboxTime, reserveMailbox, reserveTouch } from "../../schedule";
import { actionItemByItem, activeRulesForStep, deleteUse, hasUse, inWorkspace, insertUse, lockRule, setRuleNote, setRuleSlot, usesOn, waitingAmong, type RuleRow } from "../adapters/repo";
import { notCoveredWords, whyNotCovered } from "../domain/cover";
import { draftedOf, GATE_CLOSED, noteCause, subjectOf, type GateOpen, type MayGrant } from "./check";
import type { CampaignPort } from "./port";

const utcDay = (d: Date) => d.toISOString().slice(0, 10);
/** A time already gone, moved to today: the same time of day, or now if that has passed too. */
const sameTimeToday = (planned: Date, at: Date) => {
  const today = new Date(`${utcDay(at)}T${planned.toISOString().slice(11)}`);
  return today < at ? at : today;
};

export function matching(d: { ledger: Ledger; port: CampaignPort; now: () => Date; mayGrant: MayGrant; gateOpen?: GateOpen }) {
  const movedKinds = async (workspaceId: string, snapshot: SnapshotEntry[]) => {
    const live = await d.ledger.liveVersions(workspaceId, snapshot);
    return [...new Set(snapshot.filter((e, i) => live[i] !== e.version).map((e) => e.kind))];
  };

  // The cap is read and the use written under the rule's row lock, so concurrent matches can't pass it.
  const count = (workspaceId: string, ruleId: string, itemId: string, day: string, moved: readonly string[], at: Date) =>
    inWorkspace(workspaceId, async (tx) => {
      const rule = await lockRule(tx, ruleId);
      const row = await actionItemByItem(tx, itemId);
      const link = row && (await d.port.linkOf(tx, row.actionId));
      if (!rule || !row || !link) return "gone" as const;
      const counted = await hasUse(tx, ruleId, row.actionId);
      const usedToday = counted ? null : await usesOn(tx, ruleId, day);
      const drafted = rule.mode === "agent_written" ? await draftedOf(tx, d.port, row, d.gateOpen ?? GATE_CLOSED) : undefined;
      const why = whyNotCovered(rule, subjectOf(row, link, { granterMayGrant: await d.mayGrant(tx, rule.grantedBy), movedKinds: moved, usedToday, drafted }), at);
      if (why) return why;
      if (!counted) await insertUse(tx, { workspaceId, ruleId, actionId: row.actionId, day, at });
      return { mine: !counted, producerDigest: drafted?.digest };
    });

  async function onSubmitted(workspaceId: string, itemId: string, opts: { reslot?: boolean } = {}): Promise<void> {
    const at = d.now();
    const found = await inWorkspace(workspaceId, async (tx) => {
      const row = await actionItemByItem(tx, itemId);
      if (row?.state !== "needs_approval") return null;
      const link = await d.port.linkOf(tx, row.actionId);
      return link ? { row, rules: await activeRulesForStep(tx, link.campaignId, link.stepKey) } : null;
    });
    if (!found?.rules.length) return;
    const { row, rules } = found;
    const snapshot = (row.snapshot ?? []) as SnapshotEntry[];
    const planned = row.plannedAt ?? at;
    if (planned < at && !opts.reslot) return;
    const wanted = planned < at ? sameTimeToday(planned, at) : planned;
    // A rule has no person to choose, so a full Mailbox day, or a time outside its hours, moves on to the next time with room.
    const slot = (await nextMailboxTime(workspaceId, row.actionId, wanted, { now: at })) ?? wanted;
    const moved = await movedKinds(workspaceId, snapshot);
    for (const rule of rules) if (await tryRule(workspaceId, rule, itemId, row.actionId, row.draftVersion, snapshot, slot, moved, at)) return;
  }

  async function tryRule(workspaceId: string, rule: RuleRow, itemId: string, actionId: string, draftVersion: number, snapshot: SnapshotEntry[], slot: Date, moved: readonly string[], at: Date): Promise<boolean> {
    const counted = await count(workspaceId, rule.id, itemId, utcDay(slot), moved, at);
    if (counted === "gone") return false;
    if (typeof counted === "string") {
      const why = counted;
      await inWorkspace(workspaceId, async (tx) => {
        await noteCause(tx, rule, why, at);
        if (why === "over_cap") await setRuleNote(tx, itemId, `Standing rule: ${notCoveredWords(why)}`);
      });
      return false;
    }
    const giveBack = (note: string | null) =>
      inWorkspace(workspaceId, async (tx) => {
        // Another match may hold this use, or be about to approve under it. Only its own count goes back.
        if (counted.mine) await deleteUse(tx, rule.id, actionId);
        await setRuleNote(tx, itemId, note);
      });
    const reserved = await reserveTouch(workspaceId, actionId, slot, { now: at });
    if (reserved.kind !== "reserved" && reserved.kind !== "not_counted") {
      await giveBack(reserved.kind === "full" ? `Standing rule: no room at this time (${reserved.cap})` : null);
      return false;
    }
    const day = await reserveMailbox(workspaceId, actionId, slot, { now: at });
    if (day.kind === "full") {
      await giveBack(`Standing rule: the Mailbox's ${day.day} is full (${day.limit} a day)`);
      return false;
    }
    await inWorkspace(workspaceId, (tx) => setRuleSlot(tx, itemId, slot));
    const approved = await d.ledger.approveByRule(workspaceId, actionId, { ruleId: rule.id, draftVersion, snapshot, dueAt: slot, ...(counted.producerDigest ? { producerDigest: counted.producerDigest } : {}) });
    // Another match got there first: this Action is approved once, and its use stands.
    if (!approved.ok && approved.reason !== "wrong_state") await giveBack(null);
    return approved.ok;
  }

  return {
    onSubmitted,
    /**
     * The cap counts by send day, so an Item a full day left waiting can't fit that day later. Once its
     * time has gone it moves to today and asks again. Nothing it has already approved moves.
     */
    async retryOverCap(workspaceId: string, campaignId: string, stepKey: string) {
      const waiting = await inWorkspace(workspaceId, async (tx) => waitingAmong(tx, await d.port.actionsIn(tx, campaignId, stepKey)));
      for (const w of waiting) if (w.ruleNote) await onSubmitted(workspaceId, w.itemId, { reslot: true });
    },
    /** Grant and re-confirm cover what is already waiting. Held Items stay Held. */
    async matchWaiting(workspaceId: string, campaignId: string, stepKey: string): Promise<number> {
      const waiting = await inWorkspace(workspaceId, async (tx) => waitingAmong(tx, await d.port.actionsIn(tx, campaignId, stepKey)));
      for (const w of waiting) await onSubmitted(workspaceId, w.itemId);
      return waiting.length;
    },
  };
}
