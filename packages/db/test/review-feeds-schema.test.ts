// SPDX-License-Identifier: AGPL-3.0-only
// Database-level guarantees of review feeds, as direx_app inside one Workspace.
import { afterAll, beforeAll, expect, test } from "vitest";
import type pg from "pg";
import { withWorkspace } from "../src/index";
import { organizations, workspaceMembers, workspaces } from "../src/schema";
import { appClient, insertAuthUser } from "../../../test/db";

let c: pg.Client;
const W = crypto.randomUUID();
const OTHER = crypto.randomUUID();
const hash = () => Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("hex");

async function workspaceWith(w: string, ...users: string[]) {
  const orgId = crypto.randomUUID();
  const at = new Date();
  await withWorkspace(w, async (tx) => {
    await tx.insert(organizations).values({ id: orgId, name: "Org", createdAt: at });
    await tx.insert(workspaces).values({ id: w, orgId, name: "W", createdAt: at });
    for (const u of users) await tx.insert(workspaceMembers).values({ workspaceId: w, userId: u, role: "marketer", createdAt: at });
  });
}

const add = (o: { user: string; weekdays?: string; start?: number; length?: number; zone?: string; token?: string }) =>
  c.query(
    `insert into review_feeds (workspace_id, user_id, token_hash, weekdays, start_minute, length_minutes, time_zone, created_at)
     values ($1, $2, $3, $4::int[], $5, $6, $7, now())`,
    [W, o.user, o.token ?? hash(), o.weekdays ?? "{2,4}", o.start ?? 600, o.length ?? 30, o.zone ?? "Europe/London"],
  );

const users = Array.from({ length: 4 }, () => crypto.randomUUID());
beforeAll(async () => {
  for (const u of users) await insertAuthUser(u);
  await workspaceWith(W, ...users);
  await workspaceWith(OTHER);
  c = await appClient();
  await c.query("select set_config('app.workspace_id', $1, false)", [W]);
});
afterAll(() => c.end());

test("weekdays, start, length, time zone and token shape are checked", async () => {
  const u = users[0]!;
  await expect(add({ user: u, weekdays: "{0}" })).rejects.toThrow(/review_feeds_weekdays_check/);
  await expect(add({ user: u, weekdays: "{8}" })).rejects.toThrow(/review_feeds_weekdays_check/);
  await expect(add({ user: u, weekdays: "{}" })).rejects.toThrow(/review_feeds_weekdays_check/);
  await expect(add({ user: u, start: 1440 })).rejects.toThrow(/review_feeds_start_check/);
  await expect(add({ user: u, length: 45 })).rejects.toThrow(/review_feeds_length_check/);
  await expect(add({ user: u, zone: "" })).rejects.toThrow(/review_feeds_time_zone_check/);
  await expect(add({ user: u, token: "not-a-hash" })).rejects.toThrow(/review_feeds_token_hash_check/);
  await expect(add({ user: u })).resolves.toBeDefined();
});

test("one feed per member, and a token hash is never shared", async () => {
  const token = hash();
  await add({ user: users[1]!, token });
  await expect(add({ user: users[1]! })).rejects.toThrow(/review_feeds_pkey/);
  await expect(add({ user: users[2]!, token })).rejects.toThrow(/review_feeds_token_hash_key/);
});

test("only a member can have a feed, and leaving the Workspace deletes it", async () => {
  await expect(add({ user: crypto.randomUUID() })).rejects.toThrow(/review_feeds_member_fk/);
  const u = users[3]!;
  await add({ user: u });
  await c.query("delete from workspace_members where workspace_id = $1 and user_id = $2", [W, u]);
  expect((await c.query("select 1 from review_feeds where user_id = $1", [u])).rowCount).toBe(0);
});

test("another Workspace sees none of these feeds", async () => {
  await c.query("select set_config('app.workspace_id', $1, false)", [OTHER]);
  try {
    expect((await c.query("select 1 from review_feeds")).rowCount).toBe(0);
  } finally {
    await c.query("select set_config('app.workspace_id', $1, false)", [W]);
  }
});
