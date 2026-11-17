// SPDX-License-Identifier: AGPL-3.0-only
// The Dispatcher: claim, dispatch check, provider call, settle. This is the only file
// that calls effect.execute or effect.reconcile, so nothing reaches a provider without
// a current claim.
//
// Lock order, for every transaction that takes more than one of these:
//   1. workspaces row, FOR NO KEY UPDATE, when reserving budget. Not built yet: waits
//      for the workspaces table.
//   2. Person group row, FOR NO KEY UPDATE, when reserving a Touch slot. Not built yet.
//   3. actions row, FOR UPDATE, compared on version.
//   4. approvals rows for that Action.
//   5. the items row showing that Action, when its details are written with it.
//   6. the module rows that say what the Action belongs to, such as a Campaign's link.
// No network or model call runs while any of them is held: execute and reconcile run
// between transactions.
//
// Each pass reads the row and does one step in its own transaction. The fence is the
// version committed with `dispatching`: settle writes only if the row still has it, so a
// result that arrives after recovery moved the Action changes nothing.
import type { EffectCapability, ExecuteResult, FollowUpResult, ReconcileResult } from "@direx/plugin-sdk";
import type { PgBoss } from "pg-boss";
import {
  inWorkspace,
  liveApproval,
  lockAction,
  readAction,
  transition,
  workspaceDeleted,
  type ActionRow,
  type Actor,
  type LedgerTx,
} from "../adapters/ledger-repo";
import { sendWake } from "../adapters/queue";
import { canonicalJson, changedEntries, type SnapshotEntry } from "../domain/binding";
import { combine, type CheckResult } from "../domain/check-result";
import { nextRetryAt } from "../domain/retry";
import { isLate } from "../domain/states";
import { APPROVAL_TTL_MS } from "./actions";
import { KeysUnavailable, specHash, verify, type SigningKeys, type WorkspaceKeys } from "./signing";

/**
 * A live condition another module owns: policy, consent, suppression, grant, pause.
 * `approval` is the live approval the Dispatcher has just verified.
 */
export type Check = (tx: LedgerTx, action: ActionRow, approval: { approverId: string; standingRuleId: string | null; producerDigest: string | null }) => Promise<CheckResult>;
/** Returns the live version of one snapshot entry, or null when it is gone. */
export type Resolver = (tx: LedgerTx, id: string) => Promise<string | null>;
export type Step = "claim" | "dispatch_check" | "execute";

export type DispatcherDeps = {
  boss: PgBoss;
  signingKeys: SigningKeys;
  now: () => Date;
  checks: Check[];
  resolvers: Record<string, Resolver>;
  effects: Record<string, EffectCapability>;
  /** A provider call that takes longer is an unknown outcome. 30 s by default. */
  executeTimeoutMs: number;
  /** A rule's approval no longer matches its snapshot; these kinds of entry moved. */
  onRuleStale?: ((tx: LedgerTx, ruleId: string, kinds: readonly string[]) => Promise<void>) | undefined;
  onProviderLimit?: ((tx: LedgerTx, ruleId: string, limit: "sending_limit" | "abuse") => Promise<void>) | undefined;
  /** The provider said this Action's sender is over a limit, however the Action was approved. */
  onAccountLimit?: ((tx: LedgerTx, action: ActionRow, limit: "sending_limit" | "abuse", detail: string | undefined) => Promise<void>) | undefined;
  /** An Action was held because another root key wrapped its Workspace's data key. Same transaction. */
  onKeysLost?: ((tx: LedgerTx, workspaceId: string) => Promise<void>) | undefined;
  /** An Action became late, or a late one moved on. Same transaction. */
  onLateChanged?: ((tx: LedgerTx, workspaceId: string) => Promise<void>) | undefined;
  /**
   * A check moved an Action later, keeping its approval. Runs after that commits, outside any
   * transaction, so the new time can be reserved; a crash before it leaves the claim to hold the
   * Action on the old reservations, which fails safe.
   */
  onLater?: ((workspaceId: string, actionId: string, at: Date) => Promise<void>) | undefined;
  /** Test seam: runs after a step commits. A throw here stands in for a crash. */
  onStep?: (step: Step, actionId: string) => void | Promise<void>;
};

