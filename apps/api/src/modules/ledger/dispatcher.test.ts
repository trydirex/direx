// SPDX-License-Identifier: AGPL-3.0-only
// Claim, dispatch check, provider call and settle, through the public entry point.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "vitest";
import type { EffectCapability } from "@direx/plugin-sdk";
import { appClient, ownerClient } from "../../../../../test/db";
import type { Check } from "./index";
import { fakeEffect, scheduledAction, testLedger } from "./test-effects";

const W = crypto.randomUUID();
const effects: Record<string, EffectCapability> = {};
const checks: Check[] = [];
const versions: Record<string, string> = { f1: "1", f2: "1" };
const steps: { onClaim?: () => Promise<void> } = {};
const { ledger, clock } = await testLedger({
  effects,
  checks,
  resolvers: { fact: async (_tx, id) => versions[id] ?? null },
  executeTimeoutMs: 200,
  onStep: async (step) => {
    if (step === "claim") await steps.onClaim?.();
  },
});

/** Registers a fresh effect under a new capability id and schedules one Action for it. */
async function setup(dedupe: "blind" | "queryable" | "provider_idempotent", opts: Parameters<typeof fakeEffect>[1] = {}, snapshot = [] as { kind: string; id: string; version: string }[]) {
  const cap = `test.${crypto.randomUUID()}`;
  const fake = fakeEffect(dedupe, opts);
  effects[cap] = fake.capability;
  const id = await scheduledAction(ledger, W, cap, dedupe, { snapshot });
  return { id, fake };
}

async function sql(text: string, values: unknown[], as: "app" | "owner" = "app") {
  const c = as === "app" ? await appClient() : await ownerClient();
  try {
    await c.query("select set_config('app.workspace_id', $1, false)", [W]);
    await c.query(text, values);
  } finally {
    await c.end();
  }
}

const state = async (id: string) => {
  const a = await ledger.getAction(W, id);
  return { state: a!.state, hold: a!.holdReason, block: a!.blockReason, detail: a!.reasonDetail };
};

test("an approved Action is sent once, with its id as the idempotency key", async () => {
  const { id, fake } = await setup("blind");
  await ledger.run(W, id);
  expect((await state(id)).state).toBe("sent");
  expect(fake.calls.map((c) => c.idempotencyKey)).toEqual([id]);
  await ledger.run(W, id);
  expect(fake.calls).toHaveLength(1);
});

test("a spec changed by hand after approval is held at claim, and nothing is sent", async () => {
  const { id, fake } = await setup("blind");
  await sql(`update actions set spec = '{"to":"someone-else@example.com"}' where id = $1`, [id]);
  await ledger.run(W, id);
  expect(await state(id)).toMatchObject({ state: "held", hold: "approval_invalid" });
  expect(fake.calls).toHaveLength(0);
});

test("a forged signature is caught at the dispatch check, after the claim passed", async () => {
  const { id, fake } = await setup("blind");
  steps.onClaim = () => sql("update approvals set signature = 'forged' where action_id = $1", [id], "owner");
  try {
    await ledger.run(W, id);
  } finally {
    steps.onClaim = undefined;
  }
  expect(await state(id)).toMatchObject({ state: "held", hold: "approval_invalid", detail: "signature does not verify" });
  expect(fake.calls).toHaveLength(0);
});

test("a changed snapshot entry holds the Action and names it; an unrelated change does nothing", async () => {
  const a = await setup("blind", {}, [{ kind: "fact", id: "f1", version: "1" }]);
  const b = await setup("blind", {}, [{ kind: "fact", id: "f1", version: "1" }]);
  versions.f2 = "7"; // not in either snapshot
  await ledger.run(W, a.id);
  expect((await state(a.id)).state).toBe("sent");
  versions.f1 = "2";
  await ledger.run(W, b.id);
  expect(await state(b.id)).toMatchObject({ state: "held", hold: "snapshot_changed", detail: "fact:f1" });
  expect(b.fake.calls).toHaveLength(0);
  versions.f1 = "1";
});

test("a check that blocks gives Blocked; one that holds gives Held", async () => {
  const blocked = await setup("blind");
  const held = await setup("blind");
  const check: Check = async (_tx, a) =>
    a.id === blocked.id ? { kind: "block", reason: "opted_out" } : a.id === held.id ? { kind: "hold", reason: "campaign_paused" } : { kind: "ok" };
  checks.push(check);
  try {
    await ledger.run(W, blocked.id);
    await ledger.run(W, held.id);
  } finally {
    checks.splice(checks.indexOf(check), 1);
  }
  expect(await state(blocked.id)).toMatchObject({ state: "blocked", block: "opted_out" });
  expect(await state(held.id)).toMatchObject({ state: "held", hold: "campaign_paused" });
  expect([blocked.fake.calls, held.fake.calls]).toEqual([[], []]);
});

test("a check that flips between claim and dispatch is caught at dispatch", async () => {
  const { id, fake } = await setup("blind");
  let calls = 0;
  const check: Check = async (_tx, a) => (a.id === id && ++calls > 1 ? { kind: "block", reason: "opted_out" } : { kind: "ok" });
  checks.push(check);
  try {
    await ledger.run(W, id);
  } finally {
    checks.splice(checks.indexOf(check), 1);
  }
  expect(calls).toBe(2);
  expect((await state(id)).state).toBe("blocked");
  expect(fake.calls).toHaveLength(0);
});

