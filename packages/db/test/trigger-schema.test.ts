// SPDX-License-Identifier: AGPL-3.0-only
// Database-level guarantees of the plugin trigger tables, as direx_app.
import { afterAll, beforeAll, expect, test } from "vitest";
import type pg from "pg";
import { appClient } from "../../../test/db";

const W = crypto.randomUUID();
let c: pg.Client;

beforeAll(async () => {
  c = await appClient();
  await c.query("select set_config('app.workspace_id', $1, false)", [W]);
});
afterAll(() => c.end());

const seen = (ws: string, eventId: string) =>
  c.query(
    `insert into trigger_events (workspace_id, plugin_id, trigger, event_id, received_at)
     values ($1, 'com.example.p', 'feed', $2, now())`,
    [ws, eventId],
  );

test("an event id is stored once per workspace, plugin and trigger", async () => {
  await seen(W, "e1");
  await expect(seen(W, "e1")).rejects.toThrow(/trigger_events_pkey/);
});

test("seen event ids are append-only for direx_app", async () => {
  await expect(c.query("update trigger_events set event_id = 'x'")).rejects.toThrow(/permission denied/);
  await expect(c.query("delete from trigger_events")).rejects.toThrow(/permission denied/);
});

test("a row for another workspace is refused by the policy", async () => {
  await expect(seen(crypto.randomUUID(), "e2")).rejects.toThrow(/row-level security/);
});

test("cursors move but are never deleted", async () => {
  await c.query(
    `insert into trigger_cursors (workspace_id, plugin_id, trigger, cursor, updated_at) values ($1, 'com.example.p', 'feed', '1', now())`,
    [W],
  );
  await expect(c.query("update trigger_cursors set cursor = '2', version = version + 1")).resolves.toBeDefined();
  await expect(c.query("delete from trigger_cursors")).rejects.toThrow(/permission denied/);
});
