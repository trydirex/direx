// SPDX-License-Identifier: AGPL-3.0-only
// Test support for the ledger: a started pg-boss and a ledger with a test key, and fake
// effects, one per dedupe class. Each fake call takes the next scripted step; once the
// script runs out, the last step repeats.
import type { DedupeClass, EffectCapability, ExecuteResult, ReconcileResult } from "@direx/plugin-sdk";
import { afterAll } from "vitest";
import { createBoss } from "../../jobs/boss";
import { approverIdFromSession, createLedger, oneKey, type LedgerDeps, type SnapshotEntry } from "./index";

export const testKey = { id: "test", secret: "t".repeat(32) };
export const approver = approverIdFromSession("00000000-0000-4000-8000-000000000001");
export const person = { userId: approver as string };

/** A started pg-boss for this test file, stopped after it, and a clock tests can move. */
export async function testLedger(extra: Partial<LedgerDeps> = {}) {
  const boss = createBoss();
  // The test database is dropped at teardown while the queue may still poll it once; anything else still fails.
  boss.on("error", (e) => {
    if ((e as { code?: string }).code !== "3D000") throw e;
  });
  await boss.start();
  afterAll(() => boss.stop({ graceful: false, close: true }));
  const clock = { at: new Date("2026-11-02T09:00:00Z") };
  const ledger = createLedger({ boss, signingKeys: oneKey(testKey), now: () => clock.at, ...extra });
  await ledger.ensureQueue();
  /** Wake jobs queued for one Action, oldest first. */
  const wakes = async (actionId: string) =>
    (await boss.findJobs<{ actionId: string }>("ledger.dispatch", { data: { actionId } })).map((j) => j.startAfter);
  return { boss, clock, ledger, wakes };
}

/** Creates, submits and approves an Action, so the next run claims it. */
export async function scheduledAction(
  ledger: ReturnType<typeof createLedger>,
  workspaceId: string,
  capability: string,
  dedupe: DedupeClass,
  opts: { spec?: unknown; snapshot?: SnapshotEntry[] } = {},
): Promise<string> {
  const spec = opts.spec ?? { to: "dana@example.com", body: `hello ${capability}` };
  const { action } = await ledger.createAction(workspaceId, {
    idempotencyKey: crypto.randomUUID(),
    capability,
    dedupe,
    spec,
    actor: person,
  });
  await ledger.submitForApproval(workspaceId, action.id, person);
  const r = await ledger.approve(workspaceId, action.id, { approverId: approver, draftVersion: 1, snapshot: opts.snapshot ?? [] });
  if (!r.ok) throw new Error(`approve: ${r.reason}`);
  return action.id;
}

export type FakeStep =
  | "sent"
  /** Sent, with a link and one follow-up that may have posted. */
  | "sent_with_result"
  | "refused_permanent"
  | "refused_retryable"
  | "throw"
  /** Never settles: stands in for a provider call that times out or a dropped connection. */
  | "hang"
  /** Calls onStart, then waits for release() before answering "sent". */
  | "block";

export type FakeEffect = {
  capability: EffectCapability;
  calls: { spec: unknown; idempotencyKey: string }[];
  reconciles: string[];
  /** The spec each reconcile was given (ADR 0025 rule 005). */
  reconcileSpecs: unknown[];
  release: () => void;
};

export function fakeEffect(
  dedupe: DedupeClass,
  opts: {
    steps?: FakeStep[];
    reconcile?: ReconcileResult["kind"][];
    onStart?: () => void;
    reachesPerson?: boolean;
    timeoutMs?: number;
  } = {},
): FakeEffect {
  const steps = opts.steps ?? ["sent"];
  const reachesPerson = opts.reachesPerson ?? false;
  const reconcileSteps = opts.reconcile ?? ["unknown"];
  const gate = Promise.withResolvers<void>();
  const calls: FakeEffect["calls"] = [];
  const reconciles: string[] = [];
  const reconcileSpecs: unknown[] = [];

  const execute = async (spec: unknown, ctx: { idempotencyKey: string }): Promise<ExecuteResult> => {
    calls.push({ spec, idempotencyKey: ctx.idempotencyKey });
    const step = steps[Math.min(calls.length, steps.length) - 1]!;
    switch (step) {
      case "sent":
        return { kind: "sent", providerRef: `ref-${calls.length}`, correlationKey: ctx.idempotencyKey };
      case "sent_with_result":
        return { kind: "sent", url: "https://example.com/p/1", followUps: [{ status: "uncertain" }] };
      case "refused_permanent":
        return { kind: "refused", permanent: true, retryable: false, detail: "hard bounce" };
      case "refused_retryable":
        return { kind: "refused", permanent: false, retryable: true, detail: "rate limited" };
      case "throw":
        throw new Error("connection reset");
      case "hang":
        return new Promise<never>(() => {});
      case "block":
        opts.onStart?.();
        await gate.promise;
        return { kind: "sent", providerRef: `ref-${calls.length}`, correlationKey: ctx.idempotencyKey };
    }
  };

  const reconcile = async (correlationKey: string, _ctx: unknown, spec?: unknown): Promise<ReconcileResult> => {
    reconciles.push(correlationKey);
    reconcileSpecs.push(spec);
    const kind = reconcileSteps[Math.min(reconciles.length, reconcileSteps.length) - 1]!;
    if (kind === "refused") return { kind, detail: "access removed" };
    return kind === "sent" ? { kind, providerRef: "reconciled", url: "https://example.com/p/reconciled" } : { kind };
  };

  const capability: EffectCapability =
    dedupe === "queryable"
      ? { dedupe, execute, reconcile, reachesPerson }
      : dedupe === "provider_idempotent"
        ? { dedupe, execute, keyWindowMs: 24 * 60 * 60 * 1000, reachesPerson }
        : { dedupe, execute, reachesPerson };

  if (opts.timeoutMs) capability.timeoutMs = opts.timeoutMs;

  return { capability, calls, reconciles, reconcileSpecs, release: () => gate.resolve() };
}
