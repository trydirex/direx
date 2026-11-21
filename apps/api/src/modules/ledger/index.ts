// SPDX-License-Identifier: AGPL-3.0-only
// The ledger module's only public entry point. Every external effect is a ledger
// Action, and nothing outside this module calls a provider.
import type { EffectCapability } from "@direx/plugin-sdk";
import type { PgBoss } from "pg-boss";
import { ensureQueue, sweepOverdue, workSweep, workWakes } from "./adapters/queue";
import { lifecycle } from "./application/actions";
import { dispatcher, type Check, type Resolver, type Step } from "./application/dispatcher";
import type { SigningKeys } from "./application/signing";
import { inWorkspace, markOperatorHoldsReleased, operatorHoldsToRelease, type LedgerTx } from "./adapters/ledger-repo";

export type { Actor, ActionRow, ActionState, EventRow, LedgerTx, Triage } from "./adapters/ledger-repo";
/** Reads Actions' live states without a lock, for modules that derive state from them. */
export { operatorHold, readActionStates as actionStates, isOwnProbe, isPlacementMessage, isPlacementSend, sentByCorrelation, sentTo } from "./adapters/ledger-repo";
export type { ApproverId, Refusal, Result } from "./application/actions";
export { APPROVAL_TTL_MS, approverIdFromSession } from "./application/actions";
export { utcMonth, withBudget, type BudgetKind, type BudgetScope } from "./adapters/budget-repo";
export { sendJobInTx } from "./adapters/queue";
export type { Check, Resolver, Step } from "./application/dispatcher";
export { KeysUnavailable, oneKey, specHash, type SigningKey, type SigningKeys, type WorkspaceKeys } from "./application/signing";
export type { SnapshotEntry } from "./domain/binding";
export type { CheckResult } from "./domain/check-result";
export { isLate, LATE_LIMIT_MS, type State } from "./domain/states";

export type LedgerDeps = {
  boss: PgBoss;
  signingKeys: SigningKeys;
  now?: () => Date;
  /** Live conditions other modules own, run at claim and again at dispatch. */
  checks?: Check[];
  /** Live version lookups for snapshot entries, by entry kind. */
  resolvers?: Record<string, Resolver>;
  /** Effect capabilities by capability id. */
  effects?: Record<string, EffectCapability>;
  executeTimeoutMs?: number;
  onStep?: (step: Step, actionId: string) => void | Promise<void>;
  onRuleStale?: (tx: LedgerTx, ruleId: string, kinds: readonly string[]) => Promise<void>;
  /** A provider refused a rule's send as over its sending limit or as abuse. Same transaction as the refusal. */
  onProviderLimit?: (tx: LedgerTx, ruleId: string, limit: "sending_limit" | "abuse") => Promise<void>;
  /** A provider refused an Action as over its sender's limit or as abuse, however it was approved. Same transaction. */
  onAccountLimit?: (tx: LedgerTx, action: { id: string; workspaceId: string; capability: string; credentialId: string | null }, limit: "sending_limit" | "abuse", detail: string | undefined) => Promise<void>;
  /** An Action was held because another root key wrapped its Workspace's data key. Same transaction. */
  onKeysLost?: (tx: LedgerTx, workspaceId: string) => Promise<void>;
  /** An Action became late, or a late one was resumed, moved, resent or cancelled. Same transaction. */
  onLateChanged?: (tx: LedgerTx, workspaceId: string) => Promise<void>;
  /** A check moved an Action later, keeping its approval. After that commits, outside a transaction. */
  onLater?: (workspaceId: string, actionId: string, at: Date) => Promise<void>;
};

export type Ledger = ReturnType<typeof createLedger>;

export function createLedger(deps: LedgerDeps) {
  const now = deps.now ?? (() => new Date());
  const resolvers = deps.resolvers ?? {};
  const d = dispatcher({
    boss: deps.boss,
    signingKeys: deps.signingKeys,
    now,
    checks: deps.checks ?? [],
    resolvers,
    effects: deps.effects ?? {},
    executeTimeoutMs: deps.executeTimeoutMs ?? 30_000,
    onStep: deps.onStep,
    onRuleStale: deps.onRuleStale,
    onProviderLimit: deps.onProviderLimit,
    onAccountLimit: deps.onAccountLimit,
    onKeysLost: deps.onKeysLost,
    onLateChanged: deps.onLateChanged,
    onLater: deps.onLater,
  });
  const life = lifecycle({ boss: deps.boss, signingKeys: deps.signingKeys, now, resolvers, onLateChanged: deps.onLateChanged });
  return {
    ...life,
    run: d.run,
    /**
     * What lifted operator holds held goes back to scheduled, where every check runs again. Run each
     * minute; after a crash the next run finds the same holds and resumes nothing twice.
     */
    async releaseOperatorHolds(): Promise<number> {
      const listed = await operatorHoldsToRelease();
      let resumed = 0;
      for (const ws of new Set(listed.flatMap((r) => (r.workspaceId ? [r.workspaceId] : [])))) {
        resumed += (await inWorkspace(ws, (tx) => life.resumeAllHeldIn(tx, ws, "operator_hold", { system: "operator_hold" }))).resumed;
      }
      if (listed.length) await markOperatorHoldsReleased([...new Set(listed.map((r) => r.holdId))]);
      return resumed;
    },
    ensureQueue: () => ensureQueue(deps.boss),
    /** Works ledger.dispatch jobs: each one runs the Dispatcher for its Action. */
    work: () => workWakes(deps.boss, (p) => d.run(p.workspaceId, p.actionId)),
    sweep: () => sweepOverdue(deps.boss),
    workSweep: () => workSweep(deps.boss),
  };
}
