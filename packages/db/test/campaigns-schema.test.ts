// SPDX-License-Identifier: AGPL-3.0-only
// Database-level guarantees of campaigns, as direx_app inside one Workspace.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, expect, test } from "vitest";
import { sql } from "drizzle-orm";
import { getTableConfig, PgDialect } from "drizzle-orm/pg-core";
import type pg from "pg";
import { withWorkspace } from "../src/index";
import { organizations, workspaces } from "../src/schema";
import { campaignOutcomes } from "../src/schema-campaigns";
import { appClient, insertAuthUser, ownerClient } from "../../../test/db";

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

test("a meeting or deal mark is undone once by a row of the same Person and kind, never changed or deleted, and hidden from other Workspaces", async () => {
  const campaignPerson = async (workspace: string) => {
    const plan = await newPlan(workspace);
    await c.query("select set_config('app.workspace_id', $1, false)", [workspace]);
    const campaign = (await c.query(`insert into campaigns (workspace_id, plan_id, owner_user_id, created_at, updated_at) values ($1, $2, $3, now(), now()) returning id`, [workspace, plan, U])).rows[0].id as string;
    const person = crypto.randomUUID();
    await c.query("insert into people (id, workspace_id, coordination_id, created_at) values ($1, $2, $1, now())", [person, workspace]);
    await c.query("insert into campaign_people (workspace_id, campaign_id, person_id, added_by, at) values ($1, $2, $3, $4, now())", [workspace, campaign, person, U]);
    return { workspace, campaign, person };
  };
  const mark = async (p: { workspace: string; campaign: string; person: string }, kind: string, on: string | null, voids: string | null = null) =>
    (await c.query("insert into campaign_outcomes (workspace_id, campaign_id, person_id, kind, occurred_on, voids, actor_user_id, at) values ($1, $2, $3, $4, $5, $6, $7, now()) returning id", [p.workspace, p.campaign, p.person, kind, on, voids, U])).rows[0].id as string;

  const theirs = await campaignPerson(OTHER);
  const hidden = await mark(theirs, "deal", "2026-11-18");
  const p = await campaignPerson(W);
  expect((await c.query("select id from campaign_outcomes where id = $1", [hidden])).rows).toEqual([]);

  const meeting = await mark(p, "meeting", "2026-11-18");
  await expect(mark(p, "call", "2026-11-18")).rejects.toThrow(/campaign_outcomes_kind_check/);
  await expect(mark(p, "deal", null)).rejects.toThrow(/campaign_outcomes_occurred_on_check/);
  await expect(mark(p, "meeting", "2026-11-18", meeting)).rejects.toThrow(/campaign_outcomes_occurred_on_check/);
  await expect(mark({ ...p, person: crypto.randomUUID() }, "meeting", "2026-11-18")).rejects.toThrow(/campaign_outcomes_person_fk/);
  await expect(mark(p, "deal", null, meeting)).rejects.toThrow(/campaign_outcomes_voids_fk/);
  const undo = await mark(p, "meeting", null, meeting);
  await expect(mark(p, "meeting", null, undo)).rejects.toThrow(/campaign_outcomes_mark_only/);

  // A forward reference in one statement must not evade the mark-only trigger.
  const nextMeeting = await mark(p, "meeting", "2026-11-19");
  const nextUndo = crypto.randomUUID();
  await expect(c.query(
    "insert into campaign_outcomes (id, workspace_id, campaign_id, person_id, kind, voids, actor_user_id, at) values ($1, $3, $4, $5, 'meeting', $2, $7, now()), ($2, $3, $4, $5, 'meeting', $6, $7, now())",
    [crypto.randomUUID(), nextUndo, p.workspace, p.campaign, p.person, nextMeeting, U],
  )).rejects.toThrow(/campaign_outcomes_mark_only/);
  // The refused statement rolls back both rows, leaving the mark available for a valid undo.
  await mark(p, "meeting", null, nextMeeting);
  await expect(mark(p, "meeting", null, meeting)).rejects.toThrow(/campaign_outcomes_voids_key/);
  await expect(c.query("update campaign_outcomes set kind = 'deal' where id = $1", [meeting])).rejects.toThrow(/permission denied/);
  await expect(c.query("delete from campaign_outcomes where id = $1", [meeting])).rejects.toThrow(/permission denied/);

  // An upgrade refuses preexisting chains rather than rewriting append-only audit rows.
  const owner = await ownerClient();
  try {
    await owner.query("begin");
    await owner.query("drop trigger campaign_outcomes_mark_only on public.campaign_outcomes");
    await owner.query("insert into campaign_outcomes (workspace_id, campaign_id, person_id, kind, voids, actor_user_id, at) values ($1, $2, $3, 'meeting', $4, $5, now())", [p.workspace, p.campaign, p.person, undo, U]);
    const preflight = readFileSync(join(import.meta.dirname, "../migrations/0155_campaign_outcomes_mark_only.sql"), "utf8").split("--> statement-breakpoint")[0]!;
    await expect(owner.query(preflight)).rejects.toThrow(/campaign_outcomes_mark_only/);
  } finally {
    try {
      await owner.query("rollback");
    } finally {
      await owner.end();
    }
  }
});

