// SPDX-License-Identifier: AGPL-3.0-only
// Database-level guarantees of the items tables, as direx_app inside one Workspace.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, expect, test } from "vitest";
import type pg from "pg";
import { withWorkspace } from "../src/index";
import { organizations, workspaces } from "../src/schema";
import { appClient, insertAuthUser } from "../../../test/db";

let c: pg.Client;
const newWorkspace = async () => {
  const id = crypto.randomUUID();
  const orgId = crypto.randomUUID();
  const at = new Date();
  await withWorkspace(id, async (tx) => {
    await tx.insert(organizations).values({ id: orgId, name: "Org", createdAt: at });
    await tx.insert(workspaces).values({ id, orgId, name: "W", createdAt: at });
  });
  return id;
};
const enter = (w: string) => c.query("select set_config('app.workspace_id', $1, false)", [w]);
const newAction = async (w: string) => {
  const { rows } = await c.query(
    `insert into actions (workspace_id, idempotency_key, capability, dedupe_class, state, spec, spec_hash, created_at, updated_at)
     values ($1, gen_random_uuid()::text, 'test.send', 'blind', 'draft', '{}', 'h', now(), now()) returning id`,
    [w],
  );
  return rows[0].id as string;
};
const item = (w: string, columns: Record<string, unknown>) => {
  const all: Record<string, unknown> = { kind: "fact_edit", state: "needs_approval", title: "t", warnings: "[]", ...columns };
  const names = Object.keys(all);
  return c.query(
    `insert into items (workspace_id, created_at, updated_at, ${names.join(", ")})
     values ($1, now(), now(), ${names.map((_, i) => `$${i + 2}`).join(", ")}) returning id`,
    [w, ...Object.values(all)],
  );
};
const clean = (o: Record<string, unknown>) => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined));

let W: string;
beforeAll(async () => {
  c = await appClient();
  W = await newWorkspace();
  await enter(W);
});
afterAll(() => c.end());

test("an Action Item has no state of its own, and a non-Action Item must have one", async () => {
  const a = await newAction(W);
  await expect(item(W, clean({ kind: "action", action_id: a, state: "draft", described_draft_version: 1 }))).rejects.toThrow(/items_one_state_check/);
  await expect(item(W, { state: null })).rejects.toThrow(/items_one_state_check/);
  await expect(item(W, clean({ kind: "action", action_id: a, state: "applied", described_draft_version: 1 }))).rejects.toThrow(/items_one_state_check/);
  await expect(item(W, clean({ kind: "action", action_id: a, state: null, described_draft_version: 1 }))).resolves.toBeDefined();
});

test("a non-Action Item uses only its own states", async () => {
  await expect(item(W, { state: "sent" })).rejects.toThrow(/items_state_check/);
  await expect(item(W, { state: "held" })).rejects.toThrow(/items_state_check/);
  await expect(item(W, { state: "applied" })).resolves.toBeDefined();
});

test("an Action's triage lives on the Action, not its Item", async () => {
  const a = await newAction(W);
  await expect(
    item(W, clean({ kind: "action", action_id: a, state: null, described_draft_version: 1, snoozed_until: new Date() })),
  ).rejects.toThrow(/items_triage_check/);
  await expect(item(W, { snoozed_until: new Date() })).resolves.toBeDefined();
});

test("kind and action id agree, and one Action has one Item", async () => {
  const a = await newAction(W);
  await expect(item(W, clean({ action_id: a, state: null, described_draft_version: 1 }))).rejects.toThrow(/items_kind_check/);
  await expect(item(W, { kind: "action" })).rejects.toThrow(/items_kind_check/);
  const row = clean({ kind: "action", action_id: a, state: null, described_draft_version: 1 });
  await item(W, row);
  await expect(item(W, row)).rejects.toThrow(/items_workspace_id_action_id_key/);
});

test("warnings are required and must be a list", async () => {
  await expect(item(W, { warnings: null })).rejects.toThrow(/warnings/);
  await expect(item(W, { warnings: "{}" })).rejects.toThrow(/items_warnings_check/);
});

