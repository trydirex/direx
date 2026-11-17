// SPDX-License-Identifier: AGPL-3.0-only
import { expect, test } from "vitest";
import { createPerson } from "../people";
import { reserveTouch } from "./index";
import { EMAIL, approveFor, fakeEffect, person, scheduleLedger, touchAction } from "./fixtures/schedule";

const W = crypto.randomUUID();
const DAY = 24 * 60 * 60 * 1000;
const T0 = new Date("2026-11-02T09:00:00Z").getTime();
const at = (days: number) => new Date(T0 + days * DAY);

const email = fakeEffect("blind", { reachesPerson: true });
const post = fakeEffect("blind", { reachesPerson: false });
const { ledger, clock } = await scheduleLedger({ [EMAIL]: email.capability, "test.post": post.capability });

const stateOf = async (id: string) => {
  const a = (await ledger.getAction(W, id))!;
  return { state: a.state, reason: a.holdReason ?? a.blockReason };
};

test("a cold Touch with no reservation is held with reason cap; with one it is sent", async () => {
  const p = await createPerson(W);
  const bare = await touchAction(ledger, W, p, "cold");
  await approveFor(ledger, W, bare, at(0));
  const reserved = await touchAction(ledger, W, p, "cold");
  expect((await reserveTouch(W, reserved, at(5), { now: at(-1) })).kind).toBe("reserved");
  await approveFor(ledger, W, reserved, at(5));

  clock.at = at(0);
  await ledger.run(W, bare);
  expect(await stateOf(bare)).toEqual({ state: "held", reason: "cap" });
  clock.at = at(5);
  const before = email.calls.length;
  await ledger.run(W, reserved);
  expect(await stateOf(reserved)).toMatchObject({ state: "sent" });
  expect(email.calls.length).toBe(before + 1);
});

test("a reservation for another slot, or one that expired before dispatch, holds the Touch", async () => {
  const p = await createPerson(W);
  const moved = await touchAction(ledger, W, p, "cold");
  await reserveTouch(W, moved, at(20), { now: at(-1) });
  await approveFor(ledger, W, moved, at(21));
  clock.at = at(21);
  await ledger.run(W, moved);
  expect(await stateOf(moved)).toEqual({ state: "held", reason: "cap" });

  const late = await touchAction(ledger, W, p, "cold");
  await reserveTouch(W, late, at(30), { now: at(-1) });
  await approveFor(ledger, W, late, at(30));
  // The worker only gets to it 25 hours after its slot.
  clock.at = new Date(at(31).getTime() + 60 * 60 * 1000);
  await ledger.run(W, late);
  // More than a day past its time, lateness is said before the expired reservation.
  expect(await stateOf(late)).toEqual({ state: "held", reason: "late" });
});

test("a held Touch resumes only after it reserves a new slot, and stays held when the cap is full", async () => {
  const p = await createPerson(W);
  const id = await touchAction(ledger, W, p, "cold");
  await approveFor(ledger, W, id, at(40));
  clock.at = at(40);
  await ledger.run(W, id);
  expect(await stateOf(id)).toEqual({ state: "held", reason: "cap" });

  // Someone else took day 41 meanwhile.
  const other = await touchAction(ledger, W, p, "cold");
  expect((await reserveTouch(W, other, at(41), { now: at(40) })).kind).toBe("reserved");
  expect(await reserveTouch(W, id, at(42), { now: at(40) })).toEqual({ kind: "full", cap: "general" });
  await ledger.resume(W, id, person, { dueAt: at(42) });
  clock.at = at(42);
  await ledger.run(W, id);
  expect(await stateOf(id)).toEqual({ state: "held", reason: "cap" });

  expect((await reserveTouch(W, id, at(44), { now: at(42) })).kind).toBe("reserved");
  await ledger.resume(W, id, person, { dueAt: at(44) });
  clock.at = at(44);
  await ledger.run(W, id);
  expect(await stateOf(id)).toMatchObject({ state: "sent" });
});

test("an effect that reaches a Person is blocked without a Touch in its spec; one that doesn't passes", async () => {
  const create = (capability: string) =>
    ledger.createAction(W, { idempotencyKey: crypto.randomUUID(), capability, dedupe: "blind", spec: { to: "x" }, actor: person });
  const { action: mail } = await create(EMAIL);
  const { action: social } = await create("test.post");
  await approveFor(ledger, W, mail.id, at(50));
  await approveFor(ledger, W, social.id, at(50));
  clock.at = at(50);
  await ledger.run(W, mail.id);
  await ledger.run(W, social.id);
  expect(await stateOf(mail.id)).toEqual({ state: "blocked", reason: "touch_undeclared" });
  expect(await stateOf(social.id)).toMatchObject({ state: "sent" });
});

test("service mail needs no reservation", async () => {
  const p = await createPerson(W);
  const id = await touchAction(ledger, W, p, "service");
  await approveFor(ledger, W, id, at(60));
  clock.at = at(60);
  await ledger.run(W, id);
  expect(await stateOf(id)).toMatchObject({ state: "sent" });
});
