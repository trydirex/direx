// SPDX-License-Identifier: AGPL-3.0-only
// Database-level guarantees of the ledger tables, as direx_app inside one workspace.
import { afterAll, beforeAll, expect, test } from "vitest";
import type pg from "pg";
import { appClient } from "../../../test/db";

const W = crypto.randomUUID();
let c: pg.Client;
let actionId: string;

beforeAll(async () => {
  c = await appClient();
  await c.query("select set_config('app.workspace_id', $1, false)", [W]);
  const { rows } = await c.query(
    `insert into actions (workspace_id, idempotency_key, capability, dedupe_class, state, spec, spec_hash, created_at, updated_at)
     values ($1, 'k', 'test.send', 'blind', 'draft', '{}', 'h', now(), now()) returning id`,
    [W],
  );
  actionId = rows[0].id;
});
afterAll(() => c.end());

const event = (actors: string) =>
  c.query(
    `insert into action_events (workspace_id, action_id, to_state, version, at, actor_user_id, actor_agent_run_id, actor_system)
     values ($1, $2, 'draft', 1, now(), ${actors})`,
    [W, actionId],
  );

test("an event needs exactly one actor", async () => {
  await expect(event("null, null, null")).rejects.toThrow(/action_events_one_actor_check/);
  await expect(event("gen_random_uuid(), gen_random_uuid(), null")).rejects.toThrow(/action_events_one_actor_check/);
  await expect(event("null, null, 'dispatcher'")).resolves.toBeDefined();
});

test("events are append-only for direx_app", async () => {
  await expect(c.query("update action_events set reason = 'x'")).rejects.toThrow(/permission denied/);
  await expect(c.query("delete from action_events")).rejects.toThrow(/permission denied/);
});

test("approvals are never deleted and only voided_at changes", async () => {
  await c.query(
    `insert into approvals (workspace_id, action_id, draft_version, spec_hash, snapshot, approver_id, approved_at, key_id, signature)
     values ($1, $2, 1, 'h', '[]', gen_random_uuid(), now(), 'k1', 's')`,
    [W, actionId],
  );
  await expect(c.query("delete from approvals")).rejects.toThrow(/permission denied/);
  await expect(c.query("update approvals set signature = 'forged'")).rejects.toThrow(/permission denied/);
  await expect(c.query("update approvals set voided_at = now()")).resolves.toBeDefined();
});

test("a held Action needs a hold reason, and only a held one has it", async () => {
  await expect(c.query("update actions set state = 'held' where id = $1", [actionId])).rejects.toThrow(
    /actions_hold_reason_check/,
  );
  await expect(c.query("update actions set hold_reason = 'x' where id = $1", [actionId])).rejects.toThrow(
    /actions_hold_reason_check/,
  );
});

test("actions are never deleted by direx_app", async () => {
  await expect(c.query("delete from actions")).rejects.toThrow(/permission denied/);
});
