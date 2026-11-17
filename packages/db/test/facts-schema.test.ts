// SPDX-License-Identifier: AGPL-3.0-only
// Database-level guarantees of business context, as direx_app inside one Workspace.
import { afterAll, beforeAll, expect, test } from "vitest";
import type pg from "pg";
import { withWorkspace } from "../src/index";
import { organizations, workspaces } from "../src/schema";
import { appClient } from "../../../test/db";

let c: pg.Client;
const W = crypto.randomUUID();
const fact = (field: string, subject: string = crypto.randomUUID()) =>
  c.query(`insert into facts (workspace_id, field, subject, current_version, created_at, updated_at) values ($1, $2, $3, 1, now(), now()) returning id`, [W, field, subject]);
const version = (id: string, n: number, actors: string) =>
  c.query(
    `insert into fact_versions (workspace_id, fact_id, version, value, source, confidence, digest, at, actor_user_id, actor_agent_run_id, actor_system)
     values ($1, $2, $3, 'v', '{}', 'high', 'd', now(), ${actors})`,
    [W, id, n],
  );

beforeAll(async () => {
  c = await appClient();
  const orgId = crypto.randomUUID();
  const at = new Date();
  await withWorkspace(W, async (tx) => {
    await tx.insert(organizations).values({ id: orgId, name: "Org", createdAt: at });
    await tx.insert(workspaces).values({ id: W, orgId, name: "W", createdAt: at });
  });
  await c.query("select set_config('app.workspace_id', $1, false)", [W]);
});
afterAll(() => c.end());

test("one live fact per slot, and a retired slot can be filled again", async () => {
  const { rows } = await fact("price", "per audit");
  await expect(fact("price", "per audit")).rejects.toThrow(/facts_one_live_per_slot/);
  await c.query("update facts set retired_at = now() where id = $1", [rows[0].id]);
  await expect(fact("price", "per audit")).resolves.toBeDefined();
});

test("only known fields", async () => {
  await expect(fact("logo")).rejects.toThrow(/facts_field_check/);
  await expect(fact("competitor", "Double")).resolves.toBeDefined();
});

test("a version takes exactly one actor, never changes, and a fact is never deleted", async () => {
  const id = (await fact("claim")).rows[0].id;
  await expect(version(id, 1, "null, null, null")).rejects.toThrow(/fact_versions_one_actor_check/);
  await expect(version(id, 1, "null, gen_random_uuid(), 'x'")).rejects.toThrow(/fact_versions_one_actor_check/);
  await version(id, 1, "null, null, 'x'");
  await expect(version(id, 1, "null, null, 'x'")).rejects.toThrow(/fact_versions_pkey/);
  await expect(c.query("update fact_versions set value = 'y'")).rejects.toThrow(/permission denied/);
  await expect(c.query("delete from fact_versions")).rejects.toThrow(/permission denied/);
  await expect(c.query("delete from facts")).rejects.toThrow(/permission denied/);
});

test("another Workspace sees none of it", async () => {
  await c.query("select set_config('app.workspace_id', $1, false)", [crypto.randomUUID()]);
  expect((await c.query("select id from facts")).rows).toEqual([]);
  expect((await c.query("select fact_id from fact_versions")).rows).toEqual([]);
  await c.query("select set_config('app.workspace_id', $1, false)", [W]);
});
