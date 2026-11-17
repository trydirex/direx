// SPDX-License-Identifier: AGPL-3.0-only
// Database-level guarantees of campaigns, as direx_app inside one Workspace.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, expect, test } from "vitest";
import type pg from "pg";
import { withWorkspace } from "../src/index";
import { organizations, workspaces } from "../src/schema";
import { appClient, insertAuthUser } from "../../../test/db";

let c: pg.Client;
const W = crypto.randomUUID();
const OTHER = crypto.randomUUID();
const U = crypto.randomUUID();
let planId: string;
let otherPlanId: string;

const newPlan = async (workspace: string) => {
  await c.query("select set_config('app.workspace_id', $1, false)", [workspace]);
  const { rows } = await c.query(`insert into marketing_plans (workspace_id, title, created_at, updated_at) values ($1, 't', now(), now()) returning id`, [workspace]);
  await c.query("select set_config('app.workspace_id', $1, false)", [W]);
  return rows[0].id as string;
};
const newCampaign = async (plan: string, mode: string | null = null) =>
  (
    await c.query(
      `insert into campaigns (workspace_id, plan_id, owner_user_id, drafting_mode, created_at, updated_at) values ($1, $2, $3, $4, now(), now()) returning id`,
      [W, plan, U, mode],
    )
  ).rows[0].id as string;

beforeAll(async () => {
  c = await appClient();
  const at = new Date();
  for (const id of [W, OTHER]) {
    const orgId = crypto.randomUUID();
    await withWorkspace(id, async (tx) => {
      await tx.insert(organizations).values({ id: orgId, name: "Org", createdAt: at });
      await tx.insert(workspaces).values({ id, orgId, name: "W", createdAt: at });
    });
  }
  await insertAuthUser(U);
  planId = await newPlan(W);
  otherPlanId = await newPlan(OTHER);
});
afterAll(() => c.end());

test("one campaign per plan, and its mode starts unanswered", async () => {
  const plan = await newPlan(W);
  const id = await newCampaign(plan);
  expect((await c.query("select drafting_mode from campaigns where id = $1", [id])).rows[0].drafting_mode).toBeNull();
  await expect(newCampaign(plan)).rejects.toThrow(/campaigns_one_per_plan/);
});

test("a campaign can't point at another Workspace's plan", async () => {
  await expect(newCampaign(otherPlanId)).rejects.toThrow(/campaigns_plan_fk/);
});

test("a drafting mode outside the two is refused", async () => {
  await expect(newCampaign(planId, "per_step")).rejects.toThrow(/campaigns_drafting_mode_check/);
});

test("a campaign row can't be written into another Workspace", async () => {
  await expect(
    c.query(`insert into campaigns (workspace_id, plan_id, owner_user_id, created_at, updated_at) values ($1, $2, $3, now(), now())`, [OTHER, otherPlanId, U]),
  ).rejects.toThrow(/row-level security/);
});

test("nothing in a campaign can be deleted, and a campaign action can't be changed", async () => {
  const id = await newCampaign(await newPlan(W));
  await expect(c.query("delete from campaigns where id = $1", [id])).rejects.toThrow(/permission denied/);
  await expect(c.query("delete from campaign_people")).rejects.toThrow(/permission denied/);
  await expect(c.query("delete from campaign_steps")).rejects.toThrow(/permission denied/);
  await expect(c.query("delete from campaign_actions")).rejects.toThrow(/permission denied/);
  await expect(c.query("update campaign_actions set step_key = 'x'")).rejects.toThrow(/permission denied/);
});

