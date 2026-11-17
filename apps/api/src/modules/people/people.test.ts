// SPDX-License-Identifier: AGPL-3.0-only
import { expect, test } from "vitest";
import { Moved } from "./application/people";
import { addKey, createPerson, groupOf, lockGroup, rejectLink, acceptLink, withGroupRetry } from "./index";

const W = crypto.randomUUID();
const USER = crypto.randomUUID();

test("a burst of moved groups is contention, so it keeps retrying past the lock timeout limit", async () => {
  let calls = 0;
  const result = await withGroupRetry(W, async () => {
    if (++calls <= 10) throw new Moved();
    return "finished";
  });
  expect(result).toBe("finished");
  expect(calls).toBe(11);
});

test("a lock timeout is retried 3 times and then throws", async () => {
  let calls = 0;
  const timeout = Object.assign(new Error("lock timeout"), { code: "55P03" });
  await expect(
    withGroupRetry(W, async () => {
      calls++;
      throw timeout;
    }),
  ).rejects.toBe(timeout);
  expect(calls).toBe(4);
});

test("a group that never stops moving still throws in the end", async () => {
  let calls = 0;
  await expect(
    withGroupRetry(W, async () => {
      calls++;
      throw new Moved();
    }),
  ).rejects.toBeInstanceOf(Moved);
  expect(calls).toBe(101);
}, 30_000);

test("a shared key proposes a merge and joins the groups under the lower id; both records stay", async () => {
  const [a, b] = [await createPerson(W), await createPerson(W)].sort();
  expect(await addKey(W, a!, "email", "dana@example.com")).toEqual({ ok: true, value: "dana@example.com", linkedTo: [] });
  expect(await addKey(W, b!, "email", "DANA@example.com")).toEqual({ ok: true, value: "dana@example.com", linkedTo: [a] });
  expect(await groupOf(W, b!)).toEqual({ groupId: a, members: [a, b] });
  expect(await groupOf(W, a!)).toEqual({ groupId: a, members: [a, b] });
});

test("a chain shares the lowest id; rejecting one link splits it, each part taking its lowest id", async () => {
  const [a, b, c] = [await createPerson(W), await createPerson(W), await createPerson(W)].sort();
  await addKey(W, a!, "phone", "+14155550101");
  await addKey(W, b!, "phone", "+1 415 555 0101");
  await addKey(W, b!, "hubspot", "h-1");
  await addKey(W, c!, "hubspot", "h-1");
  expect((await groupOf(W, c!)).groupId).toBe(a);

  expect(await rejectLink(W, a!, b!, USER)).toEqual({ ok: true });
  expect(await groupOf(W, a!)).toEqual({ groupId: a, members: [a] });
  expect(await groupOf(W, c!)).toEqual({ groupId: b, members: [b, c] });
  expect(await rejectLink(W, a!, b!, USER)).toEqual({ ok: false, reason: "wrong_state" });
});

test("accepting a merge keeps the group; undoing it later splits it", async () => {
  const [a, b] = [await createPerson(W), await createPerson(W)].sort();
  await addKey(W, a!, "shopify", "s-1");
  await addKey(W, b!, "shopify", "s-1");
  expect(await acceptLink(W, b!, a!, USER)).toEqual({ ok: true });
  expect(await acceptLink(W, a!, b!, USER)).toEqual({ ok: false, reason: "wrong_state" });
  expect((await groupOf(W, b!)).groupId).toBe(a);
  expect(await rejectLink(W, a!, b!, USER)).toEqual({ ok: true });
  expect((await groupOf(W, b!)).groupId).toBe(b);
});

test("a key that can't be normalised stores nothing and links nothing", async () => {
  const p = await createPerson(W);
  expect(await addKey(W, p, "phone", "555-0100")).toMatchObject({ ok: false });
  expect(await groupOf(W, p)).toEqual({ groupId: p, members: [p] });
});

test("a record in another workspace can't be locked, linked or seen", async () => {
  const V = crypto.randomUUID();
  const other = await createPerson(V);
  await expect(withGroupRetry(W, (tx) => lockGroup(tx, other))).rejects.toThrow(/not found/);
  await expect(addKey(W, other, "email", "x@example.com")).rejects.toThrow(/not found/);
  await expect(groupOf(W, other)).rejects.toThrow(/not found/);
  // The same key in two workspaces never links them.
  const mine = await createPerson(W);
  await addKey(V, other, "email", "same@example.com");
  expect(await addKey(W, mine, "email", "same@example.com")).toMatchObject({ ok: true, linkedTo: [] });
});
