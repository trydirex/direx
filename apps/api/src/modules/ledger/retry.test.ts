// SPDX-License-Identifier: AGPL-3.0-only
// Retries and unknown outcomes, by dedupe class: idempotent resends, reconcile queries,
// retryable refusals and a person's decision.
import { expect, test } from "vitest";
import type { EffectCapability } from "@direx/plugin-sdk";
import type { Check } from "./index";
import { fakeEffect, person, scheduledAction, testLedger } from "./test-effects";

const W = crypto.randomUUID();
const effects: Record<string, EffectCapability> = {};
const checks: Check[] = [];
const { clock, ledger } = await testLedger({ effects, checks, executeTimeoutMs: 100 });

async function setup(dedupe: "blind" | "queryable" | "provider_idempotent", opts: Parameters<typeof fakeEffect>[1] = {}) {
  const cap = `test.${crypto.randomUUID()}`;
  const fake = fakeEffect(dedupe, opts);
  effects[cap] = fake.capability;
  return { id: await scheduledAction(ledger, W, cap, dedupe, { spec: { z: "last", a: "first", n: [1, 2] } }), fake };
}

const get = (id: string) => ledger.getAction(W, id).then((a) => a!);

/** Moves the clock to the Action's next retry and runs it. */
async function nextRetry(id: string) {
  const a = await get(id);
  if (!a.nextAttemptAt) throw new Error("no retry scheduled");
  clock.at = a.nextAttemptAt;
  await ledger.run(W, id);
}

test("an idempotent resend uses the same key and the same bytes, 3 times at most, then waits for a person", async () => {
  const { id, fake } = await setup("provider_idempotent", { steps: ["hang"] });
  const start = clock.at.getTime();
  await ledger.run(W, id);
  for (let i = 0; i < 3; i++) await nextRetry(id);
  expect(fake.calls).toHaveLength(4);
  expect(new Set(fake.calls.map((c) => c.idempotencyKey))).toEqual(new Set([id]));
  expect(new Set(fake.calls.map((c) => JSON.stringify(c.spec)))).toEqual(new Set(['{"a":"first","n":[1,2],"z":"last"}']));
  expect(await get(id)).toMatchObject({ state: "held", holdReason: "outcome_unknown", nextAttemptAt: null, reasonDetail: "retries used up" });
  expect(clock.at.getTime() - start).toBe((1 + 5 + 25) * 60_000);
});

test("every idempotent resend passes the dispatch check again", async () => {
  const { id, fake } = await setup("provider_idempotent", { steps: ["hang"] });
  await ledger.run(W, id);
  const optOut: Check = async (_tx, a) => (a.id === id ? { kind: "block", reason: "opted_out" } : { kind: "ok" });
  checks.push(optOut);
  try {
    await nextRetry(id);
  } finally {
    checks.splice(checks.indexOf(optOut), 1);
  }
  expect(await get(id)).toMatchObject({ state: "blocked", blockReason: "opted_out" });
  expect(fake.calls).toHaveLength(1);
  // Still marked as maybe sent, so it keeps counting against the Person's caps.
  expect((await get(id)).outcomeUnknownAt).not.toBeNull();
});

test("no idempotent resend once the provider's key window has passed", async () => {
  const { id, fake } = await setup("provider_idempotent", { steps: ["hang"] });
  await ledger.run(W, id);
  clock.at = new Date(clock.at.getTime() + 25 * 3_600_000); // past the fake's 24 h window
  await ledger.run(W, id);
  expect(await get(id)).toMatchObject({ state: "held", holdReason: "outcome_unknown", nextAttemptAt: null, reasonDetail: "provider key window passed" });
  expect(fake.calls).toHaveLength(1);
});

test("queryable: a reconcile that finds it sent settles it, with no second call", async () => {
  const { id, fake } = await setup("queryable", { steps: ["throw"], reconcile: ["sent"] });
  await ledger.run(W, id);
  expect((await get(id)).holdReason).toBe("outcome_unknown");
  await nextRetry(id);
  expect(await get(id)).toMatchObject({ state: "sent", providerRef: "reconciled" });
  expect(fake.calls).toHaveLength(1);
  expect(fake.reconciles).toEqual([id]);
});

test("queryable: reconcile is given the approved spec, and a 'refused' Blocks it with no second call (ADR 0025 rule 005)", async () => {
  const { id, fake } = await setup("queryable", { steps: ["throw"], reconcile: ["refused"] });
  await ledger.run(W, id);
  await nextRetry(id);
  expect(await get(id)).toMatchObject({ state: "blocked", blockReason: "provider_refused_permanently", reasonDetail: "access removed" });
  expect(fake.calls).toHaveLength(1);
  expect(fake.reconcileSpecs).toEqual([(await get(id)).spec]);
});

test("queryable: 'not sent' dispatches again through the checks", async () => {
  const { id, fake } = await setup("queryable", { steps: ["throw", "sent"], reconcile: ["not_sent"] });
  await ledger.run(W, id);
  await nextRetry(id);
  expect((await get(id)).state).toBe("sent");
  expect(fake.calls).toHaveLength(2);
});

test("queryable: 'unknown' is asked again at 1, 5 and 25 minutes, then waits for a person", async () => {
  const { id, fake } = await setup("queryable", { steps: ["throw"], reconcile: ["unknown"] });
  await ledger.run(W, id);
  for (let i = 0; i < 3; i++) await nextRetry(id);
  expect(fake.reconciles).toHaveLength(3);
  expect(fake.calls).toHaveLength(1);
  expect(await get(id)).toMatchObject({ state: "held", holdReason: "outcome_unknown", nextAttemptAt: null });
});

