// SPDX-License-Identifier: AGPL-3.0-only
// The newsletter_subscribers table: a re-read keeps every address, each Workspace sees only its
// own rows, and the app role can't delete one.
import { afterAll, expect, test } from "vitest";
import { appClient } from "../../../../../test/db";
import { createVault, rootKeyFromEnv } from "../credentials/index";
import { inWorkspace, subscribedAmong, upsertSubscribers } from "./adapters/repo";
import { testIdentity } from "./fixtures/support";

const vault = createVault({ rootKey: rootKeyFromEnv({ DIREX_MASTER_KEY: "11".repeat(32) })!, now: () => new Date() });
const { signIn, createOrg } = testIdentity();
const cookie = await signIn();
const A = (await createOrg(cookie, "Letters A")).workspace.id;
const B = (await createOrg(cookie, "Letters B")).workspace.id;
const db = await appClient();
afterAll(() => db.end());

async function ownerOf(workspaceId: string) {
  await db.query("begin");
  await db.query("select set_config('app.workspace_id', $1, true)", [workspaceId]);
  const r = await db.query("select user_id from workspace_members limit 1");
  await db.query("commit");
  return r.rows[0].user_id as string;
}
async function list(workspaceId: string) {
  const made = await vault.create({ workspaceId, actorUserId: await ownerOf(workspaceId), scope: "workspace", kind: "api_key", key: `api_key:kit`, name: "Kit", meta: {}, value: { key: "x" } });
  if (!made.ok) throw new Error(made.reason);
  return made.credential.id;
}
const listA = await list(A);
const listB = await list(B);
const day = (d: number) => new Date(Date.UTC(2026, 10, d, 5));

test("a second read keeps an address the tool stopped listing, and updates the rest", async () => {
  await inWorkspace(A, (tx) => upsertSubscribers(tx, A, listA, [{ email: "Anna@Example.com", state: "subscribed" }, { email: "ben@example.com", state: "subscribed" }], day(4)));
  await inWorkspace(A, (tx) => upsertSubscribers(tx, A, listA, [{ email: "anna@example.com", state: "unsubscribed" }], day(5)));
  const rows = await inWorkspace(A, (tx) => subscribedAmong(tx, ["ANNA@example.com", "ben@example.com", "carl@example.com"]));
  expect(rows.map((r) => r.email).sort()).toEqual(["anna@example.com", "ben@example.com"]);
  expect(rows.find((r) => r.email === "anna@example.com")?.firstSeenAt).toEqual(day(4));
  await db.query("begin");
  await db.query("select set_config('app.workspace_id', $1, true)", [A]);
  const states = (await db.query("select email, state, last_seen_at from newsletter_subscribers order by email")).rows;
  await db.query("commit");
  expect(states.map((s) => [s.email, s.state])).toEqual([
    ["anna@example.com", "unsubscribed"],
    ["ben@example.com", "subscribed"],
  ]);
});

test("one Workspace never sees another's subscribers", async () => {
  await inWorkspace(B, (tx) => upsertSubscribers(tx, B, listB, [{ email: "dora@example.com", state: "subscribed" }], day(4)));
  expect(await inWorkspace(A, (tx) => subscribedAmong(tx, ["dora@example.com"]))).toEqual([]);
  expect((await inWorkspace(B, (tx) => subscribedAmong(tx, ["dora@example.com"]))).map((r) => r.credentialId)).toEqual([listB]);
});

test("the app can't delete a subscriber row", async () => {
  await db.query("begin");
  await db.query("select set_config('app.workspace_id', $1, true)", [A]);
  await expect(db.query("delete from newsletter_subscribers")).rejects.toThrow(/permission denied/);
  await db.query("rollback");
});

test("a page with the same address twice keeps its last state", async () => {
  await inWorkspace(A, (tx) => upsertSubscribers(tx, A, listA, [{ email: "eve@example.com", state: "subscribed" }, { email: "EVE@example.com", state: "bounced" }], day(6)));
  await db.query("begin");
  await db.query("select set_config('app.workspace_id', $1, true)", [A]);
  const r = await db.query("select state from newsletter_subscribers where email = 'eve@example.com'");
  await db.query("commit");
  expect(r.rows).toEqual([{ state: "bounced" }]);
});
