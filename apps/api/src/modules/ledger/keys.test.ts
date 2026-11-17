// SPDX-License-Identifier: AGPL-3.0-only
// An Action whose Workspace keys can't be loaded: held, never woken forever, and checked again on resume.
import { expect, test } from "vitest";
import type { EffectCapability } from "@direx/plugin-sdk";
import { ownerClient } from "../../../../../test/db";
import { KeysUnavailable, oneKey, type SigningKeys } from "./index";
import { fakeEffect, person, scheduledAction, testKey, testLedger } from "./test-effects";

const W = crypto.randomUUID();
const effects: Record<string, EffectCapability> = {};
const keys = { mode: "ok" as "ok" | "permanent" | "transient" | "other" };
const real = oneKey(testKey);
const signingKeys: SigningKeys = async (ws) => {
  if (keys.mode === "permanent") throw new KeysUnavailable("data key was wrapped by another root key", true);
  if (keys.mode === "transient") throw new KeysUnavailable("key service timed out", false);
  if (keys.mode === "other") throw new Error("connection reset");
  return real(ws);
};
const claims: string[] = [];
const { clock, ledger } = await testLedger({ effects, signingKeys, executeTimeoutMs: 100, onStep: async (step, id) => void (step === "claim" && claims.push(id)) });

async function setup(dedupe: "blind" | "provider_idempotent" = "blind", opts: Parameters<typeof fakeEffect>[1] = {}) {
  const cap = `test.${crypto.randomUUID()}`;
  const fake = fakeEffect(dedupe, opts);
  effects[cap] = fake.capability;
  keys.mode = "ok";
  const id = await scheduledAction(ledger, W, cap, dedupe);
  return { id, fake, cap };
}
const get = (id: string) => ledger.getAction(W, id).then((a) => a!);
async function sql(text: string, values: unknown[]) {
  const c = await ownerClient();
  try {
    return (await c.query(text, values)).rows;
  } finally {
    await c.end();
  }
}

test("a data key wrapped by another root key holds the Action for a person, with no retry, nothing sent and its approval kept", async () => {
  const { id, fake } = await setup();
  keys.mode = "permanent";
  await ledger.run(W, id);
  expect(await get(id)).toMatchObject({ state: "held", holdReason: "keys_unavailable", nextAttemptAt: null });
  expect((await get(id)).reasonDetail).toContain("another root key");
  await ledger.run(W, id);
  expect(fake.calls).toHaveLength(0);
  expect(await sql("select voided_at from approvals where action_id = $1", [id])).toEqual([{ voided_at: null }]);
});

test("an automatic retry goes through the claim check again, not straight to the dispatch check", async () => {
  const { id, fake } = await setup();
  keys.mode = "transient";
  await ledger.run(W, id);
  expect(claims.filter((c) => c === id)).toHaveLength(0);
  keys.mode = "ok";
  clock.at = (await get(id)).nextAttemptAt!;
  await ledger.run(W, id);
  expect(claims.filter((c) => c === id)).toHaveLength(1);
  expect(fake.calls).toHaveLength(1);
});

test("a resend after an unknown outcome stays unknown when its keys fail, and a permanent failure stops its retries", async () => {
  const { id, fake } = await setup("provider_idempotent", { steps: ["hang"] });
  await ledger.run(W, id);
  const unknown = await get(id);
  expect(unknown).toMatchObject({ state: "held", holdReason: "outcome_unknown" });
  expect(unknown.nextAttemptAt).not.toBeNull();
  keys.mode = "permanent";
  clock.at = unknown.nextAttemptAt!;
  await ledger.run(W, id);
  expect(await get(id)).toMatchObject({ state: "held", holdReason: "outcome_unknown", nextAttemptAt: null });
  expect((await get(id)).reasonDetail).toContain("another root key");
  expect(fake.calls).toHaveLength(1);
});

test("crash recovery and approval expiry still run while the keys won't load", async () => {
  const { id } = await setup();
  keys.mode = "permanent";
  await sql("update actions set state = 'dispatching', dispatch_started_at = $2, first_dispatched_at = $2 where id = $1", [id, new Date(clock.at.getTime() - 3_600_000)]);
  await ledger.run(W, id);
  expect(await get(id)).toMatchObject({ state: "held", holdReason: "outcome_unknown", reasonDetail: "worker stopped during dispatch" });

  keys.mode = "ok";
  const cap = `test.${crypto.randomUUID()}`;
  effects[cap] = fakeEffect("blind").capability;
  const { action } = await ledger.createAction(W, { idempotencyKey: crypto.randomUUID(), capability: cap, dedupe: "blind", spec: { to: "x@example.com" }, actor: person });
  await ledger.submitForApproval(W, action.id, person);
  keys.mode = "permanent";
  clock.at = new Date(clock.at.getTime() + 15 * 86_400_000);
  await ledger.run(W, action.id);
  expect(await get(action.id)).toMatchObject({ state: "held", holdReason: "approval_expired" });
});

test("any other key failure retries at 1, 5 and 25 minutes, then waits for a person", async () => {
  for (const mode of ["transient", "other"] as const) {
    const { id, fake } = await setup();
    keys.mode = mode;
    const start = clock.at.getTime();
    await ledger.run(W, id);
    for (let i = 0; i < 3; i++) {
      const a = await get(id);
      expect(a, mode).toMatchObject({ state: "held", holdReason: "keys_unavailable" });
      clock.at = a.nextAttemptAt!;
      await ledger.run(W, id);
    }
    expect(await get(id), mode).toMatchObject({ state: "held", holdReason: "keys_unavailable", nextAttemptAt: null });
    expect((await get(id)).reasonDetail, mode).toMatch(/^retries used up: (key service timed out|connection reset)$/);
    expect(clock.at.getTime() - start, mode).toBe((1 + 5 + 25) * 60_000);
    expect(fake.calls, mode).toHaveLength(0);
  }
});

test("a key that comes back before the next retry sends on that retry, once", async () => {
  const { id, fake } = await setup();
  keys.mode = "transient";
  await ledger.run(W, id);
  keys.mode = "ok";
  clock.at = (await get(id)).nextAttemptAt!;
  await ledger.run(W, id);
  expect((await get(id)).state).toBe("sent");
  expect(fake.calls).toHaveLength(1);
});

test("resuming loads the keys again: still broken holds again, restored sends on the approval it had", async () => {
  const { id, fake } = await setup();
  keys.mode = "permanent";
  await ledger.run(W, id);
  expect(await ledger.resume(W, id, person)).toMatchObject({ ok: true });
  await ledger.run(W, id);
  expect(await get(id)).toMatchObject({ state: "held", holdReason: "keys_unavailable" });
  keys.mode = "ok";
  expect(await ledger.resume(W, id, person)).toMatchObject({ ok: true });
  await ledger.run(W, id);
  expect((await get(id)).state).toBe("sent");
  expect(fake.calls).toHaveLength(1);
});
