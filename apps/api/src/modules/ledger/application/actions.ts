// SPDX-License-Identifier: AGPL-3.0-only
// The Action lifecycle outside dispatch: create, submit, approve, revise, cancel, resume.
// Every change locks the row and goes through ledger-repo's transition; refusals come
// back as values.
import type { DedupeClass } from "@direx/plugin-sdk";
import type { PgBoss } from "pg-boss";
import {
  activeRuleGranter,
  heldFor,
  heldForMailboxPause,
  heldIdsFor,
  idsInStates,
  lateCounts,
  lateEmails,
  heldOnCredential,
  onCredentialIn,
  inWorkspace,
  insertAction,
  insertApproval,
  listEvents,
  lockAction,
  readAction,
  transition,
  updateTriage,
  voidLiveApproval,
  type ActionRow,
  type Actor,
  type LedgerTx,
  type Triage,
} from "../adapters/ledger-repo";
import { sendWake } from "../adapters/queue";
import type { SnapshotEntry } from "../domain/binding";
import { isLate } from "../domain/states";
import { sign, specHash, type SigningKeys } from "./signing";

/** Pending approvals expire after 14 days by default; the row is kept. */
export const APPROVAL_TTL_MS = 14 * 24 * 60 * 60 * 1000;

declare const approverBrand: unique symbol;
/** A user id read from the server session, never from the request body. */
export type ApproverId = string & { readonly [approverBrand]: true };
/** Only the ledger and identity may call this outside tests; approver-check.test.ts checks it. */
export const approverIdFromSession = (userId: string) => userId as ApproverId;

export type Refusal =
  | "not_found"
  | "stale"
  | "wrong_state"
  | "draft_version_moved"
  | "outcome_unknown"
  | "credential_unavailable"
  | "rule_not_active"
  | "not_later"
  | "too_late"
  | "late_needs_time";
export type Result = { ok: true; action: ActionRow } | { ok: false; reason: Refusal };

export type LifecycleDeps = {
  boss: PgBoss;
  signingKeys: SigningKeys;
  now: () => Date;
  /** The Dispatcher's live version lookups; approve binds the Action's credential with "credential". */
  resolvers: Record<string, (tx: LedgerTx, id: string) => Promise<string | null>>;
  /** A late Action was resumed, moved, resent or cancelled. Same transaction. */
  onLateChanged?: ((tx: LedgerTx, workspaceId: string) => Promise<void>) | undefined;
};

const EDITABLE = ["draft", "needs_approval", "scheduled", "claimed", "held"];
/** These holds name something the old approval can't vouch for, so a person has to approve again. */
const NEEDS_NEW_APPROVAL = ["snapshot_changed", "rule_needs_review"];

