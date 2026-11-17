// SPDX-License-Identifier: AGPL-3.0-only
// The Action lifecycle, tested through the module's public entry point only.
import { expect, test } from "vitest";
import { APPROVAL_TTL_MS } from "./index";
import { approver, person, testLedger } from "./test-effects";

const W = crypto.randomUUID();
const { clock, ledger, wakes } = await testLedger();

const draft = (key: string, spec: unknown = { to: "dana@example.com", body: "hello" }) =>
  ledger.createAction(W, { idempotencyKey: key, capability: "test.send", dedupe: "blind", spec, actor: person });

async function approved(key: string) {
  const { action } = await draft(key);
  await ledger.submitForApproval(W, action.id, person);
  const r = await ledger.approve(W, action.id, { approverId: approver, draftVersion: 1, snapshot: [] });
  if (!r.ok) throw new Error(r.reason);
  return r.action;
}

test("the same idempotency key gives the same Action, once", async () => {
  const a = await draft("l1");
  const b = await draft("l1", { different: true });
  expect(b.action.id).toBe(a.action.id);
  expect([a.created, b.created]).toEqual([true, false]);
  expect(b.action.spec).toEqual(a.action.spec);
});

test("every change bumps version and is recorded", async () => {
  const a = await approved("l2");
  expect(a.state).toBe("scheduled");
  expect(a.version).toBe(3);
  const events = await ledger.getEvents(W, a.id);
  expect(events.map((e) => [e.fromState, e.toState, e.version])).toEqual([
    [null, "draft", 1],
    ["draft", "needs_approval", 2],
    ["needs_approval", "scheduled", 3],
  ]);
  expect(events[2]!.actorUserId).toBe(approver);
});

test("revising after approval voids it and keeps the Action id", async () => {
  const a = await approved("l8");
  const r = await ledger.reviseAction(W, a.id, { spec: { to: "dana@example.com", body: "edited" }, actor: person });
  expect(r.ok && r.action).toMatchObject({ id: a.id, state: "needs_approval", draftVersion: 2 });
  // The old approval was for draft version 1; approving needs version 2 now.
  const stale = await ledger.approve(W, a.id, { approverId: approver, draftVersion: 1, snapshot: [] });
  expect(stale).toEqual({ ok: false, reason: "draft_version_moved" });
  const ok = await ledger.approve(W, a.id, { approverId: approver, draftVersion: 2, snapshot: [] });
  expect(ok.ok && ok.action.state).toBe("scheduled");
});

test("a draft edit stays a draft and bumps the draft version", async () => {
  const { action } = await draft("draft-edit");
  const r = await ledger.reviseAction(W, action.id, { spec: { body: "v2" }, actor: person });
  expect(r.ok && r.action).toMatchObject({ state: "draft", draftVersion: 2, version: 2 });
});

test("approval schedules a wake at the due time; submission schedules the expiry", async () => {
  const { action } = await draft("wakes");
  await ledger.submitForApproval(W, action.id, person);
  const due = new Date("2026-11-03T08:00:00Z");
  await ledger.approve(W, action.id, { approverId: approver, draftVersion: 1, snapshot: [], dueAt: due });
  const at = (await wakes(action.id)).map((d) => d.toISOString()).sort();
  expect(at).toEqual([due.toISOString(), new Date(clock.at.getTime() + 14 * 86_400_000).toISOString()].sort());
});

test("a stored spec hashes the same after a jsonb round trip", async () => {
  const spec = { z: 1, a: { y: [1, 2.5, "x"], b: null }, m: "é" };
  const { action } = await draft("jsonb", spec);
  const read = await ledger.getAction(W, action.id);
  expect(Object.keys(read!.spec as object)).not.toEqual(Object.keys(spec)); // jsonb reordered it
  const again = await ledger.createAction(crypto.randomUUID(), {
    idempotencyKey: "jsonb",
    capability: "test.send",
    dedupe: "blind",
    spec: read!.spec,
    actor: person,
  });
  expect(again.action.specHash).toBe(action.specHash);
});

test("cancel works before dispatch and is final", async () => {
  const a = await approved("cancel");
  const r = await ledger.cancel(W, a.id, person);
  expect(r.ok && r.action.state).toBe("cancelled");
  expect(await ledger.cancel(W, a.id, person)).toEqual({ ok: false, reason: "wrong_state" });
});

