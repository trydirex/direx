// SPDX-License-Identifier: AGPL-3.0-only
// 50 concurrent reservations on one Person, as the forced-RLS app role (through PgBouncer
// in transaction mode when DIREX_DB_POOL_URL is set): the cap is never breached, and a merge link that commits mid-run
// is respected.
import { afterAll, beforeAll, expect, test } from "vitest";
import { appClient, expectPgBouncer, hasPool, poolUrl } from "../../../../../test/db";
import { addKey, createPerson, groupOf } from "../people";
import { CAPS, reserveTouch, type ReserveResult } from "./index";

// Every withWorkspace in this file goes through the pool when one is configured (straight
// to Postgres otherwise), with enough connections that all 50 workers are in flight at
// once. Setup data uses a direct connection.
const direct = process.env.DIREX_DB_APP_URL!;
if (hasPool) process.env.DIREX_DB_APP_URL = poolUrl();
process.env.DIREX_DB_POOL_MAX = "60";

const W = crypto.randomUUID();
const DAY = 24 * 60 * 60 * 1000;
const T0 = new Date("2026-11-02T09:00:00Z").getTime();
const NOW = new Date(T0 - DAY);
let c: Awaited<ReturnType<typeof appClient>>;

beforeAll(async () => {
  if (hasPool) await expectPgBouncer(process.env.DIREX_DB_APP_URL!);
  c = await appClient(direct);
  await c.query("select set_config('app.workspace_id', $1, false)", [W]);
});
afterAll(() => c.end());

/** n draft cold Actions, the i-th reaching people[i % people.length]. */
async function coldActions(n: number, people: string[]): Promise<string[]> {
  const { rows } = await c.query(
    `insert into actions (workspace_id, idempotency_key, capability, dedupe_class, state, spec, spec_hash, created_at, updated_at)
     select $1, gen_random_uuid(), 'test.email', 'blind', 'draft',
            jsonb_build_object('touch', jsonb_build_object('personId', ($2::uuid[])[1 + (i % $3)], 'touchClass', 'cold')), 'h', now(), now()
     from generate_series(0, $4 - 1) i order by i returning id`,
    [W, people, people.length, n],
  );
  return rows.map((r) => r.id);
}

const reserveAll = (ids: string[], slotOf: (i: number) => Date) =>
  Promise.all(ids.map((id, i) => reserveTouch(W, id, slotOf(i), { now: NOW }).then((r) => ({ i, r }))));

const reservedSlots = (results: { i: number; r: ReserveResult }[], slotOf: (i: number) => Date) =>
  results.filter((x) => x.r.kind === "reserved").map((x) => slotOf(x.i).getTime()).sort((a, b) => a - b);

/** No two slots closer than the gap, and no 30-day window over the cap. */
function expectWithinCap(slots: number[]) {
  for (let i = 1; i < slots.length; i++) expect(slots[i]! - slots[i - 1]!).toBeGreaterThanOrEqual(CAPS.general.minGapMs);
  for (const s of slots) expect(slots.filter((t) => t >= s && t < s + 30 * DAY).length).toBeLessThanOrEqual(CAPS.general.per30Days);
}

const sameWeek = (i: number) => new Date(T0 + i * 60_000);
// 50 slots 0.6 days apart: any maximal set within the cap has exactly 5.
const spread = (i: number) => new Date(T0 + i * 0.6 * DAY);

test("50 workers reserving one Person in the same 3 days: exactly one succeeds", async () => {
  const p = await createPerson(W);
  const results = await reserveAll(await coldActions(50, [p]), sameWeek);
  expect(reservedSlots(results, sameWeek)).toHaveLength(1);
  expect(results.every((x) => x.r.kind === "reserved" || x.r.kind === "full")).toBe(true);
});

test("50 workers spread over 30 days: exactly 5 succeed, all at least 3 days apart", async () => {
  const p = await createPerson(W);
  const slots = reservedSlots(await reserveAll(await coldActions(50, [p]), spread), spread);
  expect(slots).toHaveLength(5);
  expectWithinCap(slots);
});