export function lifecycle({ boss, signingKeys, now, resolvers, onLateChanged }: LifecycleDeps) {
  // Locks the row, lets fn decide, and maps a lost version race to "stale".
  async function changeIn(tx: LedgerTx, actionId: string, fn: (tx: LedgerTx, row: ActionRow, at: Date) => Promise<Result | ActionRow | "stale">): Promise<Result> {
    const at = now();
    const row = await lockAction(tx, actionId);
    if (!row) return { ok: false, reason: "not_found" } as const;
    const r = await fn(tx, row, at);
    if (r === "stale") return { ok: false, reason: "stale" } as const;
    if (row.state === "held" && row.holdReason === "late" && !("ok" in r && !r.ok)) await onLateChanged?.(tx, row.workspaceId);
    return "ok" in r ? r : { ok: true, action: r };
  }
  const change = (workspaceId: string, actionId: string, fn: Parameters<typeof changeIn>[2]) => inWorkspace(workspaceId, (tx) => changeIn(tx, actionId, fn));

  const expiryWake = (tx: LedgerTx, workspaceId: string, actionId: string, at: Date) =>
    sendWake(boss, tx, { workspaceId, actionId }, new Date(at.getTime() + APPROVAL_TTL_MS));

  // An unknown outcome may already have happened: nothing may replace or hide it until
  // its dedupe class or a person resolves it.
  const unknown = (row: ActionRow) => row.state === "held" && row.holdReason === "outcome_unknown";
  // The same, for a row on its way to a resend: it stays settled-only until the call is known.
  const mayHaveSent = (row: ActionRow) => unknown(row) || (row.state === "claimed" && row.outcomeUnknownAt !== null);

  type Signer = { approverId: string; standingRuleId?: string; producerDigest?: string; actor: Actor };

  async function bindApproval(
    workspaceId: string,
    actionId: string,
    a: { draftVersion: number; snapshot: SnapshotEntry[]; dueAt?: Date },
    signer: (tx: LedgerTx) => Promise<Signer | null>,
  ) {
    const { current: signingKey } = await signingKeys(workspaceId);
    return change(workspaceId, actionId, async (tx, row, at) => {
      if (row.state !== "needs_approval") return { ok: false, reason: "wrong_state" };
      // The approver saw this draft version; a newer one needs its own approval.
      if (row.draftVersion !== a.draftVersion) return { ok: false, reason: "draft_version_moved" };
      const who = await signer(tx);
      if (!who) return { ok: false, reason: "rule_not_active" };
      // Approving a time already more than a day gone would hold it as late at once.
      if (a.dueAt && isLate(a.dueAt, at)) return { ok: false, reason: "too_late" };
      // The approval names which account sends, never its value.
      let snapshot = a.snapshot;
      if (row.credentialId) {
        const label = await resolvers.credential?.(tx, row.credentialId);
        if (!label) return { ok: false, reason: "credential_unavailable" };
        snapshot = [...snapshot, { kind: "credential", id: row.credentialId, version: label }];
      }
      const binding = {
        actionId,
        draftVersion: row.draftVersion,
        specHash: row.specHash,
        snapshot,
        approverId: who.approverId,
        approvedAt: at.toISOString(),
        standingRuleId: who.standingRuleId,
        producerDigest: who.producerDigest,
      };
      await insertApproval(tx, {
        workspaceId,
        actionId,
        draftVersion: row.draftVersion,
        specHash: row.specHash,
        snapshot,
        approverId: who.approverId,
        approvedAt: at,
        keyId: signingKey.id,
        signature: sign(binding, signingKey),
        standingRuleId: who.standingRuleId ?? null,
        producerDigest: who.producerDigest ?? null,
      });
      const dueAt = a.dueAt ?? at;
      const next = await transition(tx, row, { state: "scheduled", set: { dueAt } }, who.actor, at);
      if (next !== "stale") await sendWake(boss, tx, { workspaceId, actionId }, dueAt);
      return next;
    });
  }

  type NewAction = { idempotencyKey: string; capability: string; dedupe: DedupeClass; spec: unknown; actor: Actor; credentialId?: string | null };
  async function createActionIn(tx: LedgerTx, workspaceId: string, a: NewAction): Promise<{ action: ActionRow; created: boolean }> {
    const { row, created } = await insertAction(
      tx,
      workspaceId,
      { idempotencyKey: a.idempotencyKey, capability: a.capability, dedupeClass: a.dedupe, spec: a.spec, specHash: specHash(a.spec), credentialId: a.credentialId ?? null },
      a.actor,
      now(),
    );
    return { action: row, created };
  }

  function submitForApprovalIn(tx: LedgerTx, workspaceId: string, actionId: string, actor: Actor) {
    return changeIn(tx, actionId, async (tx, row, at) => {
      if (row.state !== "draft") return { ok: false, reason: "wrong_state" };
      const next = await transition(tx, row, { state: "needs_approval", set: { approvalRequestedAt: at } }, actor, at);
      if (next !== "stale") await expiryWake(tx, workspaceId, actionId, at);
      return next;
    });
  }

  /**
   * A new spec voids the approval and needs a new one, under the same Action id, so a
   * re-approved draft can never go out twice. A draft stays a draft.
   */
  function reviseActionIn(tx: LedgerTx, workspaceId: string, actionId: string, a: { spec: unknown; actor: Actor }) {
    return changeIn(tx, actionId, async (tx, row, at) => {
      if (mayHaveSent(row)) return { ok: false, reason: "outcome_unknown" };
      if (!EDITABLE.includes(row.state)) return { ok: false, reason: "wrong_state" };
      await voidLiveApproval(tx, actionId, at);
      const isDraft = row.state === "draft";
      const set = {
        spec: a.spec,
        specHash: specHash(a.spec),
        draftVersion: row.draftVersion + 1,
        retries: 0,
        nextAttemptAt: null,
        approvalRequestedAt: isDraft ? null : at,
      };
      const next = await transition(tx, row, { state: isDraft ? "draft" : "needs_approval", set }, a.actor, at);
      if (next !== "stale" && !isDraft) await expiryWake(tx, workspaceId, actionId, at);
      return next;
    });
  }

  /**
   * A held Action back to Scheduled, or to Needs approval when its approval no longer stands. dueAt
   * moves the slot; heldFor resumes it only while it is still held for that reason.
   */
  function resumeIn(tx: LedgerTx, workspaceId: string, actionId: string, actor: Actor, opts: { dueAt?: Date; heldFor?: string } = {}) {
    return changeIn(tx, actionId, async (tx, row, at) => {
      if (row.state !== "held" || (opts.heldFor && row.holdReason !== opts.heldFor)) return { ok: false, reason: "wrong_state" };
      if (unknown(row)) return { ok: false, reason: "outcome_unknown" };
      // Only a person sends it late, and only at a time they reserved: going back to its old time would hold it again.
      if (row.holdReason === "late" && !opts.dueAt) return { ok: false, reason: "late_needs_time" };
      if (row.holdReason === "approval_expired") {
        const next = await transition(tx, row, { state: "needs_approval", set: { approvalRequestedAt: at } }, actor, at);
        if (next !== "stale") await expiryWake(tx, workspaceId, actionId, at);
        return next;
      }
      if (NEEDS_NEW_APPROVAL.includes(row.holdReason!)) {
        await voidLiveApproval(tx, actionId, at);
        const next = await transition(tx, row, { state: "needs_approval", set: { dueAt: null, approvalRequestedAt: at, retries: 0, nextAttemptAt: null } }, actor, at);
        if (next !== "stale") await expiryWake(tx, workspaceId, actionId, at);
        return next;
      }
      const set = { retries: 0, nextAttemptAt: null, ...(opts.dueAt && { dueAt: opts.dueAt }) };
      const next = await transition(tx, row, { state: "scheduled", set }, actor, at);
      if (next !== "stale") await sendWake(boss, tx, { workspaceId, actionId }, opts.dueAt && opts.dueAt > at ? opts.dueAt : at);
      return next;
    });
  }

  const api = {
    createAction: (workspaceId: string, a: NewAction) => inWorkspace(workspaceId, (tx) => createActionIn(tx, workspaceId, a)),
    /** The same, in the caller's transaction, so the Action and what it belongs to commit together. */
    createActionIn,

    submitForApproval: (workspaceId: string, actionId: string, actor: Actor) => inWorkspace(workspaceId, (tx) => submitForApprovalIn(tx, workspaceId, actionId, actor)),
    submitForApprovalIn,

    /** Binds and signs the approval to this exact spec and snapshot, then schedules the Action. */
    approve(
      workspaceId: string,
      actionId: string,
      a: { approverId: ApproverId; draftVersion: number; snapshot: SnapshotEntry[]; dueAt?: Date },
    ) {
      return bindApproval(workspaceId, actionId, a, async () => ({ approverId: a.approverId, actor: { userId: a.approverId } }));
    },

    /** The same approval made by a standing rule: signed with the rule's id, in the name of its granter. */
    approveByRule(workspaceId: string, actionId: string, a: { ruleId: string; draftVersion: number; snapshot: SnapshotEntry[]; dueAt?: Date; producerDigest?: string }) {
      return bindApproval(workspaceId, actionId, a, async (tx) => {
        const approverId = await activeRuleGranter(tx, a.ruleId);
        return approverId ? { approverId, standingRuleId: a.ruleId, ...(a.producerDigest ? { producerDigest: a.producerDigest } : {}), actor: { system: "standing_rule" } } : null;
      });
    },

    reviseAction: (workspaceId: string, actionId: string, a: { spec: unknown; actor: Actor }) => inWorkspace(workspaceId, (tx) => reviseActionIn(tx, workspaceId, actionId, a)),
    reviseActionIn,

    cancel(workspaceId: string, actionId: string, actor: Actor) {
      return change(workspaceId, actionId, async (tx, row, at) => {
        if (mayHaveSent(row)) return { ok: false, reason: "outcome_unknown" };
        if (!EDITABLE.includes(row.state)) return { ok: false, reason: "wrong_state" };
        return transition(tx, row, { state: "cancelled" }, actor, at);
      });
    },

    /**
     * Every Action on this credential that `match` names and that hasn't gone out, cancelled in the
     * caller's transaction. One that may already have gone out stays for its dedupe class to settle.
     */
    async cancelPendingIn(tx: LedgerTx, credentialId: string, actor: Actor, match: (capability: string) => boolean): Promise<number> {
      let cancelled = 0;
      for (const open of await onCredentialIn(tx, credentialId, EDITABLE)) {
        if (!match(open.capability)) continue;
        const r = await changeIn(tx, open.id, async (tx, row, at) => (mayHaveSent(row) || !EDITABLE.includes(row.state) ? { ok: false, reason: "wrong_state" } : transition(tx, row, { state: "cancelled" }, actor, at)));
        if (r.ok) cancelled++;
      }
      return cancelled;
    },

    /**
     * These Actions, those that haven't gone out, cancelled in the caller's transaction, by the same
     * rule as cancelPendingIn. For a module that knows its own Actions, such as a source's write-backs.
     */
    async cancelPendingByIds(tx: LedgerTx, ids: readonly string[], actor: Actor): Promise<number> {
      let cancelled = 0;
      for (const id of ids) {
        const r = await changeIn(tx, id, async (tx, row, at) => (mayHaveSent(row) || !EDITABLE.includes(row.state) ? { ok: false, reason: "wrong_state" } : transition(tx, row, { state: "cancelled" }, actor, at)));
        if (r.ok) cancelled++;
      }
      return cancelled;
    },

    /**
     * A deleted Workspace's Actions that cannot have reached anyone, cancelled in the caller's
     * transaction as workspace_deleted, so nothing no one can reach any more keeps its purge waiting.
     * Draft, Needs approval, Scheduled, claimed and held go. One that may already have gone out (an
     * unknown outcome, or a resend of one) stays for a person, and dispatching is never cancelled.
     * Running it again finds nothing more.
     */
    async cancelForDeletionIn(tx: LedgerTx): Promise<number> {
      let cancelled = 0;
      for (const { id } of await idsInStates(tx, EDITABLE)) {
        const r = await changeIn(tx, id, async (tx, row, at) =>
          unknown(row) || row.outcomeUnknownAt !== null || !EDITABLE.includes(row.state)
            ? { ok: false, reason: "wrong_state" }
            : transition(tx, row, { state: "cancelled", reason: "workspace_deleted" }, { system: "ledger" }, at),
        );
        if (r.ok) cancelled++;
      }
      return cancelled;
    },

    /** For the Workspace's late notice: what is late, and the late emails it may resume together. */
    lateCountsIn: (tx: LedgerTx) => lateCounts(tx),
    lateEmailsIn: (tx: LedgerTx) => lateEmails(tx),
    resumeIn,

    /** A person resumes a held Action once its reason cleared. Every check runs again at claim. */
    resume: (workspaceId: string, actionId: string, actor: Actor, opts: { dueAt?: Date; heldFor?: string } = {}) => inWorkspace(workspaceId, (tx) => resumeIn(tx, workspaceId, actionId, actor, opts)),

    /**
     * Every Action held for `reason`, resumed in the caller's transaction, each through the same path
     * as one. `skip` leaves an Action held, for one the caller can't vouch for in bulk.
     */
    async resumeAllHeldIn(tx: LedgerTx, workspaceId: string, reason: string, actor: Actor, skip: (capability: string) => boolean = () => false) {
      const tally = { resumed: 0, skipped: 0, failed: 0 };
      for (const held of await heldIdsFor(tx, reason)) {
        if (skip(held.capability)) tally.skipped++;
        else if ((await resumeIn(tx, workspaceId, held.id, actor, { heldFor: reason })).ok) tally.resumed++;
        else tally.failed++;
      }
      return tally;
    },

    /**
     * A move to a new time. The person approved a time as well as a draft, so an approved
     * Action needs approving again, under the same id. The caller reserves the new slot
     * first. The wake for the old time then finds nothing due.
     */
    moveAction(workspaceId: string, actionId: string, actor: Actor) {
      return change(workspaceId, actionId, async (tx, row, at) => {
        if (mayHaveSent(row)) return { ok: false, reason: "outcome_unknown" };
        if (!["scheduled", "claimed", "held"].includes(row.state)) return { ok: false, reason: "wrong_state" };
        await voidLiveApproval(tx, actionId, at);
        const set = { dueAt: null, approvalRequestedAt: at, retries: 0, nextAttemptAt: null };
        const next = await transition(tx, row, { state: "needs_approval", set }, actor, at);
        if (next !== "stale") await expiryWake(tx, workspaceId, actionId, at);
        return next;
      });
    },

    /**
     * A launch moved later. The approval binds the draft and what it touches, not the time, and
     * a later send gives the person more time, not less, so it stands. Never earlier: that goes
     * through moveAction and a new approval. A held Action keeps its hold and gets the new time
     * for when it resumes. The caller reserves the new slot first.
     */
    redateAction(workspaceId: string, actionId: string, dueAt: Date, actor: Actor) {
      return change(workspaceId, actionId, async (tx, row, at) => {
        if (mayHaveSent(row)) return { ok: false, reason: "outcome_unknown" };
        if (row.state !== "scheduled" && row.state !== "held") return { ok: false, reason: "wrong_state" };
        if (dueAt <= at || (row.dueAt && dueAt <= row.dueAt)) return { ok: false, reason: "not_later" };
        // Any hold stays, a late one included: a Campaign's launch can move with no person choosing.
        if (row.state === "held") return transition(tx, row, { state: "held", reason: row.holdReason!, ...(row.reasonDetail && { detail: row.reasonDetail }), ...(row.reasonPlan && { plan: row.reasonPlan }), set: { dueAt } }, actor, at);
        const next = await transition(tx, row, { state: "scheduled", set: { dueAt } }, actor, at);
        if (next !== "stale") await sendWake(boss, tx, { workspaceId, actionId }, dueAt);
        return next;
      });
    },

    /** Sorting and hiding only: it can't affect what goes out, so it leaves the claim token alone. */
    setTriage(workspaceId: string, actionId: string, triage: Triage) {
      return inWorkspace(workspaceId, (tx) => updateTriage(tx, actionId, triage));
    },
    setTriageIn: (tx: LedgerTx, actionId: string, triage: Triage) => updateTriage(tx, actionId, triage),

    /**
     * A person settles an unknown outcome: "mark_sent" records that it went out;
     * "resend" accepts the risk of a duplicate and dispatches again, through every check.
     */
    resolveUnknown(workspaceId: string, actionId: string, choice: "mark_sent" | "resend", userId: string, opts: { dueAt?: Date } = {}) {
      return change(workspaceId, actionId, async (tx, row, at) => {
        if (!unknown(row)) return { ok: false, reason: "wrong_state" };
        const actor = { userId };
        if (choice === "mark_sent") {
          return transition(tx, row, { state: "sent", detail: "marked sent by a person", set: { nextAttemptAt: null, outcomeUnknownAt: null } }, actor, at);
        }
        // A late resend goes out at a time the person reserved, or the dispatch check holds it again.
        if (row.dueAt && isLate(row.dueAt, at) && !opts.dueAt) return { ok: false, reason: "late_needs_time" };
        const next = await transition(
          tx,
          row,
          { state: "claimed", detail: "resend accepted with duplicate risk", set: { nextAttemptAt: null, ...(opts.dueAt && { dueAt: opts.dueAt }) } },
          actor,
          at,
        );
        if (next !== "stale") await sendWake(boss, tx, { workspaceId, actionId }, at);
        return next;
      });
    },

    /**
     * Gives up on an unknown outcome without a person: cancelled, never resent, and the record says it
     * may have gone out. Only for effects whose owner accepts that, such as a Placement check.
     */
    cancelUnknown(workspaceId: string, actionId: string, actor: Actor) {
      return change(workspaceId, actionId, async (tx, row, at) => {
        if (!unknown(row)) return { ok: false, reason: "wrong_state" };
        return transition(tx, row, { state: "cancelled", detail: "outcome unknown, cancelled without a resend: it may have gone out", set: { nextAttemptAt: null } }, actor, at);
      });
    },

    /** Each entry's live version, null once it is gone. */
    liveVersions(workspaceId: string, entries: readonly SnapshotEntry[]) {
      return inWorkspace(workspaceId, async (tx) => {
        const live: (string | null)[] = [];
        for (const e of entries) live.push((await resolvers[e.kind]?.(tx, e.id)) ?? null);
        return live;
      });
    },

    getAction(workspaceId: string, actionId: string) {
      return inWorkspace(workspaceId, (tx) => readAction(tx, actionId));
    },

    getEvents(workspaceId: string, actionId: string) {
      return inWorkspace(workspaceId, (tx) => listEvents(tx, actionId));
    },

    /**
     * A reconnected or rotated credential: its held Actions go back to scheduled, where
     * every check runs again. Returns how many moved.
     */
    async resumeHeld(workspaceId: string, credentialId: string): Promise<number> {
      const ids = await inWorkspace(workspaceId, (tx) => heldOnCredential(tx, credentialId));
      let moved = 0;
      for (const id of ids) if ((await api.resume(workspaceId, id, { system: "credentials" }, { heldFor: "credential_unavailable" })).ok) moved++;
      return moved;
    },

    /** The Actions held for this reason, each with the spec it was approved with. */
    heldBy: (workspaceId: string, reason: string) => inWorkspace(workspaceId, (tx) => heldFor(tx, reason)),

    /** Release this Mailbox's pause, including effects that have no Touch. */
    async resumeMailboxPaused(workspaceId: string, credentialId: string, actor: Actor): Promise<number> {
      const held = await inWorkspace(workspaceId, (tx) => heldForMailboxPause(tx, credentialId));
      let moved = 0;
      for (const { id } of held) if ((await api.resume(workspaceId, id, actor, { heldFor: "mailbox_paused" })).ok) moved++;
      return moved;
    },

    /** Held Actions a condition no longer stops go back to scheduled, where every check runs again. */
    async resumeHeldBy(workspaceId: string, reason: string, actor: Actor, reaches: (tx: LedgerTx, held: { personId: string; credentialId: string | null }) => Promise<boolean>): Promise<number> {
      const ids = await inWorkspace(workspaceId, async (tx) => {
        const matched: string[] = [];
        for (const held of await heldFor(tx, reason)) if (await reaches(tx, held)) matched.push(held.id);
        return matched;
      });
      let moved = 0;
      for (const id of ids) if ((await api.resume(workspaceId, id, actor, { heldFor: reason })).ok) moved++;
      return moved;
    },
  };
  return api;
}
