// SPDX-License-Identifier: AGPL-3.0-only
// Database-level guarantees of ask_starts, as direx_app: one row per accepted Ask start, tied to
// its own Workspace's message and Item, with at most one outcome.
import { afterAll, beforeAll, expect, test } from "vitest";
import type pg from "pg";
import { withWorkspace } from "../src/index";
import { organizations, workspaces } from "../src/schema";
import { appClient, insertAuthUser } from "../../../test/db";

let c: pg.Client;
const USER = crypto.randomUUID();
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
const one = async (text: string, params: unknown[]) => (await c.query(text, params)).rows[0].id as string;
/** A message and an `ask_start` Item in Workspace w. */
async function offered(w: string) {
  await enter(w);
  const message = await one(`insert into ask_messages (workspace_id, user_id, text, created_at) values ($1, $2, 'Draft the plan', now()) returning id`, [w, USER]);
  const item = await one(`insert into items (workspace_id, kind, state, title, warnings, created_at, updated_at) values ($1, 'ask_start', 'needs_approval', 't', '[]', now(), now()) returning id`, [w]);
  return { message, item };
}
const start = (w: string, o: { message: string; item: string; workKind?: string | null; workId?: string | null; refused?: string | null }) =>
  c.query(`insert into ask_starts (workspace_id, item_id, message_id, work_kind, work_id, refused, created_at) values ($1, $2, $3, $4, $5, $6, now())`, [w, o.item, o.message, o.workKind ?? null, o.workId ?? null, o.refused ?? null]);

let W: string;
let OTHER: string;
beforeAll(async () => {
  await insertAuthUser(USER);
  c = await appClient();
  W = await newWorkspace();
  OTHER = await newWorkspace();
});
afterAll(() => c.end());

test("a start holds either the work it made or why it was refused, never both and never half a reference", async () => {
  const a = await offered(W);
  await expect(start(W, { ...a, workKind: "agent_run" })).rejects.toThrow(/ask_starts_work_check/);
  await expect(start(W, { ...a, workKind: "agent_run", workId: "r1", refused: "moved_on" })).rejects.toThrow(/ask_starts_outcome_check/);
  await expect(start(W, a)).resolves.toBeDefined();
  await expect(start(W, a)).rejects.toThrow(/ask_starts_pkey/);
  await c.query(`update ask_starts set work_kind = 'agent_run', work_id = 'r1' where item_id = $1`, [a.item]);
  const b = await offered(W);
  await expect(start(W, { ...b, refused: "not_found" })).resolves.toBeDefined();
});

test("a start can name only its own Workspace's message and Item, and is never deleted", async () => {
  const theirs = await offered(OTHER);
  const ours = await offered(W);
  await expect(start(W, { message: theirs.message, item: ours.item })).rejects.toThrow(/ask_starts_message_fk/);
  await expect(start(W, { message: ours.message, item: theirs.item })).rejects.toThrow(/ask_starts_item_fk/);
  await expect(start(OTHER, ours)).rejects.toThrow(/row-level security/);
  await start(W, ours);
  await expect(c.query(`delete from ask_starts where item_id = $1`, [ours.item])).rejects.toThrow(/permission denied/);
  await enter(OTHER);
  expect((await c.query(`select 1 from ask_starts where item_id = $1`, [ours.item])).rowCount).toBe(0);
});
