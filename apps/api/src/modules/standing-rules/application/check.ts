// SPDX-License-Identifier: AGPL-3.0-only
// The rule is asked again at claim and at dispatch: whatever it approved earlier, it must still cover now.
import { touchField } from "@direx/plugin-sdk/host";
import type { Check, LedgerTx } from "../../ledger";
import { actionItemByAction, inWorkspace, insertRevision, readRule, updateRule, type ActionItem, type RuleRow, type RulesTx } from "../adapters/repo";
import { blocking, type Warning } from "../../items";
import { notCoveredWords, suspendsRule, whyNotCovered, type Drafted, type NotCovered, type SnapshotEntry, type Subject } from "../domain/cover";
import type { CampaignPort } from "./port";

const SYSTEM = { system: "standing_rules" } as const;

export type MayGrant = (tx: RulesTx, userId: string) => Promise<boolean>;
/** Whether the safety results for the drafter in use meet their signed bars. Read once at boot. */
export type GateOpen = () => boolean;
export const GATE_CLOSED: GateOpen = () => false;

export async function suspend(tx: RulesTx, rule: RuleRow, reason: string, at: Date) {
  if (rule.status !== "active") return rule;
  const next = await updateRule(tx, rule.id, { status: "suspended", suspendedReason: reason });
  await insertRevision(tx, next, "suspend", SYSTEM, reason, at);
  return next;
}

export const touchClassOf = (spec: unknown): string | null => touchField(spec, "touchClass") ?? null;

/** What an agent-written rule reads about this Action's draft, or nothing for text a person wrote. */
export async function draftedOf(tx: RulesTx, port: CampaignPort, row: ActionItem, gateOpen: GateOpen): Promise<(Drafted & { digest: string }) | undefined> {
  const draft = await port.draftOf(tx, row.actionId);
  if (!draft) return undefined;
  // Warnings written for an older draft no longer describe this one, so they count against it.
  const stale = row.describedDraftVersion === row.draftVersion ? 0 : 1;
  return { producer: draft.producer, checksPassed: draft.checksPassed, blockingWarnings: blocking(row.warnings as Warning[]).length + stale, outsideContent: draft.outsideContent, gateOpen: gateOpen(), digest: draft.digest };
}

export function subjectOf(row: ActionItem, link: { campaignId: string; stepKey: string; joinedAt: Date }, more: { granterMayGrant: boolean; movedKinds: readonly string[]; usedToday: number | null; drafted?: Drafted | undefined }): Subject {
  return {
    capability: row.capability,
    dedupe: row.dedupe,
    touchClass: touchClassOf(row.spec),
    campaignId: link.campaignId,
    stepKey: link.stepKey,
    snapshot: (row.snapshot ?? []) as SnapshotEntry[],
    personJoinedAt: link.joinedAt,
    // Details written for an older draft no longer describe it, so they can't count as clean.
    clean: (row.warnings as unknown[]).length === 0 && row.describedDraftVersion === row.draftVersion,
    granterMayGrant: more.granterMayGrant,
    movedKinds: more.movedKinds,
    usedToday: more.usedToday,
    ...(more.drafted ? { drafted: more.drafted } : {}),
  };
}

export async function noteCause(tx: RulesTx, rule: RuleRow, why: NotCovered, at: Date) {
  if (suspendsRule(why)) await suspend(tx, rule, notCoveredWords(why), at);
}

export const ruleStillCovers = (d: { port: CampaignPort; now: () => Date; mayGrant: MayGrant; gateOpen?: GateOpen }): Check => async (tx: LedgerTx, action, approval) => {
  if (!approval.standingRuleId) return { kind: "ok" };
  const hold = (detail: string) => ({ kind: "hold", reason: "rule_needs_review", detail }) as const;
  const rule = await readRule(tx, approval.standingRuleId);
  const row = await actionItemByAction(tx, action.id);
  const link = await d.port.linkOf(tx, action.id);
  if (!rule || !row || !link) return hold("rule or campaign is gone");
  const at = d.now();
  const drafted = rule.mode === "agent_written" ? await draftedOf(tx, d.port, row, d.gateOpen ?? GATE_CLOSED) : undefined;
  const why = whyNotCovered(rule, subjectOf(row, link, { granterMayGrant: await d.mayGrant(tx, rule.grantedBy), movedKinds: [], usedToday: null, drafted }), at);
  // The words or their checks were swapped after the rule approved them.
  if (!why && rule.mode === "agent_written" && drafted?.digest !== approval.producerDigest) return hold("the draft or its checks changed after the rule approved it");
  if (!why) return { kind: "ok" };
  await noteCause(tx, rule, why, at);
  return hold(notCoveredWords(why));
};

/** Given to the ledger: a provider refused a send as over its limit or as abuse. Only a rule no one reads stops. */
export const suspendOnProviderLimit = (d: { now: () => Date }) => async (tx: LedgerTx, ruleId: string, limit: "sending_limit" | "abuse") => {
  const rule = await readRule(tx, ruleId);
  if (rule?.mode === "agent_written") await suspend(tx, rule, limit === "abuse" ? "the mail provider refused sends and reported abuse" : "the mail provider refused sends over its sending limit", d.now());
};

/** Given to the ledger: what its own snapshot comparison found on a rule's approval. Template changes only stop matching. */
export const suspendOnStale = (d: { now: () => Date }) => async (tx: LedgerTx, ruleId: string, kinds: readonly string[]) => {
  const why = kinds.includes("fact") ? "fact_changed" : kinds.includes("capability") ? "capability_changed" : null;
  if (!why) return;
  const rule = await readRule(tx, ruleId);
  if (rule) await suspend(tx, rule, notCoveredWords(why), d.now());
};

export { inWorkspace };
