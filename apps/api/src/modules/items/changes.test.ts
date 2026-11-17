// SPDX-License-Identifier: AGPL-3.0-only
// The changes feed the door's read_changes serves: an Item event is readable only once every older
// transaction has finished, in transaction order, so a late commit lands after a cursor, never
// behind it. Other test files share the database, and their open transactions hold events back too,
// so each test reads until what it waits for arrives: late is allowed, lost or repeated is not.
import { expect, test } from "vitest";
import { appClient } from "../../../../../test/db";
import { itemsWorld, person } from "./fixtures/items";
import type { Change } from "./index";

type Client = Awaited<ReturnType<typeof appClient>>;

const w = await itemsWorld({ kinds: { fact_edit: { permission: "item.approve", apply: async () => ({ ok: true }) } } });
const make = async () => {
  const r = await w.items.createItem(w.W, { kind: "fact_edit", payload: {}, actor: person, details: { title: "Add this?", warnings: [] } });
  if (!r.ok) throw new Error(r.reason);
  return r.item.id;
};
const ok = async (cursor: string | null, limit = 100) => {
  const r = await w.items.changes(w.W, cursor, limit);
  if (!r.ok) throw new Error(r.reason);
  return r;
};
/** Reads every page from `cursor` until `done` holds for what came, for at most five seconds. */
async function drain(cursor: string, done: (events: Change[]) => boolean) {
  const events: Change[] = [];
  let at = cursor;
  for (let i = 0; i < 100 && !done(events); i++) {
    const r = await ok(at);
    events.push(...r.events);
    at = r.cursor;
    if (!r.events.length) await new Promise((res) => setTimeout(res, 50));
  }
  return { events, cursor: at };
}
/** A cursor after the creation of `itemIds`, so a test sees only what it does next. */
async function after(start: string, ...itemIds: string[]) {
  return (await drain(start, (es) => itemIds.every((id) => es.some((e) => e.itemId === id)))).cursor;
}

async function openEvent(c: Client, itemId: string, to: string) {
  await c.query("begin");
  await c.query("select set_config('app.workspace_id', $1, true)", [w.W]);
  await c.query("insert into item_events (workspace_id, item_id, from_state, to_state, version, actor_system, at) values ($1, $2, 'needs_approval', $3, 2, 'test', now())", [w.W, itemId, to]);
}

test("no cursor gives no events and a cursor for now", async () => {
  const head = await ok(null);
  expect(head.events).toEqual([]);
  expect(head.more).toBe(false);
  const item = await make();
  expect((await drain(head.cursor, (es) => es.some((e) => e.itemId === item))).events.find((e) => e.itemId === item)).toMatchObject({ kind: "fact_edit", from: null });
});

test("a change committed late lands after the cursor, in transaction order, and none is skipped or repeated", async () => {
  const start = (await ok(null)).cursor;
  const [first, second] = [await make(), await make()];
  const cursor = await after(start, first, second);
  const a = await appClient();
  const b = await appClient();
  try {
    await openEvent(a, first, "scheduled");
    await openEvent(b, second, "rejected");
    await b.query("commit");
    // A is still open and older than B, so B waits for it.
    expect((await ok(cursor)).events).toEqual([]);
    await a.query("commit");
    const r = await drain(cursor, (es) => es.length >= 2);
    expect(r.events.map((e) => [e.itemId, e.from, e.to])).toEqual([
      [first, "needs_approval", "scheduled"],
      [second, "needs_approval", "rejected"],
    ]);
    expect((await ok(r.cursor)).events).toEqual([]);
  } finally {
    await a.end();
    await b.end();
  }
});

test("a note that changes no state isn't a change; a page of 100 says there is more", async () => {
  const start = (await ok(null)).cursor;
  const item = await make();
  const cursor = await after(start, item);
  const c = await appClient();
  try {
    await c.query("begin");
    await c.query("select set_config('app.workspace_id', $1, true)", [w.W]);
    await c.query("insert into item_events (workspace_id, item_id, from_state, to_state, version, actor_system, at) values ($1, $2, 'needs_approval', 'needs_approval', 2, 'test', now())", [w.W, item]);
    await c.query(
      "insert into item_events (workspace_id, item_id, from_state, to_state, version, actor_system, at) select $1, $2, 'needs_approval', 'scheduled', n, 'test', now() from generate_series(1, 101) n",
      [w.W, item],
    );
    await c.query("commit");
  } finally {
    await c.end();
  }
  let page = await ok(cursor);
  for (let i = 0; i < 100 && !page.events.length; i++) {
    await new Promise((res) => setTimeout(res, 50));
    page = await ok(cursor);
  }
  expect(page.events).toHaveLength(100);
  expect(page.events.every((e) => e.from !== e.to)).toBe(true);
  expect(page.more).toBe(true);
  const rest = await ok(page.cursor);
  expect(rest.events).toHaveLength(1);
  expect(rest.more).toBe(false);
});

test("a cursor that doesn't parse, or is ahead of now, is refused", async () => {
  for (const bad of ["", "nope", Buffer.from("1.x").toString("base64url"), Buffer.from("9.9.9").toString("base64url")]) expect(await w.items.changes(w.W, bad, 100)).toEqual({ ok: false, reason: "bad_cursor" });
  const ahead = Buffer.from(`${2n ** 62n}.1`).toString("base64url");
  expect(await w.items.changes(w.W, ahead, 100)).toEqual({ ok: false, reason: "bad_cursor" });
});
