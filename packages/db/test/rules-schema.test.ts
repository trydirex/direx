// SPDX-License-Identifier: AGPL-3.0-only
// Database-level guarantees of standing rules, as direx_app inside one Workspace.
import { afterAll, beforeAll, expect, test } from "vitest";
import type pg from "pg";
import { withWorkspace } from "../src/index";
import { organizations, workspaces } from "../src/schema";
import { appClient, insertAuthUser } from "../../../test/db";

let c: pg.Client;
const W = crypto.randomUUID();
const OTHER = crypto.randomUUID();
const U = crypto.randomUUID();
let campaignId: string;

const as = (workspace: string) => c.query("select set_config('app.workspace_id', $1, false)", [workspace]);
const newRule = async (over: { workspace?: string; status?: string; reason?: string | null; cap?: number; touchClass?: string } = {}) =>
  (
    await c.query(
      `insert into standing_rules (workspace_id, capability, touch_class, campaign_id, step_key, template_revision, facts, capability_hash, daily_cap, expires_at, granted_by, granted_at, people_as_of, status, suspended_reason)
       values ($1, 'cap', $2, $3, 's1', 1, '[]', 'hash', $4, now() + interval '90 days', $5, now(), now(), $6, $7) returning id`,
      [over.workspace ?? W, over.touchClass ?? "cold", campaignId, over.cap ?? 50, U, over.status ?? "active", over.reason ?? null],
    )
  ).rows[0].id as string;
const newRevision = (ruleId: string, actorUser: string | null, actorSystem: string | null) =>
  c.query(
    `insert into standing_rule_revisions (workspace_id, rule_id, revision, change, facts, capability_hash, template_revision, actor_user_id, actor_system, at)
     values ($1, $2, 1, 'grant', '[]', 'hash', 1, $3, $4, now())`,
    [W, ruleId, actorUser, actorSystem],
  );

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
  await as(W);
  const plan = (await c.query(`insert into marketing_plans (workspace_id, title, created_at, updated_at) values ($1, 't', now(), now()) returning id`, [W])).rows[0].id;
  campaignId = (await c.query(`insert into campaigns (workspace_id, plan_id, owner_user_id, created_at, updated_at) values ($1, $2, $3, now(), now()) returning id`, [W, plan, U])).rows[0].id;
  await c.query(`insert into campaign_steps (workspace_id, campaign_id, step_key, type, updated_at) values ($1, $2, 's1', 'email', now())`, [W, campaignId]);
});
afterAll(() => c.end());

test("a rule's status, reason and cap are constrained", async () => {
  await expect(newRule({ status: "always" })).rejects.toThrow(/standing_rules_status_check/);
  await expect(newRule({ status: "suspended" })).rejects.toThrow(/standing_rules_suspended_reason_check/);
  await expect(newRule({ reason: "stale" })).rejects.toThrow(/standing_rules_suspended_reason_check/);
  await expect(newRule({ cap: 0 })).rejects.toThrow(/standing_rules_daily_cap_check/);
  await expect(newRule({ touchClass: "sales_follow_up" })).rejects.toThrow(/standing_rules_touch_class_check/);
});

const newAgentRule = (over: { revision?: number | null; cap?: number | null; producer?: string | null; outside?: boolean } = {}) =>
  c.query(
    `insert into standing_rules (workspace_id, mode, capability, touch_class, campaign_id, step_key, template_revision, facts, capability_hash, daily_cap, producer, allowed_facts, outside_content, language, wording_version, drafting_agent, expires_at, granted_by, granted_at, people_as_of)
     values ($1, 'agent_written', 'cap', 'cold', $2, 's1', $3, '[]', 'hash', $4, $5, '[]', $6, 'en', 'w1', 'recipient_writer', now() + interval '90 days', $7, now(), now())`,
    [W, campaignId, over.revision ?? null, over.cap ?? null, over.producer === undefined ? "{}" : over.producer, over.outside ?? true, U],
  );

test("each mode keeps its own fields", async () => {
  await newAgentRule();
  await expect(newAgentRule({ cap: 50 })).rejects.toThrow(/standing_rules_agent_mode_check/);
  await expect(newAgentRule({ revision: 1 })).rejects.toThrow(/standing_rules_agent_mode_check/);
  await expect(newAgentRule({ producer: null })).rejects.toThrow(/standing_rules_agent_mode_check/);
  await expect(newAgentRule({ outside: false })).rejects.toThrow(/standing_rules_agent_mode_check/);
  await expect(c.query(`update standing_rules set mode = 'always' where workspace_id = $1`, [W])).rejects.toThrow(/standing_rules_mode_check/);
  const id = await newRule();
  await expect(c.query(`update standing_rules set template_revision = null where id = $1`, [id])).rejects.toThrow(/standing_rules_template_mode_check/);
  await expect(c.query(`update standing_rules set daily_cap = null where id = $1`, [id])).rejects.toThrow(/standing_rules_template_mode_check/);
  await expect(c.query(`update standing_rules set producer = '{}' where id = $1`, [id])).rejects.toThrow(/standing_rules_template_mode_check/);
});

test("a rule can't be deleted, and a revision has one actor and can't change", async () => {
  const id = await newRule();
  await expect(c.query("delete from standing_rules where id = $1", [id])).rejects.toThrow(/permission denied/);
  await expect(newRevision(id, null, null)).rejects.toThrow(/one_actor/);
  await expect(newRevision(id, U, "system")).rejects.toThrow(/one_actor/);
  await newRevision(id, U, null);
  await expect(c.query("update standing_rule_revisions set reason = 'x' where rule_id = $1", [id])).rejects.toThrow(/permission denied/);
  await expect(c.query("delete from standing_rule_revisions where rule_id = $1", [id])).rejects.toThrow(/permission denied/);
});

test("another Workspace can't see a rule or point a row at it", async () => {
  const id = await newRule();
  await as(OTHER);
  try {
    expect((await c.query("select id from standing_rules where id = $1", [id])).rows).toEqual([]);
    await expect(newRule({ workspace: OTHER })).rejects.toThrow(/standing_rules_step_fk/);
    await expect(
      c.query(
        `insert into standing_rule_revisions (workspace_id, rule_id, revision, change, facts, capability_hash, template_revision, actor_system, at)
         values ($1, $2, 1, 'grant', '[]', 'hash', 1, 'system', now())`,
        [OTHER, id],
      ),
    ).rejects.toThrow(/standing_rule_revisions_rule_fk/);
  } finally {
    await as(W);
  }
});
