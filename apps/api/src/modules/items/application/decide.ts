// SPDX-License-Identifier: AGPL-3.0-only
// What a person decides about an Item. Refusals come back as values. The snapshot and slot
// an approval binds always come from the Item, never from the request.
import { storedSpec } from "@direx/plugin-sdk/host";
import { isLate, type Actor, type ApproverId, type Ledger, type Refusal, type SnapshotEntry } from "../../ledger";
import { reserveMailbox, reserveTouch } from "../../schedule";
import { inWorkspace, insertDecision, lockOwnItem, moveOwnState, noteEvent, readItem, rebindActionItem, setPlannedAt, type ItemsTx, type JoinedItem } from "../adapters/repo";
import type { ReasonGiven } from "../domain/rates";
import { detailsStale } from "../domain/state";
import { warn, type Warning } from "../domain/warnings";
import type { ItemKind } from "./items";
import { nextFreeSlot } from "./late";
import { toView, type ItemView } from "./view";

export type ItemRefusal = Refusal | "not_clean" | "details_stale" | "slot_full" | "mailbox_day_full" | "slot_in_past" | "forbidden" | "choice_not_allowed" | (string & {});
/** A refusal's `day` and `limit` name the Mailbox day that was full. */
export type Decided = { ok: true; item: ItemView } | { ok: false; reason: ItemRefusal; cap?: string; day?: string; limit?: number };
const refuse = (reason: ItemRefusal, cap?: string): Decided => ({ ok: false, reason, ...(cap && { cap }) });

/** A changed entry in words a person can check, such as a fact's current value. Null when there is nothing more to say. */
export type DescribeChange = (tx: ItemsTx, entry: SnapshotEntry, live: string | null) => Promise<string | null>;
const REREAD = warn("changed_since_drafted", "Something this relies on changed. Read it before approving.");

type Who = { approverId: ApproverId; may: (permission: string) => boolean; steppedUp?: boolean };

/** An Item with no outside effect, just approved: what it was and who approved it. */
export type AppliedItem = { id: string; kind: string; payload: unknown; userId: string };
export type OnApplied = (workspaceId: string, item: AppliedItem) => Promise<void>;
/** How far the words decided on moved from what a writer proposed, and the step they belong to. Null when no writer proposed them. */
export type EditOf = (workspaceId: string, itemId: string, decidedText: string) => Promise<{ campaignId: string; stepKey: string; editDistance: number | null; editPhrases: string[] } | null>;

/** An item counts as open at most this long before its decision, so a tab left open doesn't read as slow reading. */
const MAX_OPEN_MS = 30 * 60_000;
export const clampOpened = (openedAt: Date, decidedAt: Date) => new Date(Math.min(decidedAt.getTime(), Math.max(openedAt.getTime(), decidedAt.getTime() - MAX_OPEN_MS)));

