// SPDX-License-Identifier: AGPL-3.0-only
import { expect, test } from "vitest";
import { appClient } from "../../../../../test/db";
import { addKey, createPerson } from "../people";
import { reserveTouch } from "./index";
import { approveFor, person, scheduleLedger, touchAction } from "./fixtures/schedule";

const W = crypto.randomUUID();
const DAY = 24 * 60 * 60 * 1000;
const T0 = new Date("2026-11-02T09:00:00Z").getTime();
const at = (days: number) => new Date(T0 + days * DAY);
const { ledger, clock } = await scheduleLedger();

/** Reserves a new cold (or other) Touch for p at day d, as seen at day `now`. */
async function reserve(p: string, d: number, touchClass: Parameters<typeof touchAction>[3] = "cold", now = -1) {
  const id = await touchAction(ledger, W, p, touchClass);
  return { id, r: await reserveTouch(W, id, at(d), { now: at(now) }) };
}

test("a cold Touch within 3 days of another, before or after it, is refused; 3 days apart fits", async () => {
  const p = await createPerson(W);
  expect((await reserve(p, 10)).r.kind).toBe("reserved");
  expect((await reserve(p, 12)).r).toEqual({ kind: "full", cap: "general" });
  expect((await reserve(p, 8)).r).toEqual({ kind: "full", cap: "general" });
  expect((await reserve(p, 13)).r.kind).toBe("reserved");
  expect((await reserve(p, 7)).r.kind).toBe("reserved");
});

test("a sixth cold Touch in any rolling 30 days is refused, even when the others lie after it", async () => {
  const p = await createPerson(W);
  for (const d of [4, 8, 12, 16, 20]) expect((await reserve(p, d)).r.kind).toBe("reserved");
  expect((await reserve(p, 0)).r).toEqual({ kind: "full", cap: "general" });
  expect((await reserve(p, 24)).r).toEqual({ kind: "full", cap: "general" });
  expect((await reserve(p, 34)).r.kind).toBe("reserved");
});

test("consented marketing reserves against both caps at once, or neither", async () => {
  const p = await createPerson(W);
  const ok = await reserve(p, 0, "consented_marketing");
  expect(ok.r).toMatchObject({ kind: "reserved", reservationIds: [expect.any(String), expect.any(String)] });
  // Day 2 fits the consented-marketing gap but not the general one.
  const refused = await reserve(p, 2, "consented_marketing");
  expect(refused.r).toEqual({ kind: "full", cap: "general" });
  const c = await appClient();
  await c.query("select set_config('app.workspace_id', $1, false)", [W]);
  const { rows } = await c.query("select count(*)::int n from touch_reservations where action_id = $1", [refused.id]);
  await c.end();
  expect(rows[0].n).toBe(0);
});

test("replies in thread, service and transactional mail reserve nothing", async () => {
  const p = await createPerson(W);
  await reserve(p, 0);
  for (const cls of ["reply_in_thread", "service", "transactional"] as const) {
    expect((await reserve(p, 0, cls)).r).toEqual({ kind: "not_counted" });
  }
});

test("a cancelled Touch frees its slot, and so does one still unsent 24 hours past its slot", async () => {
  const p = await createPerson(W);
  const first = await reserve(p, 0);
  expect((await reserve(p, 1)).r.kind).toBe("full");
  await ledger.cancel(W, first.id, person);
  expect((await reserve(p, 1)).r.kind).toBe("reserved");

  const q = await createPerson(W);
  await reserve(q, 0);
  expect((await reserve(q, 1, "cold", 0.9)).r.kind).toBe("full");
  expect((await reserve(q, 2, "cold", 1.1)).r.kind).toBe("reserved");
});

test("only an Action's newest reservation counts, and reserving the same slot twice returns the same rows", async () => {
  const p = await createPerson(W);
  const a = await reserve(p, 0);
  const again = await reserveTouch(W, a.id, at(0), { now: at(-1) });
  expect(again).toEqual(a.r);
  expect((await reserveTouch(W, a.id, at(10), { now: at(-1) })).kind).toBe("reserved");
  expect((await reserve(p, 1)).r.kind).toBe("reserved");
});

test("an Action moved more than 30 days away no longer holds its old slot", async () => {
  const p = await createPerson(W);
  const moved = await reserve(p, 0);
  expect((await reserveTouch(W, moved.id, at(40), { now: at(-1) })).kind).toBe("reserved");
  expect((await reserve(p, 1)).r.kind).toBe("reserved");
});

test("a Touch whose class changed reserves the same slot again, so the Dispatcher can match it", async () => {
  const p = await createPerson(W);
  const { id, r } = await reserve(p, 0);
  const c = await appClient();
  try {
    await c.query("begin");
    await c.query("select set_config('app.workspace_id', $1, true)", [W]);
    await c.query("update actions set spec = jsonb_set(spec, '{touch,touchClass}', '\"sales_follow_up\"') where id = $1", [id]);
    await c.query("commit");
  } finally {
    await c.end();
  }
  const again = await reserveTouch(W, id, at(0), { now: at(-1) });
  expect(again.kind).toBe("reserved");
  expect(again).not.toEqual(r);
});

test("records in one Person group share one schedule", async () => {
  const [a, b] = [await createPerson(W), await createPerson(W)];
  await addKey(W, a, "email", "group@example.com");
  await addKey(W, b, "email", "group@example.com");
  await reserve(a, 0);
  expect((await reserve(b, 1)).r).toEqual({ kind: "full", cap: "general" });
});

test("an Action that doesn't name its Person can't reserve", async () => {
  const { action } = await ledger.createAction(W, {
    idempotencyKey: crypto.randomUUID(),
    capability: "test.email",
    dedupe: "blind",
    spec: { to: "dana@example.com", touch: { personId: "nope", touchClass: "cold" } },
    actor: person,
  });
  expect(await reserveTouch(W, action.id, at(0))).toEqual({ kind: "undeclared" });
});

test("the Dispatcher's check never waits on a Person group lock", async () => {
  const p = await createPerson(W);
  const id = await touchAction(ledger, W, p, "cold");
  expect((await reserveTouch(W, id, at(0), { now: at(-1) })).kind).toBe("reserved");
  await approveFor(ledger, W, id, at(0));
  clock.at = at(0);
  const c = await appClient();
  await c.query("begin");
  await c.query("select set_config('app.workspace_id', $1, true)", [W]);
  await c.query("select id from people where id = $1 for no key update", [p]);
  try {
    const done = await Promise.race([ledger.run(W, id).then(() => "ran"), new Promise((res) => setTimeout(() => res("waited"), 2_000))]);
    expect(done).toBe("ran");
  } finally {
    await c.query("rollback");
    await c.end();
  }
});