test("the schema declares campaign_outcomes' keys and checks as migration 0154 made them", async () => {
  const t = getTableConfig(campaignOutcomes);
  const dialect = new PgDialect();
  const columns = (cols: { name: string }[]) => sql.join(cols.map((col) => sql.identifier(col.name)), sql`, `);
  const definitions = [
    ...t.uniqueConstraints.map((u) => sql`constraint ${sql.identifier(u.getName()!)} unique ${sql.raw(u.nullsNotDistinct ? "nulls not distinct " : "")}(${columns(u.columns)})`),
    ...t.foreignKeys.map((f) => {
      const ref = f.reference();
      const target = getTableConfig(ref.foreignTable);
      return sql`constraint ${sql.identifier(f.getName())} foreign key (${columns(ref.columns)}) references ${sql.identifier(target.schema ?? "public")}.${sql.identifier(target.name)} (${columns(ref.foreignColumns)}) on update ${sql.raw(f.onUpdate ?? "no action")} on delete ${sql.raw(f.onDelete ?? "no action")}`;
    }),
    ...t.checks.map((ch) => {
      // The expression belongs to the isolated copy, so strip only its source table qualifier.
      const expression = dialect.sqlToQuery(ch.value).sql.replaceAll('"campaign_outcomes".', "");
      return sql`constraint ${sql.identifier(ch.name)} check (${sql.raw(expression)})`;
    }),
  ];
  const owner = await ownerClient();
  try {
    // LIKE copies column types without copying keys or checks. PostgreSQL then normalizes the
    // independently declared constraints, avoiding a text normalizer that could hide differences.
    await owner.query("begin");
    await owner.query("create schema campaign_outcomes_declared");
    await owner.query("create table campaign_outcomes_declared.outcomes (like public.campaign_outcomes)");
    for (const definition of definitions) {
      await owner.query(dialect.sqlToQuery(sql`alter table campaign_outcomes_declared.outcomes add ${definition}`).sql);
    }
    const constraints = async (table: string) => (await owner.query(
      "select conname, pg_get_constraintdef(oid) as definition from pg_constraint where conrelid = $1::regclass and contype in ('u', 'f', 'c') order by conname",
      [table],
    )).rows;
    const declared = await constraints("campaign_outcomes_declared.outcomes");
    const migrated = await constraints("public.campaign_outcomes");
    expect(declared).toEqual(migrated);
  } finally {
    // Roll back the isolated schema even when adding a constraint or comparing it fails.
    try {
      await owner.query("rollback");
    } finally {
      await owner.end();
    }
  }
});

test("a write-up is one row per Campaign, keeps its shape, can't be deleted by the app, and is hidden from other Workspaces", async () => {
  const campaignIn = async (workspace: string) => {
    const plan = await newPlan(workspace);
    await c.query("select set_config('app.workspace_id', $1, false)", [workspace]);
    return (await c.query(`insert into campaigns (workspace_id, plan_id, owner_user_id, created_at, updated_at) values ($1, $2, $3, now(), now()) returning id`, [workspace, plan, U])).rows[0].id as string;
  };
  const writeUp = (workspace: string, campaign: string, status: string, extra: { paragraph?: string | null; failure?: string | null; suggestions?: string } = {}) =>
    c.query(
      `insert into campaign_write_ups (workspace_id, campaign_id, status, paragraph, failure, suggestions, created_at, written_at)
       values ($1, $2, $3, $4, $5, coalesce($6::jsonb, '[]'::jsonb), now(), case when $4::text is null then null else now() end) returning id`,
      [workspace, campaign, status, extra.paragraph ?? null, extra.failure ?? null, extra.suggestions ?? null],
    );

  const theirCampaign = await campaignIn(OTHER);
  const theirs = (await writeUp(OTHER, theirCampaign, "writing")).rows[0].id as string;

  const campaign = await campaignIn(W);
  expect((await c.query("select id from campaign_write_ups where id = $1", [theirs])).rows).toEqual([]);
  await expect(writeUp(W, campaign, "done")).rejects.toThrow(/campaign_write_ups_status_check/);
  await expect(writeUp(W, campaign, "written")).rejects.toThrow(/campaign_write_ups_written_check/);
  await expect(writeUp(W, campaign, "failed")).rejects.toThrow(/campaign_write_ups_failure_check/);
  await expect(writeUp(W, campaign, "writing", { suggestions: "[1, 2, 3, 4]" })).rejects.toThrow(/campaign_write_ups_suggestions_check/);
  await expect(writeUp(W, crypto.randomUUID(), "writing")).rejects.toThrow(/campaign_write_ups_campaign_fk/);

  const id = (await writeUp(W, campaign, "writing")).rows[0].id as string;
  await expect(writeUp(W, campaign, "writing")).rejects.toThrow(/campaign_write_ups_campaign_key/);
  // Written, then written again: the old paragraph stays while the new run is out.
  await c.query("update campaign_write_ups set status = 'written', paragraph = 'p', written_at = now() where id = $1", [id]);
  await c.query("update campaign_write_ups set status = 'writing' where id = $1", [id]);
  expect((await c.query("select paragraph from campaign_write_ups where id = $1", [id])).rows).toEqual([{ paragraph: "p" }]);
  await expect(c.query("delete from campaign_write_ups where id = $1", [id])).rejects.toThrow(/permission denied/);
});
