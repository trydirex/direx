// SPDX-License-Identifier: AGPL-3.0-only
// Moving an Item, through a real ledger, Dispatcher and schedule.
import { expect, test } from "vitest";
import type { MoveStep } from "./index";
import { actionIdOf as idIn, itemsWorld, person } from "./fixtures/items";

const crash: { at?: MoveStep } = {};
const w = await itemsWorld({
  onMoveStep: (s) => {
    if (crash.at === s) {
      crash.at = undefined;
      throw new Error(`simulated crash after ${s}`);
    }
  },
});
const { W, items, ledger, clock, hours, newPost, newTouch, newPerson, submit, who, email, post } = w;

const actionIdOf = (id: string) => idIn(W, id);
const approved = async (plannedAt: Date) => {
  const i = await submit(await newPost({ plannedAt }));
  expect((await items.approve(W, i.id, 1, who)).ok).toBe(true);
  return i;
};

test("moving a Scheduled Action returns the same Action to Needs approval at the new time", async () => {
  const i = await approved(hours(5));
  const before = await actionIdOf(i.id);
  const r = await items.moveItem(W, i.id, hours(9), person);
  expect(r.ok && r.item).toMatchObject({ state: "needs_approval", at: hours(9), revision: 1 });
  expect(await actionIdOf(i.id)).toBe(before);
});

test("the wake for the old time sends nothing, whether the move was later or earlier", async () => {
  const calls = post.calls.length;
  const start = clock.at;
  const later = await approved(hours(5));
  await items.moveItem(W, later.id, hours(30), person);
  expect((await items.approve(W, later.id, 1, who)).ok).toBe(true);
  clock.at = hours(5);
  await ledger.run(W, await actionIdOf(later.id));
  expect((await items.view(W, later.id))!.state).toBe("scheduled");
  expect(post.calls.length).toBe(calls);
  clock.at = start;
  const earlier = await approved(hours(30));
  await items.moveItem(W, earlier.id, hours(5), person);
  await ledger.run(W, await actionIdOf(earlier.id));
  expect((await items.view(W, earlier.id))!.state).toBe("needs_approval");
  expect(post.calls.length).toBe(calls);
});

test("a move to a full slot changes nothing, and a past time is refused", async () => {
  const p = await newPerson();
  const first = await submit(await newTouch(p, hours(24)));
  await items.approve(W, first.id, 1, who);
  const second = await submit(await newTouch(p, hours(24 * 10)));
  await items.approve(W, second.id, 1, who);
  expect(await items.moveItem(W, second.id, hours(25), person)).toEqual({ ok: false, reason: "slot_full", cap: "general" });
  expect((await items.view(W, second.id))!).toMatchObject({ state: "scheduled", at: hours(24 * 10) });
  expect(await items.moveItem(W, second.id, hours(-1), person)).toEqual({ ok: false, reason: "slot_in_past" });
});

test("an unknown outcome, or a finished Item, refuses to move", async () => {
  const hung = await itemsWorld({ postSteps: { steps: ["throw"] } });
  const i = await hung.submit(await hung.newPost());
  await hung.items.approve(hung.W, i.id, 1, hung.who);
  await hung.ledger.run(hung.W, await idIn(hung.W, i.id));
  expect(await hung.items.view(hung.W, i.id)).toMatchObject({ state: "held", reasonCode: "outcome_unknown", movable: false });
  expect(await hung.items.moveItem(hung.W, i.id, hung.hours(9), person)).toEqual({ ok: false, reason: "outcome_unknown" });
  const gone = await newPost();
  await items.cancel(W, gone.id, person);
  expect(await items.moveItem(W, gone.id, hours(9), person)).toEqual({ ok: false, reason: "wrong_state" });
});

test("a crash after reserving never sends at the old time, and repeating the move finishes it", async () => {
  const p = await newPerson();
  const before = email.calls.length;
  const i = await submit(await newTouch(p, hours(2)));
  await items.approve(W, i.id, 1, who);
  crash.at = "reserved";
  await expect(items.moveItem(W, i.id, hours(100), person)).rejects.toThrow("simulated crash");
  const start = clock.at;
  clock.at = hours(2);
  const id = await actionIdOf(i.id);
  await ledger.run(W, id);
  expect(email.calls.length).toBe(before);
  expect(await items.view(W, i.id)).toMatchObject({ state: "held", reasonCode: "cap" });
  clock.at = start;
  const r = await items.moveItem(W, i.id, hours(100), person);
  expect(r.ok && r.item).toMatchObject({ state: "needs_approval", at: hours(100) });
});

