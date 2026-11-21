// SPDX-License-Identifier: AGPL-3.0-only
// The retention sweeps (ADR 0030 rule 002, migration 0144): per operational table, an old terminal row
// goes, while a row still in flight or inside a guard's window stays, and a batch stops at its limit.
import { afterAll, beforeAll, expect, test } from "vitest";
import type pg from "pg";
import { sweepRetention, withSystem } from "../src/index";
import { sql } from "drizzle-orm";
import { insertAuthUser, ownerClient } from "../../../test/db";

const W = crypto.randomUUID();
const U = crypto.randomUUID();
const ago = (days: number) => new Date(Date.now() - days * 86_400_000).toISOString();
const ids = new Map<string, string>();

async function seed(c: pg.Client) {
  const org = crypto.randomUUID();
  await c.query(`insert into organizations (id, name, created_at) values ($1, 'Org', now())`, [org]);
  await c.query(`insert into workspaces (id, org_id, name, created_at) values ($1, $2, 'W', now())`, [W, org]);

  const event = (id: string, days: number) =>
    c.query(`insert into trigger_events (workspace_id, plugin_id, trigger, event_id, received_at) values ($1, 'p', 't', $2, $3)`, [W, id, ago(days)]);
  for (const id of ["old-1", "old-2", "old-3"]) await event(id, 100);
  await event("recent", 10);

  const reservation = async (name: string, status: string, days: number) => {
    const settled = status === "held" ? null : ago(days);
    const { rows } = await c.query(
      `insert into budget_reservations (workspace_id, kind, reserved_micros, settled_micros, status, created_at, settled_at)
       values ($1, 'model', 10, $2, $3, $4, $5) returning id`,
      [W, status === "settled" ? 10 : null, status, ago(days + 1), settled],
    );
    ids.set(name, rows[0].id);
  };
  await reservation("named by an old call", "settled", 500);
  await reservation("held", "held", 400);
  await reservation("named by a recent call", "settled", 100);
  await reservation("settled lately", "settled", 10);
  await reservation("released long ago", "released", 100);

  const call = async (name: string, status: string, days: number, reservation: string | null) => {
    const { rows } = await c.query(
      `insert into model_calls (workspace_id, idempotency_key, purpose, trust, status, created_at, reservation_id)
       values ($1, $2, 'test', 'trusted', $3, $4, $5) returning id`,
      [W, name, status, ago(days), reservation && ids.get(reservation)],
    );
    ids.set(name, rows[0].id);
  };
  await call("old and done", "completed", 400, "named by an old call");
  await call("old and in flight", "dispatched", 400, null);
  await call("recent", "completed", 30, "named by a recent call");

  await c.query(`insert into workspace_keys (workspace_id, key_version, wrapped_dek, root_key_id, created_at) values ($1, 1, '\\x00', 'r', now())`, [W]);
  const { rows: cred } = await c.query(
    `insert into credentials (workspace_id, scope, kind, key, name, ciphertext, nonce, key_version, created_by, created_at, updated_at)
     values ($1, 'workspace', 'api_key', 'k', 'n', '\\x01', '\\x02', 1, $2, now(), now()) returning id`,
    [W, U],
  );
  const use = (days: number) =>
    c.query(`insert into credential_access_events (workspace_id, credential_id, consumer, outcome, at) values ($1, $2, 'query', 'ok', $3)`, [W, cred[0].id, ago(days)]);
  await use(400);
  await use(100);

  const competitor = async (name: string) => {
    const { rows } = await c.query(`insert into competitors (workspace_id, name, pricing_url, created_by, created_at, updated_at) values ($1, $2, 'https://a.example/', $3, now(), now()) returning id`, [W, name, U]);
    ids.set(name, rows[0].id);
  };
  const snapshot = async (name: string, competitor: string, days: number) => {
    const { rows } = await c.query(
      `insert into competitor_snapshots (workspace_id, competitor_id, source, url, week, read_at, parts)
       values ($1, $2, 'pricing', 'https://a.example/', $3::date, $3, '{"lines":[]}') returning id`,
      [W, ids.get(competitor), ago(days)],
    );
    ids.set(name, rows[0].id);
  };
  await competitor("watched");
  await competitor("read once");
  await snapshot("oldest", "watched", 730);
  await snapshot("older", "watched", 400);
  await snapshot("newest", "watched", 7);
  await snapshot("only read", "read once", 730);
  await c.query(
    `insert into competitor_changes (workspace_id, competitor_id, source, before_snapshot_id, after_snapshot_id, detail, created_at)
     values ($1, $2, 'pricing', $3, $4, '{}', now())`,
    [W, ids.get("watched"), ids.get("oldest"), ids.get("older")],
  );
}

let owner: pg.Client;
beforeAll(async () => {
  await insertAuthUser(U);
  owner = await ownerClient();
  await seed(owner);
});
afterAll(() => owner?.end());

const left = async (q: string) => (await owner.query(q)).rows.map((r) => Object.values(r)[0]);

test("a batch stops at its limit and is recorded", async () => {
  const { rows } = await withSystem((tx) => tx.execute(sql`select system.sweep_trigger_events(2) as n`));
  expect(rows[0]!.n).toBe(2);
  expect(await left(`select rows_returned from system.system_audit where function_name = 'sweep_trigger_events'`)).toEqual([2]);
  await expect(withSystem((tx) => tx.execute(sql`select system.sweep_trigger_events(0)`))).rejects.toThrow();
});

test("each table loses its old terminal rows and keeps what is in flight or still read", async () => {
  const now = Date.now();
  await owner.query("insert into auth.rate_limit (key, count, last_request) values ('old-1', 1, $1), ('old-2', 2, $1), ('recent', 1, $2)",
    [now - 7_200_000, now]);
  // A batch of 1 runs each sweep until a batch comes back short.
  expect(await sweepRetention(1)).toEqual({
    "auth.rate_limit": 2,
    "public.trigger_events": 1,
    "public.model_calls": 1,
    "public.budget_reservations": 2,
    "public.credential_access_events": 1,
    "public.competitor_snapshots": 2,
  });
  expect(await left("select key from auth.rate_limit")).toEqual(["recent"]);
  expect(await left(`select event_id from trigger_events`)).toEqual(["recent"]);
  expect((await left(`select idempotency_key from model_calls order by 1`)).sort()).toEqual(["old and in flight", "recent"]);
  const kept = await left(`select id from budget_reservations`);
  expect(kept.sort()).toEqual([ids.get("held"), ids.get("named by a recent call"), ids.get("settled lately")].sort());
  expect(await left(`select count(*)::int from credential_access_events`)).toEqual([1]);
  expect((await left(`select id from competitor_snapshots`)).sort()).toEqual([ids.get("newest"), ids.get("only read")].sort());
  // The Change between two pruned reads went with them.
  expect(await left(`select count(*)::int from competitor_changes`)).toEqual([0]);
  // A second run finds nothing.
  expect(Object.values(await sweepRetention())).toEqual([0, 0, 0, 0, 0, 0]);
});