test("a retryable refusal is retried, and succeeds", async () => {
  const { id, fake } = await setup("blind", { steps: ["refused_retryable", "sent"] });
  await ledger.run(W, id);
  expect((await get(id)).holdReason).toBe("provider_rejected");
  await nextRetry(id);
  expect((await get(id)).state).toBe("sent");
  expect(fake.calls).toHaveLength(2);
});

test("a person marks a blind unknown outcome sent, or resends it accepting the risk", async () => {
  const marked = await setup("blind", { steps: ["hang"] });
  const resent = await setup("blind", { steps: ["hang", "sent"] });
  await ledger.run(W, marked.id);
  await ledger.run(W, resent.id);

  const m = await ledger.resolveUnknown(W, marked.id, "mark_sent", person.userId);
  expect(m.ok && m.action.state).toBe("sent");
  expect(marked.fake.calls).toHaveLength(1);

  const r = await ledger.resolveUnknown(W, resent.id, "resend", person.userId);
  expect(r.ok && r.action.state).toBe("claimed");
  await ledger.run(W, resent.id);
  expect((await get(resent.id)).state).toBe("sent");
  expect(resent.fake.calls).toHaveLength(2);
  const decision = (await ledger.getEvents(W, resent.id)).find((e) => e.detail === "resend accepted with duplicate risk");
  expect(decision?.actorUserId).toBe(person.userId);

  expect(await ledger.resolveUnknown(W, resent.id, "resend", person.userId)).toEqual({ ok: false, reason: "wrong_state" });
});

// An unknown outcome may already have gone out, so it stays visible until settled.
test("a resend held by a failing check still reads not sure it sent, and can't be cancelled", async () => {
  const { id, fake } = await setup("blind", { steps: ["hang"] });
  await ledger.run(W, id);
  const failing: Check = async (_tx, a) => (a.id === id ? { kind: "hold", reason: "cap", detail: "slot passed" } : { kind: "ok" });
  checks.push(failing);
  try {
    expect((await ledger.resolveUnknown(W, id, "resend", person.userId)).ok).toBe(true);
    await ledger.run(W, id);
  } finally {
    checks.splice(checks.indexOf(failing), 1);
  }
  expect(await get(id)).toMatchObject({ state: "held", holdReason: "outcome_unknown", reasonDetail: "cap: slot passed" });
  expect(fake.calls).toHaveLength(1);
  expect(await ledger.cancel(W, id, person)).toMatchObject({ ok: false, reason: "outcome_unknown" });
  expect(await ledger.resume(W, id, person)).toMatchObject({ ok: false, reason: "outcome_unknown" });
});

test("a refused retry doesn't settle an earlier unknown call", async () => {
  const { id, fake } = await setup("provider_idempotent", { steps: ["hang", "refused_retryable"] });
  await ledger.run(W, id);
  await nextRetry(id);
  expect(await get(id)).toMatchObject({ state: "held", holdReason: "outcome_unknown" });
  expect((await get(id)).nextAttemptAt).not.toBeNull();
  expect(fake.calls).toHaveLength(2);
});

test("a credential held while unknown is not resumed by reconnecting it", async () => {
  const { id, fake } = await setup("provider_idempotent", { steps: ["hang"] });
  await ledger.run(W, id);
  const noCredential: Check = async (_tx, a) => (a.id === id ? { kind: "hold", reason: "credential_unavailable" } : { kind: "ok" });
  checks.push(noCredential);
  try {
    await nextRetry(id);
  } finally {
    checks.splice(checks.indexOf(noCredential), 1);
  }
  expect(await get(id)).toMatchObject({ holdReason: "outcome_unknown", nextAttemptAt: null });
  expect(await ledger.resume(W, id, { system: "credentials" })).toMatchObject({ ok: false, reason: "outcome_unknown" });
  expect(fake.calls).toHaveLength(1);
});

test("a sweep resumes an Action only while it is still held for the reason the sweep matched", async () => {
  const { id } = await setup("blind", { steps: ["sent"] });
  const noCredential: Check = async (_tx, a) => (a.id === id ? { kind: "hold", reason: "credential_unavailable" } : { kind: "ok" });
  checks.push(noCredential);
  try {
    await ledger.run(W, id);
  } finally {
    checks.splice(checks.indexOf(noCredential), 1);
  }
  expect(await get(id)).toMatchObject({ state: "held", holdReason: "credential_unavailable" });
  expect(await ledger.resume(W, id, { system: "outreach" }, { heldFor: "reply_unread" })).toMatchObject({ ok: false, reason: "wrong_state" });
  expect(await get(id)).toMatchObject({ state: "held", holdReason: "credential_unavailable" });
  expect((await ledger.resume(W, id, { system: "credentials" }, { heldFor: "credential_unavailable" })).ok).toBe(true);
  expect((await get(id)).state).toBe("scheduled");
});

test("settling clears it: a confirmed send counts as sent", async () => {
  const { id } = await setup("blind", { steps: ["hang"] });
  await ledger.run(W, id);
  expect(await ledger.resolveUnknown(W, id, "mark_sent", person.userId)).toMatchObject({ ok: true });
  expect(await get(id)).toMatchObject({ state: "sent", outcomeUnknownAt: null });
});
