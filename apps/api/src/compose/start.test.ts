// SPDX-License-Identifier: AGPL-3.0-only
// The queues, schedules and consumers the server registers, against a list recorded before the
// composition-root refactor (ADR 0027 rules 001 and 003). Moving construction around must not add,
// drop or reconfigure one. DIREX_RECORD_QUEUES=1 rewrites the list; review that diff like code.
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { withWorkspace } from "@direx/db";
import { sql } from "drizzle-orm";
import { PgBoss } from "pg-boss";
import { afterAll, expect, test, vi } from "vitest";
import { runServer } from "../main";
import { createTokens, DOOR_BASE } from "../modules/door/index";
import { createVault, rootKeyFromEnv } from "../modules/credentials/index";
import { seedWorkspace } from "../modules/door/fixtures/members";

process.env.DIREX_MASTER_KEY = "11".repeat(32);
const FIXTURE = join(import.meta.dirname, "fixtures", "queues.json");

type Registration = { kind: "queue" | "schedule" | "work"; name: string; cron?: string; options: unknown };
const seen: Registration[] = [];
// Each spy records the call and passes it through, so the server starts as it always does.
const realCreateQueue = PgBoss.prototype.createQueue;
vi.spyOn(PgBoss.prototype, "createQueue").mockImplementation(async function (this: PgBoss, name, options) {
  seen.push({ kind: "queue", name, options: options ?? null });
  return realCreateQueue.call(this, name, options);
});
const realSchedule = PgBoss.prototype.schedule;
vi.spyOn(PgBoss.prototype, "schedule").mockImplementation(async function (this: PgBoss, name, cron, data, options) {
  seen.push({ kind: "schedule", name, cron, options: { data: data ?? null, ...options } });
  return realSchedule.call(this, name, cron, data, options);
});
const realWork = PgBoss.prototype.work as (...a: unknown[]) => Promise<string>;
vi.spyOn(PgBoss.prototype, "work").mockImplementation(async function (this: PgBoss, ...args: unknown[]) {
  seen.push({ kind: "work", name: args[0] as string, options: typeof args[1] === "function" ? null : args[1] });
  return realWork.apply(this, args);
});

const worker = await runServer();
afterAll(() => worker.stop());

test("the server registers the same queues, schedules and consumers as before the refactor", () => {
  const list = seen.map((r) => JSON.stringify(r)).sort();
  if (process.env.DIREX_RECORD_QUEUES === "1") writeFileSync(FIXTURE, `${JSON.stringify(list.map((s) => JSON.parse(s)), null, 2)}\n`);
  const recorded = (JSON.parse(readFileSync(FIXTURE, "utf8")) as unknown[]).map((r) => JSON.stringify(r)).sort();
  expect(list).toEqual(recorded);
  expect(list.length).toBeGreaterThan(30);
});

test("a token lifetime the server can't allow stops the start, naming the variable", async () => {
  process.env.DIREX_EXTERNAL_TOKEN_MAX_DAYS = "12";
  try {
    await expect(runServer()).rejects.toThrow(/DIREX_EXTERNAL_TOKEN_MAX_DAYS must be a whole number of days from 91 to 365, not 12/);
  } finally {
    delete process.env.DIREX_EXTERNAL_TOKEN_MAX_DAYS;
  }
});

test("the server takes a token's proposals: a fact waits for a person, and a draft for an account that isn't connected is refused", async () => {
  const w = crypto.randomUUID();
  const owner = crypto.randomUUID();
  await seedWorkspace(w, owner);
  const t = await createTokens({ maxDays: null }).create(w, { name: "Script", days: 7, readers: [], kinds: ["fact_proposal", "draft"] }, owner);
  if (!t.ok) throw new Error(t.reason);
  const send = (kind: string, body: unknown) => worker.app.request(`${DOOR_BASE}/w/${w}/${kind}`, { method: "POST", headers: { authorization: `Bearer ${t.token}`, "content-type": "application/json" }, body: JSON.stringify(body) });
  const fact = await send("fact_proposal", { idempotencyKey: "f1", field: "what_you_sell", value: "Marketing software" });
  expect([fact.status, await fact.json()]).toEqual([200, { itemId: expect.any(String) }]);
  const draft = await send("draft", { idempotencyKey: "d1", connection: "nowhere", text: "Hello", at: new Date(Date.now() + 86_400_000).toISOString() });
  expect(draft.status).toBe(422);
  expect(await draft.json()).toMatchObject({ error: "refused" });
});


test("mounted drafts with Actions count toward waiting caps and a pool-sized burst completes", async () => {
  const w = crypto.randomUUID();
  const owner = crypto.randomUUID();
  await seedWorkspace(w, owner);
  const vault = createVault({ rootKey: rootKeyFromEnv({ DIREX_MASTER_KEY: process.env.DIREX_MASTER_KEY! })!, now: () => new Date() });
  const credential = await vault.create({ workspaceId: w, actorUserId: owner, scope: "workspace", kind: "api_key", key: "test-account", name: "Test account", meta: {}, value: { key: "synthetic" } });
  if (!credential.ok) throw new Error(credential.reason);
  const credentialId = credential.credential.id;
  await withWorkspace(w, async (tx) => {
    await tx.execute(sql`update credentials set kind = 'oauth2', scope = 'user', owner_user_id = ${owner}, connection = 'linkedin', meta = '{"scopes":["w_member_social"]}' where id = ${credentialId}`);
    await tx.execute(sql`insert into social_accounts (workspace_id, credential_id, connection, account_type, network_id, name) values (${w}, ${credentialId}, 'linkedin', 'member', 'test-member', 'Test account')`);
  });
  const token = await createTokens({ maxDays: null }).create(w, { name: "Drafts", days: 7, readers: [], kinds: ["draft"] }, owner);
  if (!token.ok) throw new Error(token.reason);
  const send = (i: number) => worker.app.request(`${DOOR_BASE}/w/${w}/draft`, { method: "POST", headers: { authorization: `Bearer ${token.token}`, "content-type": "application/json" }, body: JSON.stringify({ idempotencyKey: `draft-${i}`, connection: "linkedin", credentialId, networkId: "test-member", text: "Hello", at: new Date(Date.now() + 86_400_000).toISOString() }) });
  const burst = await Promise.all(Array.from({ length: 10 }, (_, i) => send(i)));
  expect(burst.map((r) => r.status)).toEqual(Array(10).fill(200));
  for (let i = 10; i < 20; i++) expect((await send(i)).status).toBe(200);
  expect((await send(20)).status).toBe(429);
  await withWorkspace(w, async (tx) => {
    const r = await tx.execute(sql`select count(*)::int as n from items i join actions a on a.id = i.action_id and a.workspace_id = i.workspace_id where a.state = 'needs_approval'`);
    expect(r.rows[0]).toEqual({ n: 20 });
  });
}, 30_000);