test("the same 50 split across two records of one Person group: the same totals", async () => {
  const [a, b] = [await createPerson(W), await createPerson(W)];
  await addKey(W, a, "email", "split@example.com");
  await addKey(W, b, "email", "split@example.com");
  expect(reservedSlots(await reserveAll(await coldActions(50, [a, b]), sameWeek), sameWeek)).toHaveLength(1);
  const later = (i: number) => spread(i + 100);
  const slots = reservedSlots(await reserveAll(await coldActions(50, [a, b]), later), later);
  expect(slots).toHaveLength(5);
  expectWithinCap(slots);
});

test("a link that commits mid-run: every reservation that started after it counted the whole group", async () => {
  const [a, b] = [await createPerson(W), await createPerson(W)];
  const ids = await coldActions(50, [a, b]);
  const slotOf = (i: number) => spread(i + 200);
  let committed = 0;
  let linkDone = Infinity;
  const linked = new Promise<void>((resolve) => {
    const tick = setInterval(() => {
      // Link once 10 reservations have come back, while the rest are still running.
      if (committed >= 10) {
        clearInterval(tick);
        void addKey(W, a, "email", "late@example.com")
          .then(() => addKey(W, b, "email", "late@example.com"))
          .then(() => {
            linkDone = performance.now();
            resolve();
          });
      }
    }, 1);
  });
  const results = await Promise.all(
    ids.map(async (id, i) => {
      const started = performance.now();
      const r = await reserveTouch(W, id, slotOf(i), { now: NOW });
      committed++;
      return { slot: slotOf(i).getTime(), started, ended: performance.now(), r };
    }),
  );
  await linked;
  expect((await groupOf(W, b)).members).toHaveLength(2);

  const won = results.filter((x) => x.r.kind === "reserved");
  for (const r of won.filter((x) => x.started > linkDone)) {
    // Nothing the group held before this one started may lie within the gap of it.
    const before = won.filter((x) => x !== r && x.ended < r.started).map((x) => x.slot);
    expect(before.filter((t) => Math.abs(t - r.slot) < CAPS.general.minGapMs)).toEqual([]);
  }
});

test("a reservation that waited on a group lock while a link moved its record counts the new group", async () => {
  const [a, b] = [await createPerson(W), await createPerson(W)].sort();
  const [takenFor, waitingFor] = await coldActions(2, [a!, b!]);
  expect((await reserveTouch(W, takenFor!, new Date(T0 + 300 * DAY), { now: NOW })).kind).toBe("reserved");

  // Hold b's row, the way a linking transaction does, and start a reservation for b.
  const linker = await appClient(direct);
  await linker.query("begin");
  await linker.query("select set_config('app.workspace_id', $1, true)", [W]);
  await linker.query("select id from people where id = $1 for no key update", [b]);
  const pending = reserveTouch(W, waitingFor!, new Date(T0 + 301 * DAY), { now: NOW });
  for (let i = 0; i < 200; i++) {
    const { rows } = await c.query(
      "select count(*)::int n from pg_stat_activity where datname = current_database() and wait_event_type = 'Lock'",
    );
    if (rows[0].n > 0) break;
    await new Promise((r) => setTimeout(r, 10));
  }
  // The link commits: b joins a's group while the reservation waits on b's old row.
  await linker.query(
    "insert into person_links (workspace_id, low_id, high_id, state, created_at) values ($1, $2, $3, 'proposed', now())",
    [W, a, b],
  );
  await linker.query("update people set coordination_id = $1 where id = $2", [a, b]);
  await linker.query("commit");
  await linker.end();

  expect(await pending).toEqual({ kind: "full", cap: "general" });
});

test("links created at once from opposite directions all finish, with no deadlock", async () => {
  const records = await Promise.all(Array.from({ length: 20 }, () => createPerson(W)));
  // Each record shares one key with the next, both sides added at once, so groups merge in every order.
  const results = await Promise.all(
    records.flatMap((r, i) => {
      const next = records[(i + 1) % records.length]!;
      return [addKey(W, r, "hubspot", `ring-${i}`), addKey(W, next, "hubspot", `ring-${i}`)];
    }),
  );
  expect(results.every((r) => r.ok)).toBe(true);
  const lowest = [...records].sort()[0];
  for (const r of records) expect((await groupOf(W, r)).groupId).toBe(lowest);
});
