// SPDX-License-Identifier: AGPL-3.0-only
// Touches Direx didn't send: they hold the cold gap at reservation and again at dispatch.
import { expect, test } from "vitest";
import { seedMember } from "../identity/fixtures/member";
import { inWorkspace } from "./adapters/schedule-repo";
import { addKey, createPerson } from "../people";
import { direxTouchNear, recordOutsideTouch, reserveTouch } from "./index";
import { approveFor, approver, person, scheduleLedger, touchAction } from "./fixtures/schedule";

const W = crypto.randomUUID();
const DAY = 24 * 60 * 60 * 1000;
const T0 = new Date("2026-11-02T09:00:00Z").getTime();
const at = (days: number) => new Date(T0 + days * DAY);
const { ledger, clock } = await scheduleLedger();

await seedMember(W, approver);

const logTouch = (personId: string, day: number, direction: "outbound" | "inbound" = "outbound") =>
  inWorkspace(W, (tx) =>
    recordOutsideTouch(tx, { workspaceId: W, personId, channel: "call", direction, occurredAt: at(day), source: "manual", sourceRef: null, createdBy: person.userId, createdAt: new Date() }),
  );

async function reserve(p: string, d: number, touchClass: Parameters<typeof touchAction>[3] = "cold") {
  const id = await touchAction(ledger, W, p, touchClass);
  return { id, r: await reserveTouch(W, id, at(d), { now: at(-10) }) };
}

const stateOf = async (id: string) => {
  const a = (await ledger.getAction(W, id))!;
  return { state: a.state, reason: a.holdReason ?? a.blockReason };
};

test("a logged call holds a cold Touch within 3 days either side; 3 days away fits", async () => {
  const p = await createPerson(W);
  await logTouch(p, 0);
  expect((await reserve(p, 2)).r).toEqual({ kind: "full", cap: "general" });
  expect((await reserve(p, -2)).r).toEqual({ kind: "full", cap: "general" });
  expect((await reserve(p, 3)).r.kind).toBe("reserved");
});

test("touches Direx didn't send never use up the 5 in 30 days", async () => {
  const p = await createPerson(W);
  for (const d of [-27, -21, -15, -9, -3]) await logTouch(p, d);
  for (const d of [0, 4, 8, 12, 16]) expect((await reserve(p, d)).r.kind).toBe("reserved");
});

test("a touch on another record of the group holds the gap; a logged reply doesn't", async () => {
  const [a, b] = [await createPerson(W), await createPerson(W)];
  await addKey(W, a, "email", "outside-group@example.com");
  await addKey(W, b, "email", "outside-group@example.com");
  await logTouch(a, 0);
  expect((await reserve(b, 1)).r).toEqual({ kind: "full", cap: "general" });
  const c = await createPerson(W);
  await logTouch(c, 0, "inbound");
  expect((await reserve(c, 1)).r.kind).toBe("reserved");
});

test("consented marketing isn't held by a touch Direx didn't send", async () => {
  const p = await createPerson(W);
  await logTouch(p, 0);
  expect((await reserve(p, 1, "consented_marketing")).r.kind).toBe("reserved");
});

test("a call logged after the reservation holds the Touch at dispatch; one 3 days off doesn't", async () => {
  const p = await createPerson(W);
  const { id } = await reserve(p, 5);
  await approveFor(ledger, W, id, at(5));
  await logTouch(p, 4);
  clock.at = at(5);
  await ledger.run(W, id);
  expect(await stateOf(id)).toEqual({ state: "held", reason: "cap" });

  const q = await createPerson(W);
  const ok = await reserve(q, 5);
  await approveFor(ledger, W, ok.id, at(5));
  await logTouch(q, 2);
  await ledger.run(W, ok.id);
  expect(await stateOf(ok.id)).toMatchObject({ state: "sent" });
});

test("a hand-sent DM is warned about a Direx email within 3 days of it, and not one further off", async () => {
  const p = await createPerson(W);
  await reserve(p, 10);
  expect(await direxTouchNear(W, p, at(8))).toBe(true);
  // An unsent one counts until 24 hours past its slot, as for a reservation.
  expect(await direxTouchNear(W, p, at(10.5))).toBe(true);
  expect(await direxTouchNear(W, p, at(7))).toBe(false);
  expect(await direxTouchNear(W, await createPerson(W), at(10))).toBe(false);
});

test("logging and reserving at the same moment never lets a Touch out inside the gap", async () => {
  for (let i = 0; i < 10; i++) {
    // Approved when it's reserved, not after the slot has long gone.
    clock.at = at(-10);
    const p = await createPerson(W);
    const id = await touchAction(ledger, W, p, "cold");
    const [r] = await Promise.all([reserveTouch(W, id, at(1), { now: at(-10) }), logTouch(p, 0)]);
    if (r.kind !== "reserved") {
      expect(r).toEqual({ kind: "full", cap: "general" });
      continue;
    }
    await approveFor(ledger, W, id, at(1));
    clock.at = at(1);
    await ledger.run(W, id);
    expect(await stateOf(id)).toEqual({ state: "held", reason: "cap" });
  }
});