test("moving each clips step's one recording to the list keeps it, and the move fails rather than lose one", async () => {
  const parts = readFileSync(join(import.meta.dirname, "../migrations/0087_clip_step_runs.sql"), "utf8").split("--> statement-breakpoint");
  const copy = parts.find((p) => p.includes("INSERT INTO clip_step_runs"))!;
  const guard = parts.find((p) => p.includes("RAISE EXCEPTION"))!;
  // Temp tables come first on the search path, so the statements run as written against these.
  await c.query("create temp table campaign_steps (workspace_id uuid, campaign_id uuid, step_key text, clip_setup jsonb, clip_run_id uuid, updated_at timestamptz)");
  await c.query("create temp table clip_step_runs (workspace_id uuid, campaign_id uuid, step_key text, run_id uuid, setup jsonb, started_by uuid, created_at timestamptz)");
  try {
    const [campaign, run] = [crypto.randomUUID(), crypto.randomUUID()];
    const setup = { sourceMediaId: crypto.randomUUID(), accounts: [{ connection: "linkedin", credentialId: null, networkId: "n1" }], firstAt: "2026-11-09T09:00:00.000Z" };
    await c.query("insert into campaign_steps values ($1, $2, 'launch', $3, $4, '2026-11-07T10:00:00Z'), ($1, $2, 'other', null, null, now())", [W, campaign, { ...setup, userId: U }, run]);
    await c.query(copy);
    await c.query(guard);
    const { rows } = await c.query("select * from clip_step_runs");
    expect(rows).toEqual([{ workspace_id: W, campaign_id: campaign, step_key: "launch", run_id: run, setup, started_by: U, created_at: new Date("2026-11-07T10:00:00Z") }]);
    await c.query("delete from clip_step_runs");
    await expect(c.query(guard)).rejects.toThrow(/a recording was not copied/);
  } finally {
    await c.query("drop table pg_temp.campaign_steps, pg_temp.clip_step_runs");
  }
});

test("a clips step's recordings are never changed or deleted", async () => {
  await expect(c.query("update clip_step_runs set setup = '{}'")).rejects.toThrow(/permission denied/);
  await expect(c.query("delete from clip_step_runs")).rejects.toThrow(/permission denied/);
});

test("only an SEO brief step holds a page, a search and a brief run, and it has no touch class", async () => {
  const id = await newCampaign(await newPlan(W));
  const step = (key: string, type: string, touch: string | null, setup: object | null) =>
    c.query("insert into campaign_steps (workspace_id, campaign_id, step_key, type, touch_class, seo_setup, brief_run_id, updated_at) values ($1, $2, $3, $4, $5, $6, $7, now())", [W, id, key, type, touch, setup, setup ? crypto.randomUUID() : null]);
  await step("brief", "seo_brief", null, { page: "https://acme.test/offer", query: "acme pricing" });
  await expect(step("mail", "email", "cold", { page: null, query: "x" })).rejects.toThrow(/campaign_steps_seo_setup_check/);
  await expect(step("brief2", "seo_brief", "cold", null)).rejects.toThrow(/campaign_steps_touch_class_post_check/);
});

test("a plan change is one row per step, names what held it, and is decided once in full", async () => {
  const id = await newCampaign(await newPlan(W));
  const item = (await c.query(`insert into items (workspace_id, kind, state, title, warnings, created_at, updated_at) values ($1, 'plan_change', 'needs_approval', 't', '[]', now(), now()) returning id`, [W])).rows[0].id;
  const change = (key: string, kinds: string[], suggested: object | null = null, campaign = id) =>
    c.query("insert into campaign_plan_changes (workspace_id, campaign_id, step_key, from_version, to_version, kinds, suggested_template, item_id) values ($1, $2, $3, 1, 2, $4, $5, $6)", [W, campaign, key, kinds, suggested, item]);
  await change("followup_1", ["text", "channel"], { subject: "s", body: "b" });
  await expect(change("followup_1", ["removed"])).rejects.toThrow(/campaign_plan_changes_pkey/);
  await expect(change("a", [])).rejects.toThrow(/campaign_plan_changes_kinds_check/);
  await expect(change("b", ["retitled"])).rejects.toThrow(/campaign_plan_changes_kinds_check/);
  await expect(change("c", ["removed"], { subject: "s", body: "b" })).rejects.toThrow(/campaign_plan_changes_suggested_check/);
  await expect(change("d", ["text"])).rejects.toThrow(/campaign_plan_changes_suggested_check/);
  await expect(change("e", ["removed"], null, crypto.randomUUID())).rejects.toThrow(/campaign_plan_changes_campaign_fk/);
  const decide = (decided: string | null, by: string | null) =>
    c.query("update campaign_plan_changes set decided = $1, decided_by = $2, decided_at = case when $2::uuid is null then null else now() end where campaign_id = $3", [decided, by, id]);
  await expect(decide("keep", null)).rejects.toThrow(/campaign_plan_changes_decided_check/);
  await expect(decide("maybe", U)).rejects.toThrow(/campaign_plan_changes_decided_check/);
  await decide("use_new_text", U);
  await expect(c.query("delete from campaign_plan_changes")).rejects.toThrow(/permission denied/);
});

