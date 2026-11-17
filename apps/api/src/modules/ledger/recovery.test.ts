// SPDX-License-Identifier: AGPL-3.0-only
// Crashes and races: no Action is lost, none executes twice, and an outcome that may
// have happened is never repeated without its dedupe class or a person saying so.
import { expect, test } from "vitest";
import type { EffectCapability } from "@direx/plugin-sdk";
import type { Step } from "./index";
import { fakeEffect, scheduledAction, testLedger } from "./test-effects";

const W = crypto.randomUUID();
const effects: Record<string, EffectCapability> = {};
const crash: { at?: Step } = {};
const TIMEOUT = 200;
const { clock, ledger, wakes } = await testLedger({
  effects,
  executeTimeoutMs: TIMEOUT,
  onStep: (step) => {
    if (crash.at === step) {
      crash.at = undefined;
      throw new Error(`simulated crash after ${step}`);
    }
  },
});

async function setup(dedupe: "blind" | "queryable" | "provider_idempotent", opts: Parameters<typeof fakeEffect>[1] = {}) {
  const cap = `test.${crypto.randomUUID()}`;
  const fake = fakeEffect(dedupe, opts);
  effects[cap] = fake.capability;
  return { id: await scheduledAction(ledger, W, cap, dedupe), fake };
}

const get = (id: string) => ledger.getAction(W, id).then((a) => a!);

test("ten dispatchers racing for one Action execute it exactly once", async () => {
  const started = Promise.withResolvers<void>();
  const { id, fake } = await setup("blind", { steps: ["block"], onStart: () => started.resolve() });
  const runs = Array.from({ length: 10 }, () => ledger.run(W, id));
  await started.promise;
  await new Promise((r) => setTimeout(r, 50)); // let the losers reach the row
  fake.release();
  await Promise.all(runs);
  expect(fake.calls).toHaveLength(1);
  expect((await get(id)).state).toBe("sent");
});

test("a crash after the claim, before the provider call, retries and executes once", async () => {
  const { id, fake } = await setup("blind");
  crash.at = "claim";
  await expect(ledger.run(W, id)).rejects.toThrow(/simulated crash/);
  expect((await get(id)).state).toBe("claimed");
  expect(fake.calls).toHaveLength(0);
  await ledger.run(W, id);
  expect((await get(id)).state).toBe("sent");
  expect(fake.calls).toHaveLength(1);
});

test("a crash once dispatch began becomes an unknown outcome after the timeout, never a resend", async () => {
  const { id, fake } = await setup("blind");
  crash.at = "dispatch_check";
  await expect(ledger.run(W, id)).rejects.toThrow(/simulated crash/);
  const dispatching = await get(id);
  expect(dispatching.state).toBe("dispatching");

  // Before the deadline: left alone, with a wake set for the deadline.
  await ledger.run(W, id);
  expect((await get(id)).state).toBe("dispatching");
  // The provider call may have begun, so it can't be moved to a new time.
  expect(await ledger.moveAction(W, id, { system: "test" })).toEqual({ ok: false, reason: "wrong_state" });
  const deadline = dispatching.dispatchStartedAt!.getTime() + TIMEOUT + 60_000;
  expect((await wakes(id)).map((d) => d.getTime())).toContain(deadline);

  clock.at = new Date(deadline + 1);
  await ledger.run(W, id);
  expect(await get(id)).toMatchObject({ state: "held", holdReason: "outcome_unknown", nextAttemptAt: null });
  expect(fake.calls).toHaveLength(0);
});

test("a provider call that times out is an unknown outcome; a blind one waits for a person", async () => {
  const { id, fake } = await setup("blind", { steps: ["hang"] });
  await ledger.run(W, id);
  expect(await get(id)).toMatchObject({ state: "held", holdReason: "outcome_unknown", nextAttemptAt: null });
  clock.at = new Date(clock.at.getTime() + 24 * 3_600_000);
  for (let i = 0; i < 3; i++) await ledger.run(W, id);
  expect(fake.calls).toHaveLength(1);
  // Nothing may replace or cancel it while the outcome is unknown.
  expect(await ledger.cancel(W, id, { system: "test" })).toEqual({ ok: false, reason: "outcome_unknown" });
  expect(await ledger.moveAction(W, id, { system: "test" })).toEqual({ ok: false, reason: "outcome_unknown" });
  expect(await ledger.reviseAction(W, id, { spec: { x: 1 }, actor: { system: "test" } })).toEqual({
    ok: false,
    reason: "outcome_unknown",
  });
});

test("a worker that settles after recovery moved the Action changes nothing", async () => {
  const started = Promise.withResolvers<void>();
  const { id, fake } = await setup("blind", { steps: ["block"], onStart: () => started.resolve() });
  const slow = ledger.run(W, id);
  await started.promise;
  // The slow worker is stuck in the provider call; another worker passes the deadline.
  const dispatching = await get(id);
  clock.at = new Date(dispatching.dispatchStartedAt!.getTime() + TIMEOUT + 60_001);
  await ledger.run(W, id);
  await slow; // its own timeout fires, and its settle finds the version moved
  fake.release();
  const events = await ledger.getEvents(W, id);
  expect(events.filter((e) => e.toState === "held")).toHaveLength(1);
  expect(await get(id)).toMatchObject({ state: "held", holdReason: "outcome_unknown" });
});

test("recovery waits out an effect's declared timeout before calling the outcome unknown", async () => {
  const { id, fake } = await setup("blind", { steps: ["hang"], timeoutMs: 120_000 });
  void ledger.run(W, id);
  await expect.poll(() => fake.calls.length).toBe(1);
  await ledger.run(W, id);
  expect((await get(id)).state).toBe("dispatching");
  clock.at = new Date(clock.at.getTime() + 120_000 + 60_000 + 1);
  await ledger.run(W, id);
  expect(await get(id)).toMatchObject({ state: "held", holdReason: "outcome_unknown" });
});
