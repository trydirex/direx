// SPDX-License-Identifier: AGPL-3.0-only
// Database-level guarantees of Strategy and marketing plans, as direx_app inside one Workspace.
import { afterAll, beforeAll, expect, test } from "vitest";
import type pg from "pg";
import { withWorkspace } from "../src/index";
import { organizations, workspaces } from "../src/schema";
import { appClient, insertAuthUser } from "../../../test/db";

let c: pg.Client;
const W = crypto.randomUUID();
const U = crypto.randomUUID();
let strategyId: string;

const newPlan = async () =>
  (await c.query(`insert into marketing_plans (workspace_id, title, created_at, updated_at) values ($1, 't', now(), now()) returning id`, [W])).rows[0].id as string;
const planVersion = (planId: string, n: number, pinned: number) =>
  c.query(
    `insert into marketing_plan_versions (workspace_id, plan_id, version, body, digest, strategy_id, strategy_version, actor_user_id, at)
     values ($1, $2, $3, '{}', 'd', $4, $5, $6, now())`,
    [W, planId, n, strategyId, pinned, U],
  );

beforeAll(async () => {
  c = await appClient();
  const orgId = crypto.randomUUID();
  const at = new Date();
  await withWorkspace(W, async (tx) => {
    await tx.insert(organizations).values({ id: orgId, name: "Org", createdAt: at });
    await tx.insert(workspaces).values({ id: W, orgId, name: "W", createdAt: at });
  });
  await insertAuthUser(U);
  await c.query("select set_config('app.workspace_id', $1, false)", [W]);
  strategyId = (await c.query(`insert into strategies (workspace_id, created_at, updated_at) values ($1, now(), now()) returning id`, [W])).rows[0].id;
  await c.query(`insert into strategy_versions (workspace_id, strategy_id, version, body, digest, actor_user_id, at) values ($1, $2, 1, '{}', 'd', $3, now())`, [W, strategyId, U]);
});
afterAll(() => c.end());

test("one Strategy per Workspace", async () => {
  await expect(c.query(`insert into strategies (workspace_id, created_at, updated_at) values ($1, now(), now())`, [W])).rejects.toThrow(/strategies_one_per_workspace/);
});

test("a plan version must pin a Strategy version that exists", async () => {
  const id = await newPlan();
  await expect(planVersion(id, 1, 99)).rejects.toThrow(/marketing_plan_versions_strategy_fk/);
  await expect(planVersion(id, 1, 1)).resolves.toBeDefined();
  await expect(planVersion(id, 1, 1)).rejects.toThrow(/marketing_plan_versions_pkey/);
});

test("versions, progress and readings never change, and nothing is deleted", async () => {
  for (const table of ["strategy_versions", "marketing_plan_versions", "plan_step_progress", "plan_measure_readings"]) {
    await expect(c.query(`update ${table} set at = now()`)).rejects.toThrow(/permission denied/);
    await expect(c.query(`delete from ${table}`)).rejects.toThrow(/permission denied/);
  }
  await expect(c.query("delete from strategies")).rejects.toThrow(/permission denied/);
  await expect(c.query("delete from marketing_plans")).rejects.toThrow(/permission denied/);
});

test("progress takes a known status and exactly one actor", async () => {
  const id = await newPlan();
  const progress = (status: string, actors: string) =>
    c.query(`insert into plan_step_progress (workspace_id, plan_id, step_key, status, at, actor_user_id, actor_system) values ($1, $2, 's', $3, now(), ${actors})`, [W, id, status]);
  await expect(progress("finished", "null, 'x'")).rejects.toThrow(/plan_step_progress_status_check/);
  await expect(progress("done", "null, null")).rejects.toThrow(/plan_step_progress_one_actor_check/);
  await expect(progress("done", `'${U}', 'x'`)).rejects.toThrow(/plan_step_progress_one_actor_check/);
  await expect(progress("done", `'${U}', null`)).resolves.toBeDefined();
});

test("a reading's source always matches who wrote it", async () => {
  const id = await newPlan();
  const reading = (source: string, actors: string) =>
    c.query(`insert into plan_measure_readings (workspace_id, plan_id, measure_key, value, observed_on, source, at, actor_user_id, actor_system) values ($1, $2, 'm', '3', '2026-11-01', $3, now(), ${actors})`, [W, id, source]);
  await expect(reading("person", "null, 'reports'")).rejects.toThrow(/plan_measure_readings_source_matches_actor_check/);
  await expect(reading("system", `'${U}', null`)).rejects.toThrow(/plan_measure_readings_source_matches_actor_check/);
  await expect(reading("person", `'${U}', null`)).resolves.toBeDefined();
  await expect(reading("system", "null, 'reports'")).resolves.toBeDefined();
});

test("another Workspace sees none of it, and can't point at it", async () => {
  const id = await newPlan();
  const other = crypto.randomUUID();
  await c.query("select set_config('app.workspace_id', $1, false)", [other]);
  for (const table of ["strategies", "strategy_versions", "marketing_plans", "marketing_plan_versions", "plan_step_progress", "plan_measure_readings"]) {
    expect((await c.query(`select 1 from ${table}`)).rows).toEqual([]);
  }
  await expect(c.query(`insert into plan_step_progress (workspace_id, plan_id, step_key, status, at, actor_system) values ($1, $2, 's', 'done', now(), 'x')`, [other, id])).rejects.toThrow();
  await c.query("select set_config('app.workspace_id', $1, false)", [W]);
});