const SYSTEM: Actor = { system: "dispatcher" };
/** How long past the execute timeout a `dispatching` row waits before recovery calls it unknown. */
const RECOVERY_GRACE_MS = 60_000;
const MAX_PASSES = 20;

type Pass = "again" | "done";

/** What a sent effect reports beyond its id, kept for the person; null when it reports nothing. */
const resultOf = (r: { url?: string; followUps?: FollowUpResult[] }) =>
  r.url || r.followUps ? { ...(r.url && { url: r.url }), ...(r.followUps && { followUps: r.followUps }) } : null;

export function dispatcher(deps: DispatcherDeps) {
  const hold = (reason: string, detail?: string): CheckResult => ({ kind: "hold", reason, detail });
  // Actions a check moved later in the pass now committing, for onLater once it has.
  const movedLater = new Map<string, Date>();

  // An effect may declare a longer wait; a row with no such effect uses the default.
  const timeoutOf = (capability: string) => deps.effects[capability]?.timeoutMs ?? deps.executeTimeoutMs;

  async function withTimeout<T>(p: Promise<T>, ms: number): Promise<T | "timeout"> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<"timeout">((r) => (timer = setTimeout(() => r("timeout"), ms)));
    try {
      return await Promise.race([p, timeout]);
    } finally {
      clearTimeout(timer);
    }
  }

  // Approval, signature, spec, snapshot and live checks, run at claim and again at
  // dispatch, inside the transaction that holds the row.
  async function verifyAll(tx: LedgerTx, row: ActionRow, keys: WorkspaceKeys): Promise<CheckResult> {
    const approval = await liveApproval(tx, row.id);
    if (!approval) return hold("approval_invalid", "no live approval");
    const snapshot = approval.snapshot as SnapshotEntry[];
    const binding = {
      actionId: row.id,
      draftVersion: approval.draftVersion,
      specHash: approval.specHash,
      snapshot,
      approverId: approval.approverId,
      approvedAt: approval.approvedAt.toISOString(),
      standingRuleId: approval.standingRuleId ?? undefined,
      producerDigest: approval.producerDigest ?? undefined,
    };
    const key = keys.byId(approval.keyId);
    if (!key || !verify(binding, approval.signature, key)) {
      return hold("approval_invalid", "signature does not verify");
    }
    if (
      approval.draftVersion !== row.draftVersion ||
      approval.specHash !== row.specHash ||
      specHash(row.spec) !== row.specHash
    ) {
      return hold("approval_invalid", "spec does not match the approval");
    }
    // A rule approved this without a person, so what changed goes back to one under its own reason.
    const stale = async (detail: string, kinds: string[]) => {
      if (!approval.standingRuleId) return hold("snapshot_changed", detail);
      await deps.onRuleStale?.(tx, approval.standingRuleId, kinds);
      return hold("rule_needs_review", `${kinds.join(", ")} changed`);
    };
    const effect = deps.effects[row.capability];
    if (!effect || effect.dedupe !== row.dedupeClass) {
      return stale(`capability ${row.capability} is missing or changed its dedupe class`, ["capability"]);
    }
    const live: (string | null)[] = [];
    for (const e of snapshot) live.push((await deps.resolvers[e.kind]?.(tx, e.id)) ?? null);
    const changed = changedEntries(snapshot, live);
    if (changed.length) return stale(changed.map((e) => `${e.kind}:${e.id}`).join(", "), [...new Set(changed.map((e) => e.kind))]);
    // An Action pointed at another credential after approval is not what was approved.
    const bound = snapshot.find((e) => e.kind === "credential")?.id ?? null;
    if (bound !== row.credentialId) return stale(`credential:${row.credentialId}`, ["credential"]);
    // After what the approval binds, so a change is said first; before other modules' checks, whose
    // own holds (a Touch slot long gone, say) would hide it. Read now, with the row held.
    const due = row.dueAt ?? approval.approvedAt;
    if (isLate(due, deps.now())) return hold("late", `due ${due.toISOString()}`);
    const results: CheckResult[] = [];
    for (const check of deps.checks) results.push(await check(tx, row, approval));
    return combine(results);
  }

  async function refuse(tx: LedgerTx, row: ActionRow, v: CheckResult, at: Date): Promise<Pass> {
    if (v.kind === "ok") throw new Error("refuse called with ok");
    // Later, not refused: the approval stands, the time moves on, and the wake comes then.
    if (v.kind === "later") {
      const next = await transition(tx, row, { state: "scheduled", reason: v.reason, detail: v.detail ?? `moved to ${v.at.toISOString()}`, set: { dueAt: v.at } }, SYSTEM, at);
      if (next !== "stale") {
        await sendWake(deps.boss, tx, { workspaceId: row.workspaceId, actionId: row.id }, v.at);
        movedLater.set(row.id, v.at);
      }
      return "done";
    }
    // A hold on a resend must not hide that the earlier call may have gone out.
    if (v.kind === "hold" && row.outcomeUnknownAt) {
      await transition(tx, row, { state: "held", reason: "outcome_unknown", detail: v.detail ? `${v.reason}: ${v.detail}` : v.reason, set: { nextAttemptAt: null } }, SYSTEM, at);
      return "done";
    }
    const late = v.kind === "hold" && v.reason === "late";
    // A late hold waits for a person, with no retry scheduled, so it shows in Needs you.
    await transition(tx, row, { state: v.kind === "block" ? "blocked" : "held", reason: v.reason, detail: v.detail, ...(late && { set: { nextAttemptAt: null } }) }, SYSTEM, at);
    if (late) await deps.onLateChanged?.(tx, row.workspaceId);
    return "done";
  }

  // Whether an unknown outcome may be retried without a person: queryable effects are
  // asked first, idempotent ones only inside the provider's key window, blind ones never.
  function autoRetry(row: ActionRow, at: Date): boolean {
    const effect = deps.effects[row.capability];
    if (row.dedupeClass === "queryable") return true;
    if (row.dedupeClass === "provider_idempotent" && effect?.dedupe === "provider_idempotent") {
      return !!row.firstDispatchedAt && row.firstDispatchedAt.getTime() + effect.keyWindowMs > at.getTime();
    }
    return false;
  }

  // Held with the next retry scheduled, or held for a person when retries are used up
  // or not allowed.
  async function holdWithRetry(
    tx: LedgerTx,
    row: ActionRow,
    reason: "outcome_unknown" | "provider_rejected" | "keys_unavailable",
    retry: boolean,
    at: Date,
    extra: { detail?: string; plan?: string | undefined; dispatchGapMs?: number } = {},
  ): Promise<void> {
    // Failing a resend says nothing about the earlier call, so the outcome stays unknown.
    if (reason !== "outcome_unknown" && row.outcomeUnknownAt) {
      reason = "outcome_unknown";
      retry = autoRetry(row, at);
    }
    const nextAt = retry ? nextRetryAt(row.retries, at) : null;
    const next = await transition(
      tx,
      row,
      {
        state: "held",
        reason,
        detail: extra.detail ?? (retry && !nextAt ? "retries used up" : undefined),
        ...(extra.plan && reason === "provider_rejected" && { plan: extra.plan }),
        dispatchGapMs: extra.dispatchGapMs,
        set: {
          nextAttemptAt: nextAt,
          retries: nextAt ? row.retries + 1 : row.retries,
          ...(reason === "outcome_unknown" && { outcomeUnknownAt: row.outcomeUnknownAt ?? at }),
        },
      },
      SYSTEM,
      at,
    );
    if (next !== "stale" && nextAt) await sendWake(deps.boss, tx, { workspaceId: row.workspaceId, actionId: row.id }, nextAt);
  }

  // Step 1.
  async function claim(tx: LedgerTx, row: ActionRow, at: Date, keys: WorkspaceKeys): Promise<Pass> {
    const v = await verifyAll(tx, row, keys);
    if (v.kind !== "ok") return refuse(tx, row, v, at);
    await transition(tx, row, { state: "claimed" }, SYSTEM, at);
    return "again";
  }

  // Step 2. Returns the committed `dispatching` row, the fence for settle.
  async function dispatchCheck(tx: LedgerTx, row: ActionRow, at: Date, keys: WorkspaceKeys): Promise<ActionRow | Pass> {
    const v = await verifyAll(tx, row, keys);
    if (v.kind !== "ok") return refuse(tx, row, v, at);
    const next = await transition(
      tx,
      row,
      { state: "dispatching", set: { dispatchStartedAt: at, firstDispatchedAt: row.firstDispatchedAt ?? at } },
      SYSTEM,
      at,
    );
    return next === "stale" ? "again" : next;
  }

  // Step 3, with no transaction open, then step 4.
  async function executeAndSettle(workspaceId: string, row: ActionRow, checkedAt: number): Promise<Pass> {
    const effect = deps.effects[row.capability]!;
    // The same bytes on every resend: keys in canonical order, whatever jsonb did.
    const spec = JSON.parse(canonicalJson(row.spec));
    const gapMs = Math.round(performance.now() - checkedAt);
    let outcome: ExecuteResult | "unknown";
    try {
      const r = await withTimeout(effect.execute(spec, { workspaceId, idempotencyKey: row.id, credentialId: row.credentialId }), timeoutOf(row.capability));
      outcome = r === "timeout" ? "unknown" : r;
    } catch {
      outcome = "unknown";
    }
    await deps.onStep?.("execute", row.id);
    await inWorkspace(workspaceId, async (tx) => {
      const at = deps.now();
      const cur = await lockAction(tx, row.id);
      if (!cur || cur.state !== "dispatching" || cur.version !== row.version) return; // recovery owns it
      if (outcome === "unknown") {
        return holdWithRetry(tx, cur, "outcome_unknown", autoRetry(cur, at), at, { dispatchGapMs: gapMs });
      }
      if (outcome.kind === "sent") {
        await transition(
          tx,
          cur,
          {
            state: "sent",
            dispatchGapMs: gapMs,
            set: { providerRef: outcome.providerRef ?? null, correlationKey: outcome.correlationKey ?? cur.id, result: resultOf(outcome), nextAttemptAt: null, outcomeUnknownAt: null },
          },
          SYSTEM,
          at,
        );
        return;
      }
      // Nobody read a rule's email, so the provider calling it too many or abuse stops the rule.
      if (outcome.providerLimit) {
        const ruleId = (await liveApproval(tx, cur.id))?.standingRuleId;
        if (ruleId) await deps.onProviderLimit?.(tx, ruleId, outcome.providerLimit);
        await deps.onAccountLimit?.(tx, cur, outcome.providerLimit, outcome.detail);
      }
      if (outcome.permanent && !cur.outcomeUnknownAt) {
        await transition(
          tx,
          cur,
          { state: "blocked", reason: "provider_refused_permanently", detail: outcome.detail, dispatchGapMs: gapMs },
          SYSTEM,
          at,
        );
        return;
      }
      return holdWithRetry(tx, cur, "provider_rejected", outcome.retryable, at, { detail: outcome.detail, plan: outcome.plan, dispatchGapMs: gapMs });
    });
    return "done";
  }

  // A `dispatching` row nobody settled: the worker stopped after the provider call may
  // have begun. Wait out the timeout, then it is an unknown outcome. The wake for the
  // deadline is sent again here, because the wake that brought us may be the last one.
  async function recover(tx: LedgerTx, row: ActionRow, at: Date): Promise<Pass> {
    const deadline = new Date(row.dispatchStartedAt!.getTime() + timeoutOf(row.capability) + RECOVERY_GRACE_MS);
    if (deadline > at) {
      await sendWake(deps.boss, tx, { workspaceId: row.workspaceId, actionId: row.id }, deadline);
      return "done";
    }
    await holdWithRetry(tx, row, "outcome_unknown", autoRetry(row, at), at, { detail: "worker stopped during dispatch" });
    return "done";
  }

  // A held Action whose retry is due: resend or retry through the dispatch check.
  async function retryHeld(tx: LedgerTx, row: ActionRow, at: Date): Promise<Pass> {
    if (!row.nextAttemptAt || row.nextAttemptAt > at) return "done";
    const retryable =
      row.holdReason === "provider_rejected" ||
      row.holdReason === "keys_unavailable" ||
      (row.holdReason === "outcome_unknown" && row.dedupeClass === "provider_idempotent");
    if (!retryable) return "done";
    // Nothing was dispatched, so the retry starts again at the claim and runs both checks.
    if (row.holdReason === "keys_unavailable") {
      await transition(tx, row, { state: "scheduled", set: { nextAttemptAt: null } }, SYSTEM, at);
      return "again";
    }
    if (row.holdReason === "outcome_unknown" && !autoRetry(row, at)) {
      await transition(
        tx,
        row,
        { state: "held", reason: "outcome_unknown", detail: "provider key window passed", set: { nextAttemptAt: null } },
        SYSTEM,
        at,
      );
      return "done";
    }
    await transition(tx, row, { state: "claimed", set: { nextAttemptAt: null } }, SYSTEM, at);
    return "again";
  }

  // queryable, unknown outcome, retry due: ask the provider with no lock held.
  async function reconcile(workspaceId: string, peek: ActionRow): Promise<Pass> {
    const effect = deps.effects[peek.capability];
    let res: ReconcileResult = { kind: "unknown" };
    if (effect?.dedupe === "queryable") {
      try {
        const r = await withTimeout(effect.reconcile(peek.correlationKey ?? peek.id, { workspaceId, idempotencyKey: peek.id, credentialId: peek.credentialId }, JSON.parse(canonicalJson(peek.spec))), timeoutOf(peek.capability));
        if (r !== "timeout") res = r;
      } catch {
        // stays unknown
      }
    }
    return inWorkspace(workspaceId, async (tx) => {
      const at = deps.now();
      const row = await lockAction(tx, peek.id);
      if (!row || row.version !== peek.version) return "again";
      if (res.kind === "sent") {
        await transition(
          tx,
          row,
          { state: "sent", detail: "confirmed by reconcile", set: { providerRef: res.providerRef ?? null, result: resultOf(res), nextAttemptAt: null, outcomeUnknownAt: null } },
          SYSTEM,
          at,
        );
        return "done";
      }
      if (res.kind === "not_sent") {
        await transition(tx, row, { state: "claimed", detail: "reconcile: not sent", set: { nextAttemptAt: null, outcomeUnknownAt: null } }, SYSTEM, at);
        return "again";
      }
      // Final: the provider said it never will (ADR 0025 rule 005), so it is Blocked, never tried again.
      if (res.kind === "refused") {
        await transition(tx, row, { state: "blocked", reason: "provider_refused_permanently", detail: res.detail, set: { nextAttemptAt: null } }, SYSTEM, at);
        return "done";
      }
      await holdWithRetry(tx, row, "outcome_unknown", effect?.dedupe === "queryable", at);
      return "done";
    });
  }

  // Keys that won't load hold a due Action, so the sweep stops waking it. Nothing has reached a
  // provider: the claim comes after the keys. A data key another root key wrapped can't recover
  // on its own, so it waits for a person; anything else gets the usual retries first.
  async function holdForKeys(workspaceId: string, actionId: string, e: unknown): Promise<Pass> {
    const permanent = e instanceof KeysUnavailable && e.permanent;
    const why = e instanceof Error ? e.message : String(e);
    await inWorkspace(workspaceId, async (tx) => {
      const at = deps.now();
      const row = await lockAction(tx, actionId);
      const due = row && ((row.state === "scheduled" && (!row.dueAt || row.dueAt <= at)) || row.state === "claimed");
      if (!row || !due) return;
      // A resend after an unknown outcome may already have gone out: it stays unknown, and a
      // permanent failure leaves it to a person instead of the resend schedule.
      if (row.outcomeUnknownAt && permanent) {
        await transition(tx, row, { state: "held", reason: "outcome_unknown", detail: why, set: { nextAttemptAt: null } }, SYSTEM, at);
      } else {
        const last = permanent || nextRetryAt(row.retries, at) === null;
        await holdWithRetry(tx, row, "keys_unavailable", !permanent, at, { detail: !permanent && last ? `retries used up: ${why}` : why });
      }
      // Only whoever runs this Direx can fix it, so the Workspace is told once, not per Action.
      if (permanent) await deps.onKeysLost?.(tx, workspaceId);
    });
    return "done";
  }

  // Work this pass would do now: a claim, a dispatch, or a retry that is due.
  const dueWork = (row: ActionRow, at: Date) =>
    (row.state === "scheduled" && (!row.dueAt || row.dueAt <= at)) ||
    row.state === "claimed" ||
    (row.state === "held" && !!row.nextAttemptAt && row.nextAttemptAt <= at);

  // ADR 0030 rule 007: an Owner deleted the Workspace, so its due Actions are blocked, which is final,
  // before any key is fetched or any plugin is called. Nothing restores a deleted Workspace, and a
  // final state lets the purge go ahead. A resend after an unknown outcome may already have gone out,
  // so it stays held as unknown, says why it stopped, and keeps the purge waiting for a person.
  async function stopForDeletion(workspaceId: string, actionId: string): Promise<Pass> {
    await inWorkspace(workspaceId, async (tx) => {
      const at = deps.now();
      const row = await lockAction(tx, actionId);
      if (!row || !dueWork(row, at)) return;
      const unknown = row.outcomeUnknownAt !== null;
      await transition(
        tx,
        row,
        unknown
          ? { state: "held", reason: "outcome_unknown", detail: "workspace_deleted", set: { nextAttemptAt: null } }
          : { state: "blocked", reason: "workspace_deleted", set: { nextAttemptAt: null } },
        SYSTEM,
        at,
      );
    });
    return "done";
  }

  async function pass(workspaceId: string, actionId: string): Promise<Pass> {
    const { peek, deleted } = await inWorkspace(workspaceId, async (tx) => ({ peek: await readAction(tx, actionId), deleted: await workspaceDeleted(tx) }));
    // Gone, or another workspace's id: the job is done and never retried another way.
    if (!peek) return "done";
    const at = deps.now();
    if (deleted && dueWork(peek, at)) return stopForDeletion(workspaceId, actionId);
    if (
      peek.state === "held" &&
      peek.holdReason === "outcome_unknown" &&
      peek.dedupeClass === "queryable" &&
      peek.nextAttemptAt &&
      peek.nextAttemptAt <= at
    ) {
      return reconcile(workspaceId, peek);
    }

    // Before the lock: fetching keys may reach a key service. Only the claim and the dispatch
    // check verify an approval, so recovery and expiry still run when the keys won't load.
    let keys: WorkspaceKeys | null = null;
    if (peek.state === "scheduled" || peek.state === "claimed") {
      try {
        keys = await deps.signingKeys(workspaceId);
      } catch (e) {
        return holdForKeys(workspaceId, actionId, e);
      }
    }
    const r = await inWorkspace(workspaceId, async (tx): Promise<Pass | { claimed: true } | { execute: ActionRow }> => {
      const row = await lockAction(tx, actionId);
      if (!row) return "done";
      // It moved since the peek into a state that needs keys: the next pass loads them.
      if (!keys && (row.state === "scheduled" || row.state === "claimed")) return "again";
      switch (row.state) {
        case "needs_approval":
          if (row.approvalRequestedAt && at.getTime() - row.approvalRequestedAt.getTime() >= APPROVAL_TTL_MS) {
            await transition(tx, row, { state: "held", reason: "approval_expired" }, SYSTEM, at);
          }
          return "done";
        case "scheduled":
          if (row.dueAt && row.dueAt > at) return "done";
          return (await claim(tx, row, at, keys!)) === "again" ? { claimed: true } : "done";
        case "claimed": {
          const next = await dispatchCheck(tx, row, at, keys!);
          return typeof next === "string" ? next : { execute: next };
        }
        case "dispatching":
          return recover(tx, row, at);
        case "held":
          return retryHeld(tx, row, at);
        default:
          return "done";
      }
    });

    const later = movedLater.get(actionId);
    if (later) {
      movedLater.delete(actionId);
      await deps.onLater?.(workspaceId, actionId, later);
    }
    if (typeof r === "string") return r;
    if ("claimed" in r) {
      await deps.onStep?.("claim", actionId);
      return "again";
    }
    const checkedAt = performance.now();
    await deps.onStep?.("dispatch_check", actionId);
    return executeAndSettle(workspaceId, r.execute, checkedAt);
  }

  return {
    /** Drives one Action as far as it can go now. Safe to call any number of times. */
    async run(workspaceId: string, actionId: string): Promise<void> {
      for (let i = 0; i < MAX_PASSES; i++) {
        if ((await pass(workspaceId, actionId)) === "done") return;
      }
      throw new Error(`dispatcher: action ${actionId} did not settle in ${MAX_PASSES} passes`);
    },
  };
}