test("an emergency pause holds new claims, but does not recall a call already past the dispatch check", async () => {
  let paused = false;
  const pause: Check = async () => (paused ? { kind: "hold", reason: "emergency_pause" } : { kind: "ok" });
  checks.push(pause);
  try {
    const started = Promise.withResolvers<void>();
    const inFlight = await setup("blind", { steps: ["block"], onStart: () => started.resolve() });
    const run = ledger.run(W, inFlight.id);
    await started.promise;
    paused = true;
    const next = await setup("blind");
    await ledger.run(W, next.id);
    inFlight.fake.release();
    await run;
    expect((await state(inFlight.id)).state).toBe("sent");
    expect(await state(next.id)).toMatchObject({ state: "held", hold: "emergency_pause" });
    expect(next.fake.calls).toHaveLength(0);
  } finally {
    checks.splice(checks.indexOf(pause), 1);
  }
});

test("a permanent refusal blocks; a retryable one is held with a retry scheduled", async () => {
  const perm = await setup("blind", { steps: ["refused_permanent"] });
  const temp = await setup("blind", { steps: ["refused_retryable"] });
  await ledger.run(W, perm.id);
  await ledger.run(W, temp.id);
  expect(await state(perm.id)).toMatchObject({ state: "blocked", block: "provider_refused_permanently", detail: "hard bounce" });
  expect(await state(temp.id)).toMatchObject({ state: "held", hold: "provider_rejected" });
  expect((await ledger.getAction(W, temp.id))!.nextAttemptAt).not.toBeNull();
});

test("every dispatch records the gap between the dispatch check and the provider call", async () => {
  const { id } = await setup("blind");
  await ledger.run(W, id);
  const settle = (await ledger.getEvents(W, id)).at(-1)!;
  expect(settle.toState).toBe("sent");
  expect(settle.dispatchGapMs).toBeGreaterThanOrEqual(0);
  expect(settle.dispatchGapMs).toBeLessThan(2000);
});

test("a job naming another workspace's Action does nothing", async () => {
  const { id, fake } = await setup("blind");
  await ledger.run(crypto.randomUUID(), id);
  expect((await state(id)).state).toBe("scheduled");
  expect(fake.calls).toHaveLength(0);
});

test("only the repository writes an Action's state or version", () => {
  const src = join(import.meta.dirname, "..", "..");
  const offenders: string[] = [];
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const p = join(dir, name);
      if (statSync(p).isDirectory()) walk(p);
      else if (p.endsWith(".ts") && !p.endsWith(".test.ts") && !p.endsWith("ledger-repo.ts")) {
        if (/\.update\(\s*actions\b/.test(readFileSync(p, "utf8"))) offenders.push(p);
      }
    }
  };
  walk(src);
  expect(offenders).toEqual([]);
});

test("a sent result keeps its link and follow-ups on the Action", async () => {
  const { id } = await setup("blind", { steps: ["sent_with_result"] });
  await ledger.run(W, id);
  expect(await ledger.getAction(W, id)).toMatchObject({ state: "sent", result: { url: "https://example.com/p/1", followUps: [{ status: "uncertain" }] } });
});

test("a result with nothing to report stores nothing", async () => {
  const { id } = await setup("blind");
  await ledger.run(W, id);
  expect((await ledger.getAction(W, id))!.result).toBeNull();
});

test("a link confirmed by reconcile is kept", async () => {
  const { id } = await setup("queryable", { steps: ["throw"], reconcile: ["sent"] });
  await ledger.run(W, id);
  // Due by the ledger's clock, not the database's, which moves on in real time.
  await sql("update actions set next_attempt_at = $2 where id = $1", [id, new Date(clock.at.getTime() - 60 * 60 * 1000)], "owner");
  await ledger.run(W, id);
  expect(await ledger.getAction(W, id)).toMatchObject({ state: "sent", result: { url: "https://example.com/p/reconciled" } });
});

test("an effect that declares a longer timeout may take it, and one that doesn't still times out", async () => {
  const slow = await setup("blind", { steps: ["block"], timeoutMs: 5_000, onStart: () => setTimeout(() => slow.fake.release(), 400) } as Parameters<typeof fakeEffect>[1]);
  await ledger.run(W, slow.id);
  expect((await state(slow.id)).state).toBe("sent");
  const hung = await setup("blind", { steps: ["hang"] });
  await ledger.run(W, hung.id);
  expect(await state(hung.id)).toMatchObject({ state: "held", hold: "outcome_unknown" });
});

test("a re-dated Action goes out at its new time on the approval it already had", async () => {
  const { id, fake } = await setup("blind");
  const start = clock.at;
  const later = new Date(start.getTime() + 86_400_000);
  expect((await ledger.redateAction(W, id, later, { system: "test" })).ok).toBe(true);
  await ledger.run(W, id);
  expect((await state(id)).state).toBe("scheduled");
  clock.at = later;
  try {
    await ledger.run(W, id);
  } finally {
    clock.at = start;
  }
  expect((await state(id)).state).toBe("sent");
  expect(fake.calls).toHaveLength(1);
});

test("a held Action re-dated keeps its hold and its reason", async () => {
  versions.f1 = "1";
  const { id } = await setup("blind", {}, [{ kind: "fact", id: "f1", version: "1" }]);
  versions.f1 = "2";
  try {
    await ledger.run(W, id);
  } finally {
    versions.f1 = "1";
  }
  expect((await state(id)).hold).toBe("snapshot_changed");
  const later = new Date(clock.at.getTime() + 86_400_000);
  const r = await ledger.redateAction(W, id, later, { system: "test" });
  expect(r.ok && r.action).toMatchObject({ state: "held", holdReason: "snapshot_changed", dueAt: later });
});
