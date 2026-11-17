// SPDX-License-Identifier: AGPL-3.0-only
// Database-level guarantees of agent runs, as direx_app inside one Workspace.
import { afterAll, beforeAll, expect, test } from "vitest";
import type pg from "pg";
import { withWorkspace } from "../src/index";
import { organizations, workspaces } from "../src/schema";
import { appClient } from "../../../test/db";

let c: pg.Client;
const W = crypto.randomUUID();
const run = (key: string = crypto.randomUUID(), status = "queued", reason: string | null = null) =>
  c.query(
    `insert into agent_runs (workspace_id, idempotency_key, agent, definition_version, prompt_revision, prompt_digest, tool_set_digest, trigger, status, status_reason, deadline_ms, step_cap, cost_cap_micros, input, created_at, updated_at)
     values ($1, $2, 'brand_reader', 1, 'r', 'd', 'd', 'user_request', $3, $4, 600000, 30, 1000000, '{}', now(), now()) returning id`,
    [W, key, status, reason],
  );
const part = (id: string, seq: number, trust = "untrusted") =>
  c.query(`insert into agent_run_parts (workspace_id, run_id, seq, kind, ref_id, digest, trust, at) values ($1, $2, $3, 'web_page', 'u', 'd', $4, now())`, [W, id, seq, trust]);
const event = (id: string, seq: number) =>
  c.query(`insert into agent_run_events (workspace_id, run_id, seq, kind, name, outcome, at) values ($1, $2, $3, 'tool_call', 'fetch_page', 'ok', now())`, [W, id, seq]);
const proposal = (id: string, key: string) =>
  c.query(`insert into agent_proposals (workspace_id, run_id, output_key, kind, at) values ($1, $2, $3, 'fact_proposal', now())`, [W, id, key]);

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

test("one run per idempotency key", async () => {
  await run("same");
  await expect(run("same")).rejects.toThrow(/agent_runs_idempotency_key/);
});

test("only known states, and waiting or failing needs its reason", async () => {
  await expect(run(undefined, "paused")).rejects.toThrow(/agent_runs_status_check/);
  await expect(run(undefined, "waiting")).rejects.toThrow(/agent_runs_waiting_reason_check/);
  await expect(run(undefined, "waiting", "because")).rejects.toThrow(/agent_runs_waiting_reason_check/);
  await expect(run(undefined, "waiting", "daily_cap")).resolves.toBeDefined();
  await expect(run(undefined, "failed")).rejects.toThrow(/agent_runs_failed_reason_check/);
});

test("a run is never deleted", async () => {
  await run();
  await expect(c.query("delete from agent_runs")).rejects.toThrow(/permission denied/);
});

test("what a run read and did is append-only, with one row per sequence number", async () => {
  const id = (await run()).rows[0].id;
  await part(id, 1);
  await event(id, 1);
  await expect(part(id, 1)).rejects.toThrow(/agent_run_parts_pkey/);
  await expect(event(id, 1)).rejects.toThrow(/agent_run_events_pkey/);
  await expect(part(id, 2, "maybe")).rejects.toThrow(/agent_run_parts_trust_check/);
  for (const table of ["agent_run_parts", "agent_run_events"]) {
    await expect(c.query(`update ${table} set seq = 99`)).rejects.toThrow(/permission denied/);
    await expect(c.query(`delete from ${table}`)).rejects.toThrow(/permission denied/);
  }
});

test("one proposal per output key, which can still be given its Item", async () => {
  const id = (await run()).rows[0].id;
  await proposal(id, "claim:fast");
  await expect(proposal(id, "claim:fast")).rejects.toThrow(/agent_proposals_pkey/);
  await c.query("update agent_proposals set item_id = gen_random_uuid() where run_id = $1", [id]);
  await expect(c.query("delete from agent_proposals")).rejects.toThrow(/permission denied/);
});

test("an offer needs its draft and a known target, and each target has one open offer, the Strategy included", async () => {
  const id = (await run()).rows[0].id;
  const offer = (key: string, kind: string | null, target: string | null, step: string | null, body: string | null = '{"x":1}') =>
    c.query(
      `insert into agent_proposals (workspace_id, run_id, output_key, kind, at, body, target_kind, target_id, target_step_key, offer) values ($1, $2, $3, 'plan_proposal', now(), $4, $5, $6, $7, 'open')`,
      [W, id, key, body, kind, target, step],
    );
  await expect(offer("no-body", "strategy", null, null, null)).rejects.toThrow(/agent_proposals_offer_check/);
  await expect(offer("bad-kind", "brand", null, null)).rejects.toThrow(/agent_proposals_offer_check/);
  await offer("s1", "strategy", null, null);
  await expect(offer("s2", "strategy", null, null)).rejects.toThrow(/agent_proposals_one_open_offer/);
  const campaign = crypto.randomUUID();
  await offer("t1", "step", campaign, "email_1");
  await offer("t2", "step", campaign, "email_2");
  await expect(offer("t3", "step", campaign, "email_1")).rejects.toThrow(/agent_proposals_one_open_offer/);
  await c.query("update agent_proposals set offer = 'replaced' where run_id = $1 and output_key = 't1'", [id]);
  await offer("t3", "step", campaign, "email_1");
});

test("a person's cancellation names them, and only known sources may cancel", async () => {
  const insert = (id: string, source: string) =>
    c.query(`insert into agent_cancellations (workspace_id, run_id, source, at) values ($1, $2, $3, now())`, [W, id, source]);
  const id = (await run()).rows[0].id;
  await expect(insert(id, "person")).rejects.toThrow(/agent_cancellations_who_check/);
  await expect(insert(id, "gremlin")).rejects.toThrow(/agent_cancellations_source_check/);
  await insert(id, "shutdown");
  await expect(c.query("delete from agent_cancellations")).rejects.toThrow(/permission denied/);
});

test("another Workspace sees none of it", async () => {
  await run();
  await c.query("select set_config('app.workspace_id', $1, false)", [crypto.randomUUID()]);
  for (const table of ["agent_runs", "agent_run_parts", "agent_run_events", "agent_proposals", "agent_cancellations", "agent_settings", "agent_setting_revisions"]) {
    expect((await c.query(`select 1 from ${table}`)).rows).toEqual([]);
  }
  await c.query("select set_config('app.workspace_id', $1, false)", [W]);
});