test("a plan change can't be written into another Workspace", async () => {
  const id = await newCampaign(await newPlan(W));
  await expect(
    c.query("insert into campaign_plan_changes (workspace_id, campaign_id, step_key, from_version, to_version, kinds, item_id) values ($1, $2, 'x', 1, 2, '{removed}', $3)", [OTHER, id, crypto.randomUUID()]),
  ).rejects.toThrow(/row-level security/);
});

test("the backfill gives each plan without a Campaign one, owned by its latest submitter, else the first Owner, and runs twice safely", async () => {
  const parts = readFileSync(join(import.meta.dirname, "../migrations/0122_plan_creator_campaigns.sql"), "utf8").split("--> statement-breakpoint");
  const backfill = parts.find((p) => p.includes("INSERT INTO campaigns"))!;
  // Temp tables come first on the search path, so the statement runs as written against these.
  await c.query("create temp table marketing_plans (id uuid, workspace_id uuid, archived_at timestamptz, created_at timestamptz)");
  await c.query("create temp table marketing_plan_versions (workspace_id uuid, plan_id uuid, version int, actor_user_id uuid)");
  await c.query("create temp table workspace_members (workspace_id uuid, user_id uuid, role text, created_at timestamptz)");
  await c.query("create temp table campaigns (workspace_id uuid, plan_id uuid, owner_user_id uuid, created_at timestamptz, updated_at timestamptz, constraint campaigns_one_per_plan unique (workspace_id, plan_id))");
  try {
    const [w, empty] = [crypto.randomUUID(), crypto.randomUUID()];
    const id = () => crypto.randomUUID();
    const [submitted, unsubmitted, archived, existing, ownerless] = [id(), id(), id(), id(), id()];
    const [first, second, later, admin, keeper] = [id(), id(), id(), id(), id()];
    const made = new Date("2026-10-01T09:00:00Z");
    await c.query("insert into marketing_plans values ($1, $6, null, $7), ($2, $6, null, $7), ($3, $6, now(), $7), ($4, $6, null, $7), ($5, $8, null, $7)", [submitted, unsubmitted, archived, existing, ownerless, w, made, empty]);
    await c.query("insert into marketing_plan_versions values ($1, $2, 1, $3), ($1, $2, 2, $4)", [w, submitted, first, second]);
    await c.query("insert into workspace_members values ($1, $2, 'admin', '2026-01-01'), ($1, $3, 'owner', '2026-02-01'), ($1, $4, 'owner', '2026-03-01')", [w, admin, first, later]);
    await c.query("insert into campaigns values ($1, $2, $3, now(), now())", [w, existing, keeper]);
    await c.query(backfill);
    await c.query(backfill);
    const { rows } = await c.query("select plan_id, owner_user_id, created_at from campaigns order by plan_id");
    const owners = Object.fromEntries(rows.map((r) => [r.plan_id, r.owner_user_id]));
    expect(owners).toEqual({ [submitted]: second, [unsubmitted]: first, [archived]: first, [existing]: keeper });
    expect(rows.find((r) => r.plan_id === submitted).created_at).toEqual(made);
  } finally {
    await c.query("drop table pg_temp.marketing_plans, pg_temp.marketing_plan_versions, pg_temp.workspace_members, pg_temp.campaigns");
  }
});
