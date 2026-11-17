// SPDX-License-Identifier: AGPL-3.0-only
// The review feed's read: the Needs you count and its next deadline, through a real ledger.
import { expect, test } from "vitest";
import { APPROVAL_TTL_MS } from "../ledger/index";
import { itemsWorld } from "./fixtures/items";

test("an empty queue has nothing waiting and no deadline", async () => {
  const w = await itemsWorld();
  await w.newPost();
  expect(await w.items.waitingSummary(w.W)).toEqual({ count: 0, nextDeadline: null });
});

test("the count matches Needs you, and the deadline is the earliest decide-by or approval expiry", async () => {
  const w = await itemsWorld();
  const asked = w.clock.at;
  const a = await w.submit(await w.newPost());
  await w.submit(await w.newPost());
  const approved = await w.submit(await w.newPost());
  await w.items.approve(w.W, approved.id, 1, w.who);
  const listed = await w.items.list(w.W, { needsYou: true, offset: 0, limit: 100 });

  const plain = await w.items.waitingSummary(w.W);
  expect(plain.count).toBe(2);
  expect(plain.count).toBe(listed.needsYouCount);
  expect(plain.nextDeadline).toEqual(new Date(asked.getTime() + APPROVAL_TTL_MS));

  await w.items.setTriage(w.W, a.id, { decideBy: w.hours(3) });
  expect((await w.items.waitingSummary(w.W)).nextDeadline).toEqual(w.hours(3));
});

test("a snoozed Item leaves the count, and another Workspace's Items are never counted", async () => {
  const w = await itemsWorld();
  const other = await itemsWorld();
  const a = await w.submit(await w.newPost());
  await w.submit(await w.newPost());
  await other.submit(await other.newPost());
  await w.items.setTriage(w.W, a.id, { snoozedUntil: w.hours(1) });
  expect((await w.items.waitingSummary(w.W)).count).toBe(1);
  expect((await other.items.waitingSummary(other.W)).count).toBe(1);
});

test("waitingAmong counts which of the given Items still wait for a person", async () => {
  const w = await itemsWorld({ kinds: { fact_edit: { permission: "item.approve", apply: async () => ({ ok: true }) } } });
  const make = async (state?: "draft") => {
    const r = await w.items.createItem(w.W, { kind: "fact_edit", payload: {}, actor: { system: "external_token:t" }, details: { title: "From outside", warnings: [] }, ...(state && { state }) });
    if (!r.ok) throw new Error(r.reason);
    return r.item;
  };
  const [a, b, drafted, done] = [await make(), await make(), await make("draft"), await make()];
  const decided = await w.items.approve(w.W, done.id, done.revision, w.who);
  expect(decided.ok).toBe(true);
  expect(await w.items.waitingAmong(w.W, [a.id, b.id, drafted.id, done.id, crypto.randomUUID()])).toBe(3);
  expect(await w.items.waitingAmong(w.W, [])).toBe(0);
  const other = await itemsWorld();
  expect(await other.items.waitingAmong(other.W, [a.id, b.id])).toBe(0);
});