export function decisions({
  ledger,
  kinds,
  now,
  describeChange,
  onApproved,
  onApplied,
  actionPermission,
  mayGrant,
  resumeLate,
  editOf,
}: {
  ledger: Ledger;
  kinds: Record<string, ItemKind>;
  now: () => Date;
  describeChange?: DescribeChange | undefined;
  onApproved?: ((workspaceId: string, itemId: string) => Promise<void>) | undefined;
  onApplied?: OnApplied | undefined;
  /** The permission approving this capability's Action takes, when it isn't item.approve. */
  actionPermission?: ((capability: string) => string | undefined) | undefined;
  /** Whether a person may still give the grant an Item is applied under, read in the same transaction. */
  mayGrant?: ((tx: ItemsTx, userId: string) => Promise<boolean>) | undefined;
  /** Sends a late Action at its Person's next free slot. */
  resumeLate?: ((workspaceId: string, actionId: string, actor: Actor) => Promise<{ ok: true } | { ok: false; reason: string }>) | undefined;
  editOf?: EditOf | undefined;
}) {
  const read = (workspaceId: string, id: string) => inWorkspace(workspaceId, (tx) => readItem(tx, id));

  /**
   * One decision a person made from the review page, which says when the Item opened. Only a record for
   * their own rates, so a failure is logged and never undoes the decision.
   */
  async function record(workspaceId: string, row: JoinedItem, reviewerId: string, decided: "approve" | "reject" | "rewrite", openedAt: Date | undefined, given?: ReasonGiven) {
    if (!openedAt) return;
    try {
      const action = row.item.actionId ? await ledger.getAction(workspaceId, row.item.actionId) : undefined;
      // Only a per-Person email has an edit to measure, so the spec reads as an email's.
      const { text } = storedSpec("email.send", action?.spec);
      const found = text !== undefined ? await editOf?.(workspaceId, row.item.id, text) : null;
      // A rewrite is not a decision on the words, so only its step is kept; its edits count when it's decided.
      const edit = found && decided === "rewrite" ? { ...found, editDistance: null, editPhrases: [] } : found;
      const decidedAt = now();
      const decision = decided === "approve" && edit?.editDistance ? "edit_approve" : decided;
      await inWorkspace(workspaceId, (tx) =>
        insertDecision(tx, {
          workspaceId,
          itemId: row.item.id,
          reviewerId,
          kind: row.item.kind,
          decision,
          campaignId: edit?.campaignId ?? null,
          stepKey: edit?.stepKey ?? null,
          openedAt: clampOpened(openedAt, decidedAt),
          decidedAt,
          editDistance: edit?.editDistance ?? null,
          editPhrases: edit?.editPhrases ?? [],
          reason: given?.reason ?? null,
          reasonNote: given?.note?.trim() || null,
        }),
      );
    } catch (e) {
      console.error("items: review record failed", row.item.id, e);
    }
  }
  const done = async (workspaceId: string, id: string): Promise<Decided> => ({ ok: true, item: toView((await read(workspaceId, id))!) });

  const permissionFor = ({ item, action }: JoinedItem) => {
    if (item.kind === "action") return (action?.capability && actionPermission?.(action.capability)) ?? "item.approve";
    const kind = kinds[item.kind];
    return kind?.permissionOf ? kind.permissionOf(item) : kind?.permission;
  };

  async function approveAction(workspaceId: string, row: JoinedItem, revision: number, who: Who): Promise<Decided> {
    const { item, action } = row;
    if (action!.draftVersion !== revision) return refuse("draft_version_moved");
    if (action!.state !== "needs_approval") return refuse("wrong_state");
    if (detailsStale(item.describedDraftVersion!, action!.draftVersion)) return refuse("details_stale");
    const at = now();
    // A time already gone must be chosen again: the person is approving "sends Tue 9:00".
    if (item.plannedAt && item.plannedAt < at) return refuse("slot_in_past");
    const slot = item.plannedAt ?? at;
    const reserved = await reserveTouch(workspaceId, item.actionId!, slot, { now: at });
    if (reserved.kind === "full") return refuse("slot_full", reserved.cap);
    if (reserved.kind === "not_found") return refuse("not_found");
    const day = await reserveMailbox(workspaceId, item.actionId!, slot, { now: at });
    if (day.kind === "full") return { ok: false, reason: "mailbox_day_full", day: day.day, limit: day.limit };
    const r = await ledger.approve(workspaceId, item.actionId!, {
      approverId: who.approverId,
      draftVersion: revision,
      snapshot: item.snapshot as SnapshotEntry[],
      dueAt: slot,
    });
    if (!r.ok) return refuse(r.reason);
    // Only a suggestion hangs on this, so a failure mustn't undo the approval.
    await onApproved?.(workspaceId, item.id).catch((e) => console.error("items: onApproved failed", item.id, e));
    return done(workspaceId, item.id);
  }

  /** `recordedAs` is who the history names: the person, or the grant they gave. */
  async function approveOwn(workspaceId: string, id: string, revision: number | null, who: Who, choice?: string, recordedAs?: Actor, stillGranted?: (tx: ItemsTx) => Promise<boolean>): Promise<Decided> {
    const decided = await inWorkspace(workspaceId, async (tx): Promise<Decided & { applied?: AppliedItem }> => {
      const own = await lockOwnItem(tx, id);
      if (!own) return refuse("not_found");
      if (revision !== null && own.version !== revision) return refuse("draft_version_moved");
      if (own.state !== "needs_approval") return refuse("wrong_state");
      if (stillGranted && !(await stillGranted(tx))) return refuse("forbidden");
      const actor = { userId: who.approverId as string };
      const applied = await kinds[own.kind]!.apply(tx, own, actor, choice);
      if (!applied.ok) return refuse(applied.reason);
      const next = await moveOwnState(tx, own, kinds[own.kind]!.waitsForPerson ? "scheduled" : "applied", recordedAs ?? actor, now());
      if (next === "stale") return refuse("stale");
      return { ok: true, item: toView({ item: next, action: null }), applied: { id: own.id, kind: own.kind, payload: own.payload, userId: actor.userId } };
    });
    if (!decided.ok) return decided;
    const { applied, ...result } = decided;
    // Runs after the commit and only suggests work, so a failure mustn't undo the approval.
    await onApplied?.(workspaceId, applied!).catch((e) => console.error("items: onApplied failed", id, e));
    return result;
  }

  // Binds the next approval to what is true now, and warns, so "approve all clean" leaves it for someone
  // to read. A crash before this leaves the old versions, and approving holds it again.
  async function rebind(workspaceId: string, row: JoinedItem, heldFor: string) {
    const entries = (row.item.snapshot ?? []) as SnapshotEntry[];
    const live = await ledger.liveVersions(workspaceId, entries);
    const changed = entries.flatMap((e, i) => (live[i] === e.version ? [] : [{ e, live: live[i] ?? null }]));
    if (!changed.length && heldFor !== "snapshot_changed") return;
    const current = entries.flatMap((e, i) => (live[i] ? [{ ...e, version: live[i]! }] : []));
    await inWorkspace(workspaceId, async (tx) => {
      const said: Warning[] = [];
      for (const c of changed) {
        const words = await describeChange?.(tx, c.e, c.live);
        if (words) said.push(warn("changed_since_drafted", words));
      }
      await rebindActionItem(tx, row.item.id, current, [...(row.item.warnings as Warning[]), ...(said.length ? said : [REREAD])], now());
    });
  }

  const api = {
    /** `openedAt` comes from the review page; with it, the decision is recorded for the person's own rates. `praise` is "This one's great". */
    async approve(workspaceId: string, id: string, revision: number, who: Who, choice?: string, openedAt?: Date, praise?: boolean): Promise<Decided> {
      const row = await read(workspaceId, id);
      if (!row) return refuse("not_found");
      const permission = permissionFor(row);
      if (!permission || !who.may(permission)) return refuse("forbidden");
      if (kinds[row.item.kind]?.stepUp && !who.steppedUp) return refuse("step_up_required");
      // Approving an Action has one meaning: the draft goes out as shown.
      if (row.action && choice !== undefined) return refuse("choice_not_allowed");
      // A company review's "reject" is a choice on approve, and counts as one.
      const decided = row.action ? await approveAction(workspaceId, row, revision, who) : await approveOwn(workspaceId, id, revision, who, choice);
      if (decided.ok) await record(workspaceId, row, who.approverId as string, choice === "reject" ? "reject" : "approve", openedAt, praise && choice !== "reject" ? { reason: "great" } : undefined);
      return decided;
    },

    /** Records a rewrite a person asked for with a reason, after it started. Like every record, a failure is only logged. */
    async recordRewrite(workspaceId: string, id: string, userId: string, given: ReasonGiven, openedAt?: Date): Promise<void> {
      const row = await read(workspaceId, id);
      if (row) await record(workspaceId, row, userId, "rewrite", openedAt, given);
    },

    /**
     * Applies an own Item under a grant a person gave earlier, such as a Campaign set to run. The work
     * starts as that person, the history names the grant, and it is refused once they could no longer
     * give it. Never an Action: what goes out is approved by a person or a standing rule.
     */
    async applyByGrant(workspaceId: string, id: string, grant: { userId: string; as: string; choice?: string }): Promise<Decided> {
      const row = await read(workspaceId, id);
      if (!row) return refuse("not_found");
      const kind = kinds[row.item.kind];
      if (row.action || !kind || kind.stepUp || kind.grant === false) return refuse("forbidden");
      if (!mayGrant) return refuse("forbidden");
      const who: Who = { approverId: grant.userId as ApproverId, may: () => true };
      return approveOwn(workspaceId, id, null, who, grant.choice, { system: grant.as }, (tx) => mayGrant(tx, grant.userId));
    },

    /** Each Item on its own, so one refusal stops only itself. The server decides what is clean. */
    async approveClean(workspaceId: string, entries: readonly { id: string; revision: number }[], who: Who) {
      const results: { id: string; result: Decided }[] = [];
      for (const { id, revision } of entries) {
        const row = await read(workspaceId, id);
        const result = !row
          ? refuse("not_found")
          : kinds[row.item.kind]?.bulk === false
            ? refuse("one_at_a_time")
            : !toView(row).clean
              ? refuse("not_clean")
              : await api.approve(workspaceId, id, revision, who);
        results.push({ id, result });
      }
      return results;
    },

    /** Cancel, or Dismiss for a non-Action Item. `given` is why, when the person dropped a draft with a reason. */
    async cancel(workspaceId: string, id: string, actor: Actor, openedAt?: Date, given?: ReasonGiven): Promise<Decided> {
      const row = await read(workspaceId, id);
      if (!row) return refuse("not_found");
      if (row.item.actionId) {
        const r = await ledger.cancel(workspaceId, row.item.actionId, actor);
        if (r.ok && "userId" in actor) await record(workspaceId, row, actor.userId, "reject", openedAt, given);
        return r.ok ? done(workspaceId, id) : refuse(r.reason);
      }
      return inWorkspace(workspaceId, async (tx) => {
        const own = await lockOwnItem(tx, id);
        if (own?.state !== "draft" && own?.state !== "needs_approval" && own?.state !== "scheduled") return refuse("wrong_state");
        if (kinds[own.kind]?.dismiss === false) return refuse("choice_required");
        const next = await moveOwnState(tx, own, "cancelled", actor, now());
        if (next === "stale") return refuse("stale");
        await kinds[own.kind]?.onDismiss?.(tx, own);
        return { ok: true, item: toView({ item: next, action: null }) };
      });
    },

    /** A Held Item whose reason cleared; every check runs again at claim. */
    /**
     * Reverses an applied Item through its kind, as the person asking. The Item stays Applied and its
     * approval stands; its history notes the undo, and the reverse is recorded where it happened.
     */
    async undo(workspaceId: string, id: string, who: { userId: string; may: (permission: string) => boolean }): Promise<Decided> {
      const row = await read(workspaceId, id);
      if (!row) return refuse("not_found");
      const undoer = kinds[row.item.kind]?.undo;
      if (!undoer || row.item.state !== "applied") return refuse("wrong_state");
      if (!who.may(undoer.permission)) return refuse("forbidden");
      const r = await undoer.apply(row.item, { userId: who.userId });
      if (!r.ok) return refuse(r.reason);
      await inWorkspace(workspaceId, (tx) => noteEvent(tx, row.item, "undone", { userId: who.userId }, now()));
      return done(workspaceId, id);
    },

    async resume(workspaceId: string, id: string, actor: Actor): Promise<Decided> {
      const row = await read(workspaceId, id);
      if (!row) return refuse("not_found");
      if (!row.item.actionId) return refuse("wrong_state");
      // Past its time, whatever held it: only at a time this person's resume reserves, never its old one.
      const pastTime = row.action?.holdReason === "late" || (row.action?.dueAt && isLate(row.action.dueAt, now()));
      const r = pastTime && resumeLate ? await resumeLate(workspaceId, row.item.actionId, actor) : await ledger.resume(workspaceId, row.item.actionId, actor);
      if (!r.ok) return refuse(r.reason);
      const heldFor = row.action?.holdReason;
      if (heldFor === "snapshot_changed" || heldFor === "rule_needs_review") await rebind(workspaceId, row, heldFor);
      return done(workspaceId, id);
    },

    async resolveUnknown(workspaceId: string, id: string, choice: "mark_sent" | "resend", userId: string): Promise<Decided> {
      const row = await read(workspaceId, id);
      if (!row) return refuse("not_found");
      if (!row.item.actionId) return refuse("wrong_state");
      // A late resend goes out at the next free slot, which the person's choice reserves.
      const late = choice === "resend" && row.action?.dueAt && isLate(row.action.dueAt, now());
      const slot = late ? await nextFreeSlot(workspaceId, row.item.actionId, now()) : undefined;
      if (late && !slot) return refuse("no_free_slot");
      if (slot) await inWorkspace(workspaceId, (tx) => setPlannedAt(tx, id, slot, now()));
      const r = await ledger.resolveUnknown(workspaceId, row.item.actionId, choice, userId, slot ? { dueAt: slot } : {});
      return r.ok ? done(workspaceId, id) : refuse(r.reason);
    },
  };
  return api;
}