test("another workspace cannot see or change the Action", async () => {
  const a = await approved("rls");
  expect(await ledger.getAction(crypto.randomUUID(), a.id)).toBeUndefined();
  expect(await ledger.cancel(crypto.randomUUID(), a.id, person)).toEqual({ ok: false, reason: "not_found" });
});

test("moving an approved Action voids its approval and needs a new one, under the same id", async () => {
  const a = await approved("move-scheduled");
  const r = await ledger.moveAction(W, a.id, person);
  expect(r.ok && r.action).toMatchObject({ id: a.id, state: "needs_approval", dueAt: null, draftVersion: 1 });
  const again = await ledger.approve(W, a.id, { approverId: approver, draftVersion: 1, snapshot: [] });
  expect(again.ok && again.action.state).toBe("scheduled");
});

test("moving starts a new expiry, and an old wake finds nothing to do", async () => {
  const a = await approved("move-wake");
  await ledger.moveAction(W, a.id, person);
  await ledger.run(W, a.id);
  expect(await ledger.getAction(W, a.id)).toMatchObject({ state: "needs_approval" });
  expect((await wakes(a.id)).at(-1)!.getTime()).toBe(clock.at.getTime() + APPROVAL_TTL_MS);
});

test("a draft or a finished Action has nothing to move", async () => {
  const { action } = await draft("move-draft");
  expect(await ledger.moveAction(W, action.id, person)).toEqual({ ok: false, reason: "wrong_state" });
  const a = await approved("move-cancelled");
  await ledger.cancel(W, a.id, person);
  expect(await ledger.moveAction(W, a.id, person)).toEqual({ ok: false, reason: "wrong_state" });
});

test("re-dating later keeps the approval and wakes at the new time", async () => {
  const a = await approved("redate-later");
  const later = new Date(clock.at.getTime() + 3 * 86_400_000);
  const r = await ledger.redateAction(W, a.id, later, person);
  expect(r.ok && r.action).toMatchObject({ id: a.id, state: "scheduled", dueAt: later, draftVersion: 1, version: a.version + 1 });
  expect((await wakes(a.id)).map((d) => d.getTime())).toContain(later.getTime());
});

test("re-dating never pulls a send earlier or into the past, and a draft has no time to change", async () => {
  const { action } = await draft("redate-draft");
  await ledger.submitForApproval(W, action.id, person);
  const due = new Date(clock.at.getTime() + 5 * 86_400_000);
  await ledger.approve(W, action.id, { approverId: approver, draftVersion: 1, snapshot: [], dueAt: due });
  expect(await ledger.redateAction(W, action.id, new Date(due.getTime() - 86_400_000), person)).toEqual({ ok: false, reason: "not_later" });
  expect(await ledger.redateAction(W, action.id, new Date(clock.at.getTime() - 1), person)).toEqual({ ok: false, reason: "not_later" });
  const d = await draft("redate-draft-2");
  expect(await ledger.redateAction(W, d.action.id, due, person)).toEqual({ ok: false, reason: "wrong_state" });
  const c = await approved("redate-cancelled");
  await ledger.cancel(W, c.id, person);
  expect(await ledger.redateAction(W, c.id, due, person)).toEqual({ ok: false, reason: "wrong_state" });
});

test("triage changes nothing a claim depends on", async () => {
  const a = await approved("triage");
  const until = new Date("2026-11-05T09:00:00Z");
  expect(await ledger.setTriage(W, a.id, { snoozedUntil: until })).toBe(true);
  const row = await ledger.getAction(W, a.id);
  expect(row).toMatchObject({ snoozedUntil: until, version: a.version, state: "scheduled" });
  expect(await ledger.getEvents(W, a.id)).toHaveLength(3);
  await ledger.setTriage(W, a.id, { snoozedUntil: null, decideBy: until });
  expect(await ledger.getAction(W, a.id)).toMatchObject({ snoozedUntil: null, decideBy: until });
  expect(await ledger.setTriage(W, crypto.randomUUID(), { decideBy: until })).toBe(false);
});