test("each warning is a code and the words, never bare words", async () => {
  await expect(item(W, { warnings: '["Read it first"]' })).rejects.toThrow(/items_warnings_shape_check/);
  await expect(item(W, { warnings: '[{"code":"unspecified"}]' })).rejects.toThrow(/items_warnings_shape_check/);
  await expect(item(W, { warnings: '[{"code":1,"text":"x"}]' })).rejects.toThrow(/items_warnings_shape_check/);
  await expect(item(W, { warnings: '[{"code":"uncited_number","text":"A number with no source: \\"40%\\""}]' })).resolves.toBeDefined();
});

test("the typed-warnings migration wraps old words as unspecified and keeps their order", async () => {
  const sql = readFileSync(join(import.meta.dirname, "../migrations/0063_draft_checks.sql"), "utf8");
  const rewrite = sql.split("--> statement-breakpoint").find((s) => s.includes('UPDATE "items"'))!;
  await c.query("create temp table old_items (n int, warnings jsonb not null)");
  await c.query(`insert into old_items values (1, '["b", "a"]'), (2, '[]'), (3, '[{"code":"foreign_link","text":"t"}, "c"]')`);
  await c.query(rewrite.replace('UPDATE "items"', "UPDATE old_items"));
  const { rows } = await c.query("select warnings from old_items order by n");
  expect(rows.map((r) => r.warnings)).toEqual([
    [{ code: "unspecified", text: "b" }, { code: "unspecified", text: "a" }],
    [],
    [{ code: "foreign_link", text: "t" }, { code: "unspecified", text: "c" }],
  ]);
});

test("an Item can't reference another Workspace's Action or be seen from it", async () => {
  const other = await newWorkspace();
  const mine = (await item(W, {})).rows[0].id;
  const a = await newAction(W);
  await enter(other);
  await expect(item(other, clean({ kind: "action", action_id: a, state: null, described_draft_version: 1 }))).rejects.toThrow(/items_action_fk/);
  expect((await c.query("select id from items where id = $1", [mine])).rows).toEqual([]);
  await enter(W);
});

test("Items are never deleted, and their events take one actor and are append-only", async () => {
  const id = (await item(W, {})).rows[0].id;
  await expect(c.query("delete from items")).rejects.toThrow(/permission denied/);
  const event = (actors: string) =>
    c.query(
      `insert into item_events (workspace_id, item_id, to_state, version, at, actor_user_id, actor_agent_run_id, actor_system)
       values ($1, $2, 'applied', 1, now(), ${actors})`,
      [W, id],
    );
  await expect(event("null, null, null")).rejects.toThrow(/item_events_one_actor_check/);
  await expect(event("null, gen_random_uuid(), 'system'")).rejects.toThrow(/item_events_one_actor_check/);
  await expect(event("null, null, 'system'")).resolves.toBeDefined();
  await expect(c.query("update item_events set detail = 'x'")).rejects.toThrow(/permission denied/);
  await expect(c.query("delete from item_events")).rejects.toThrow(/permission denied/);
});

test("a review decision's reason is one of the known ones, and its sentence fits 300 characters", async () => {
  const reviewer = crypto.randomUUID();
  await insertAuthUser(reviewer);
  const { rows } = await item(W, {});
  const decide = (decision: string, reason: string | null, note: string | null) =>
    c.query(
      `insert into review_decisions (workspace_id, item_id, reviewer_id, kind, decision, opened_at, decided_at, reason, reason_note)
       values ($1, $2, $3, 'fact_edit', $4, now(), now(), $5, $6)`,
      [W, rows[0].id, reviewer, decision, reason, note],
    );
  await expect(decide("rewrite", "salesy", "x".repeat(300))).resolves.toBeDefined();
  await expect(decide("approve", "great", null)).resolves.toBeDefined();
  await expect(decide("reject", null, null)).resolves.toBeDefined();
  await expect(decide("rewrite", "rude", null)).rejects.toThrow(/review_decisions_reason_check/);
  await expect(decide("rewrite", "long", "x".repeat(301))).rejects.toThrow(/review_decisions_reason_note_check/);
  await expect(decide("skip", null, null)).rejects.toThrow(/review_decisions_decision_check/);
});
