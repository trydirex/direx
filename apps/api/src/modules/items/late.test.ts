// SPDX-License-Identifier: AGPL-3.0-only
// Sends more than a day past their approved time wait for a person, who sends them at the next free
// slot; one Workspace notice counts them and resumes the emails together.
import { expect, test } from "vitest";
import type { EffectCapability } from "@direx/plugin-sdk";
import { seedMember } from "../identity/fixtures/member";
import { createPerson } from "../people";
import { touchCheck } from "../schedule/index";
import { fakeEffect, person, testLedger } from "../ledger/test-effects";
import { createItems } from "./index";

const EMAIL = "test.email";
const POST = "test.post";
const email = fakeEffect("blind", { reachesPerson: true });
const post = fakeEffect("blind");
const effects: Record<string, EffectCapability> = { [EMAIL]: email.capability, [POST]: post.capability };
const clock = { at: new Date("2026-11-02T09:00:00Z") };
const { ledger } = await testLedger({ effects, checks: [touchCheck({ effects, now: () => clock.at })], now: () => clock.at, onLateChanged: (tx, ws) => items.refreshLateIn(tx, ws) });
const items = createItems({ ledger, now: () => clock.at });
const who = { approverId: person.userId as never, may: () => true, steppedUp: true };
const hours = (h: number) => new Date(clock.at.getTime() + h * 3_600_000);

async function world() {
  const W = crypto.randomUUID();
  await seedMember(W, person.userId);
  return W;
}
/** An approved email to a new Person, or a post, due at `due`. */
async function approved(W: string, kind: "email" | "post", due: Date) {
  const personId = kind === "email" ? await createPerson(W) : null;
  const item = await items.createActionItem(W, {
    idempotencyKey: crypto.randomUUID(),
    capability: kind === "email" ? EMAIL : POST,
    dedupe: "blind",
    spec: personId ? { to: "dana@example.com", body: "hi", touch: { personId, touchClass: "cold" } } : { body: "hi" },
    actor: person,
    details: { title: kind, warnings: [], plannedAt: due },
  });
  const submitted = await items.submitItem(W, item.id, person);
  if (!submitted.ok) throw new Error(submitted.reason);
  const r = await items.approve(W, item.id, submitted.item.revision, who);
  if (!r.ok) throw new Error(r.reason);
  return { itemId: item.id, actionId: (await items.actionIdOf(W, item.id))! };
}
const notice = async (W: string) => (await items.list(W, { needsYou: true, offset: 0, limit: 100 })).items.filter((i) => i.kind === "late_sends");
const stateOf = async (W: string, actionId: string) => (await ledger.getAction(W, actionId))!;

test("more than a day late, an email and a post wait; the notice sends the email at a free slot, and the post goes one by one", async () => {
  const W = await world();
  const start = clock.at;
  const due = hours(2);
  const e = await approved(W, "email", due);
  const p = await approved(W, "post", due);
  const sentBefore = email.calls.length;

  // Past 24 hours after its time it waits for a person.
  clock.at = new Date(due.getTime() + 86_400_000 + 1);
  await ledger.run(W, e.actionId);
  await ledger.run(W, p.actionId);
  expect(await stateOf(W, e.actionId)).toMatchObject({ state: "held", holdReason: "late", nextAttemptAt: null });
  expect(await stateOf(W, p.actionId)).toMatchObject({ state: "held", holdReason: "late" });
  expect(email.calls.length).toBe(sentBefore);
  const [n] = await notice(W);
  expect(n!.title).toContain("1 email and 1 post");

  // No automatic path sends it at its old time.
  expect(await ledger.resume(W, e.actionId, { system: "test" })).toEqual({ ok: false, reason: "late_needs_time" });

  expect(await items.approve(W, n!.id, n!.revision, { ...who, steppedUp: false })).toEqual({ ok: false, reason: "step_up_required" });
  expect(await items.approve(W, n!.id, n!.revision, who)).toMatchObject({ ok: true });
  const resumed = await stateOf(W, e.actionId);
  expect(resumed.state).toBe("scheduled");
  expect(resumed.dueAt!.getTime()).toBeGreaterThanOrEqual(clock.at.getTime());
  // The Touch check passes only on the slot the resume reserved.
  clock.at = resumed.dueAt!;
  await ledger.run(W, e.actionId);
  expect((await stateOf(W, e.actionId)).state).toBe("sent");
  expect(await stateOf(W, p.actionId)).toMatchObject({ state: "held", holdReason: "late" });
  const [left] = await notice(W);
  expect(left!.title).toContain("1 post");
  expect(left!.title).not.toContain("email");

  expect(await items.resume(W, p.itemId, person)).toMatchObject({ ok: true });
  await ledger.run(W, p.actionId);
  expect((await stateOf(W, p.actionId)).state).toBe("sent");
  expect(await notice(W)).toEqual([]);
  clock.at = start;
});