test("moving away and back to the same slot still goes out", async () => {
  const p = await newPerson();
  const i = await submit(await newTouch(p, hours(24 * 20)));
  await items.moveItem(W, i.id, hours(24 * 30), person);
  await new Promise((r) => setTimeout(r, 2));
  await items.moveItem(W, i.id, hours(24 * 20), person);
  await new Promise((r) => setTimeout(r, 2));
  expect((await items.approve(W, i.id, 1, who)).ok).toBe(true);
  const before = email.calls.length;
  const start = clock.at;
  clock.at = hours(24 * 20);
  await ledger.run(W, await actionIdOf(i.id));
  expect((await items.view(W, i.id))!.state).toBe("sent");
  expect(email.calls.length).toBe(before + 1);
  clock.at = start;
});

test("moving a group moves what fits and reports each result", async () => {
  const p = await newPerson();
  const blocker = await submit(await newTouch(p, hours(24 * 40)));
  await items.approve(W, blocker.id, 1, who);
  const fits = await newPost({ plannedAt: hours(3) });
  const full = await submit(await newTouch(p, hours(24 * 60)));
  await items.approve(W, full.id, 1, who);
  const r = await items.moveItems(W, [{ id: fits.id, plannedAt: hours(24 * 40) }, { id: full.id, plannedAt: hours(24 * 40) }], person);
  expect(r.map((x) => (x.result.ok ? true : x.result.reason))).toEqual([true, "slot_full"]);
});

test("re-dating later for a launch keeps the approval and sends at the new time; earlier needs a new one", async () => {
  const start = clock.at;
  const calls = post.calls.length;
  const later = await approved(hours(5));
  expect(await items.redateItem(W, later.id, hours(30), person)).toEqual({ ok: true, kept: true, backToApproval: false, overCap: false });
  expect((await items.view(W, later.id))!).toMatchObject({ state: "scheduled", at: hours(30) });
  clock.at = hours(5);
  await ledger.run(W, await actionIdOf(later.id));
  expect(post.calls.length).toBe(calls);
  clock.at = hours(30);
  try {
    await ledger.run(W, await actionIdOf(later.id));
  } finally {
    clock.at = start;
  }
  expect(post.calls.length).toBe(calls + 1);

  const earlier = await approved(hours(30));
  expect(await items.redateItem(W, earlier.id, hours(6), person)).toEqual({ ok: true, kept: false, backToApproval: true, overCap: false });
  expect((await items.view(W, earlier.id))!).toMatchObject({ state: "needs_approval", at: hours(6) });
});

test("a re-dated Touch over its cap still moves, says so, and is held with cap when its time comes", async () => {
  const start = clock.at;
  const p = await newPerson();
  const first = await submit(await newTouch(p, hours(48)));
  await items.approve(W, first.id, 1, who);
  const second = await submit(await newTouch(p, hours(24 * 10)));
  await items.approve(W, second.id, 1, who);
  expect(await items.redateItem(W, second.id, hours(24 * 10 + 1), person)).toMatchObject({ ok: true, kept: true, overCap: false });
  // Moving the first next to the second puts it inside the gap.
  expect(await items.redateItem(W, first.id, hours(24 * 10 - 2), person)).toEqual({ ok: true, kept: true, backToApproval: false, overCap: true });
  clock.at = hours(24 * 10 - 2);
  try {
    await ledger.run(W, await actionIdOf(first.id));
  } finally {
    clock.at = start;
  }
  expect((await ledger.getAction(W, await actionIdOf(first.id)))!).toMatchObject({ state: "held", holdReason: "cap" });
});

test("an Item not yet approved just takes the new time, and a past time or an unknown outcome is refused", async () => {
  const i = await submit(await newPost({ plannedAt: hours(5) }));
  expect(await items.redateItem(W, i.id, hours(50), person)).toEqual({ ok: true, kept: false, backToApproval: false, overCap: false });
  expect((await items.view(W, i.id))!).toMatchObject({ state: "needs_approval", at: hours(50) });
  expect(await items.redateItem(W, i.id, hours(-1), person)).toEqual({ ok: false, reason: "slot_in_past" });
  expect(await items.redateItem(W, crypto.randomUUID(), hours(50), person)).toEqual({ ok: false, reason: "not_found" });
});