test("a person moving a late email asks for its approval at the new time, and a time already more than a day gone can't be approved", async () => {
  const W = await world();
  const start = clock.at;
  const due = hours(2);
  const e = await approved(W, "email", due);
  const other = await approved(W, "email", due);
  clock.at = new Date(due.getTime() + 2 * 86_400_000);
  await ledger.run(W, e.actionId);
  await ledger.run(W, other.actionId);
  expect((await stateOf(W, e.actionId)).holdReason).toBe("late");
  const later = hours(3);
  expect(await items.moveItem(W, e.itemId, later, person)).toMatchObject({ ok: true });
  expect(await stateOf(W, e.actionId)).toMatchObject({ state: "needs_approval" });
  expect((await notice(W))[0]!.title).toContain("1 email");
  // A Campaign's launch moving it is no person's choice: it stays late.
  expect(await items.redateItem(W, other.itemId, hours(5), person)).toMatchObject({ ok: true });
  expect(await stateOf(W, other.actionId)).toMatchObject({ state: "held", holdReason: "late" });

  const { action } = await ledger.createAction(W, { idempotencyKey: crypto.randomUUID(), capability: POST, dedupe: "blind", spec: { body: "x" }, actor: person });
  await ledger.submitForApproval(W, action.id, person);
  expect(await ledger.approve(W, action.id, { approverId: person.userId as never, draftVersion: 1, snapshot: [], dueAt: hours(-25) })).toEqual({ ok: false, reason: "too_late" });
  clock.at = start;
});

test("a provider retry due after the limit is held at the dispatch check, and a late unknown outcome stays unknown until a person resends it at a free slot", async () => {
  const W = await world();
  const start = clock.at;
  const flaky = fakeEffect("blind", { steps: ["refused_retryable", "throw", "sent"] });
  effects["test.flaky"] = flaky.capability;
  const { action } = await ledger.createAction(W, { idempotencyKey: crypto.randomUUID(), capability: "test.flaky", dedupe: "blind", spec: { body: "x" }, actor: person });
  await ledger.submitForApproval(W, action.id, person);
  await ledger.approve(W, action.id, { approverId: person.userId as never, draftVersion: 1, snapshot: [] });
  await ledger.run(W, action.id);
  expect(await stateOf(W, action.id)).toMatchObject({ state: "held", holdReason: "provider_rejected" });
  // The retry comes round after the limit: it re-enters at Claimed and the dispatch check holds it.
  clock.at = new Date(start.getTime() + 86_400_000 + 60_000);
  await ledger.run(W, action.id);
  expect(await stateOf(W, action.id)).toMatchObject({ state: "held", holdReason: "late" });
  expect(flaky.calls).toHaveLength(1);

  // A late resend after an unknown outcome: the earlier call may have gone, so it stays unknown.
  clock.at = start;
  const unsure = fakeEffect("blind", { steps: ["throw", "sent"] });
  effects["test.unsure"] = unsure.capability;
  const made = await items.createActionItem(W, { idempotencyKey: crypto.randomUUID(), capability: "test.unsure", dedupe: "blind", spec: { body: "y" }, actor: person, details: { title: "y", warnings: [] } });
  const sub = await items.submitItem(W, made.id, person);
  await items.approve(W, made.id, sub.ok ? sub.item.revision : 0, who);
  const id = (await items.actionIdOf(W, made.id))!;
  await ledger.run(W, id);
  expect(await stateOf(W, id)).toMatchObject({ state: "held", holdReason: "outcome_unknown" });
  clock.at = new Date(start.getTime() + 2 * 86_400_000);
  expect(await ledger.resolveUnknown(W, id, "resend", person.userId)).toEqual({ ok: false, reason: "late_needs_time" });
  expect(await items.resolveUnknown(W, made.id, "resend", person.userId)).toMatchObject({ ok: true });
  expect((await stateOf(W, id)).dueAt!.getTime()).toBeGreaterThanOrEqual(clock.at.getTime());
  await ledger.run(W, id);
  expect((await stateOf(W, id)).state).toBe("sent");
  clock.at = start;
});
