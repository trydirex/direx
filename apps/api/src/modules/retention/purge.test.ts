// SPDX-License-Identifier: AGPL-3.0-only
// The Workspace purge on a seeded Workspace, as the owner, on the disk store (ADR 0030 rules 003, 004
// and 007, spec Testing 5): refusals change nothing; a purge stopped half way fences the Workspace and
// resumes; afterwards no row of it is left in any table, the ledger and consent records included (ADR
// 0030 Q3), nor its workspaces row; its files are gone, its opt-outs live on as keyed hashes read in the
// same Organization only, the receipt holds the counts, the last Workspace of an Organization takes the
// Organization with it, and a second Organization's Workspace is untouched.
import type { OpenAPIHono } from "@hono/zod-openapi";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, expect, test } from "vitest";
import { ownerClient } from "../../../../../test/db";
import { createBoss } from "../../jobs/boss";
import { createVault, rootKeyFromEnv, suppressionHasher } from "../credentials/index";
import { TEST_SECRET, testIdentity } from "../media/fixtures/support";
import { createMedia, diskStore, mediaRoutes } from "../media/index";
import { outreachFloors } from "../outreach/index";
import { addKey, createPerson } from "../people/index";
import { withWorkspace, WorkspacePurging } from "./fixtures/purge";
import { createExports, EXPORT_QUEUE, exportRoutes, previewPurge, PurgeRefused, purgeWorkspace, type OwnerDb, type Receipt } from "./index";

process.env.DIREX_AUTH_SECRET = TEST_SECRET;
const dir = await mkdtemp(join(tmpdir(), "direx-purge-"));
afterAll(() => rm(dir, { recursive: true, force: true }));
const store = diskStore(dir);
const files = createMedia({ store: () => store, now: () => new Date() });
const exports = createExports({ store: () => store, now: () => new Date(), scratch: () => dir });
const { routes, auth, signIn, createOrg, call } = testIdentity();
(routes as unknown as OpenAPIHono).route("/", mediaRoutes({ media: () => files }));
(routes as unknown as OpenAPIHono).route("/", exportRoutes({ auth, exports: () => exports }));

const sent: { exportOf: string; exportId: string }[] = [];
const handlers = new Map<string, (jobs: { data: unknown }[]) => Promise<unknown>>();
await exports.work({
  createQueue: async () => {},
  schedule: async () => {},
  work: (async (queue: string, handler: (jobs: { data: unknown }[]) => Promise<unknown>) => void handlers.set(queue, handler)) as never,
  send: (async (_queue: string, data: { exportOf: string; exportId: string }) => void sent.push(data)) as never,
});

const db = await ownerClient();
afterAll(() => db.end());
const vault = createVault({ rootKey: rootKeyFromEnv({ DIREX_MASTER_KEY: "11".repeat(32) })!, now: () => new Date() });
const hasher = suppressionHasher(vault);
const deps = { db, store, hasher, batch: 2 };
const SYSTEM = "00000000-0000-4000-8000-00000000d1e0";
const LEDGER = ["public.actions", "public.action_events", "public.approvals", "public.person_eligibility", "public.people"];

const tenantTables = async () =>
  (
    await db.query(
      `select n.nspname || '.' || c.relname as t from pg_class c join pg_namespace n on n.oid = c.relnamespace
       where n.nspname = 'public' and c.relkind in ('r', 'p') and not c.relispartition
         and exists (select 1 from pg_attribute a where a.attrelid = c.oid and a.attname = 'workspace_id')`,
    )
  ).rows.map((r) => r.t as string);
const counts = async (ws: string) => {
  const out: Record<string, number> = {};
  for (const t of await tenantTables()) {
    const n = Number((await db.query(`select count(*) from ${t} where workspace_id = $1`, [ws])).rows[0].count);
    if (n) out[t] = n;
  }
  return out;
};
const jobs = async (ws: string) =>
  Number((await db.query(`select count(*) from pgboss.job where data->>'workspaceId' = $1 or data->>'exportOf' = $1`, [ws])).rows[0].count);

/** A Workspace with rows across the product: files, an export, a credential, People, opt-outs, Actions in each final state, a consent record and jobs. */
async function seed(name: string) {
  const cookie = await signIn();
  const { workspace } = await createOrg(cookie, name);
  const ws = workspace.id;
  const user = (await db.query(`select user_id from workspace_members where workspace_id = $1`, [ws])).rows[0].user_id as string;
  const mp4 = new Uint8Array(64);
  mp4.set([0, 0, 0, 0x20, ...new TextEncoder().encode("ftypisom")]);
  const up = await routes.request(`/api/w/${ws}/media?kind=clip`, { method: "POST", headers: { cookie, "x-file-name": "clip.mp4" }, body: mp4 });
  expect(up.status).toBe(201);
  expect((await call(`/api/exports/${ws}`, cookie, { method: "POST" })).status).toBe(202);
  await handlers.get(EXPORT_QUEUE)!(sent.splice(0).map((data) => ({ data })));
  const made = await vault.create({ workspaceId: ws, actorUserId: user, scope: "workspace", kind: "api_key", key: "mailbox", name: "Mailbox", meta: {}, value: { key: "sealed-secret" } });
  if (!made.ok) throw new Error(made.reason);
  const consented = await createPerson(ws);
  expect((await addKey(ws, consented, "email", `kept-${name}@example.com`)).ok).toBe(true);
  const other = await createPerson(ws);
  expect((await addKey(ws, other, "email", `other-${name}@example.com`)).ok).toBe(true);
  await db.query(`insert into suppressions (workspace_id, email, reason, created_at) values ($1, $2, 'unsubscribe', now()), ($1, $3, 'hard_bounce', now())`, [
    ws,
    `gone-${name}@example.com`,
    `Bounced-${name}@Example.com`,
  ]);
  await db.query(
    `insert into person_eligibility (workspace_id, person_id, country, basis, evidence, recorded_by, recorded_at) values ($1, $2, 'CA', 'consent', 'signed up', $3, now())`,
    [ws, consented, user],
  );
  const action = (
    await db.query(
      `insert into actions (workspace_id, idempotency_key, capability, dedupe_class, state, spec, spec_hash, credential_id, created_at, updated_at)
       values ($1, gen_random_uuid(), 'com.trydirex.gmail/email.send', 'queryable', 'sent', '{}'::jsonb, 'h', $2, now(), now()) returning id`,
      [ws, made.credential.id],
    )
  ).rows[0].id as string;
  await db.query(`insert into action_events (workspace_id, action_id, to_state, version, actor_system, at) values ($1, $2, 'sent', 1, 'dispatcher', now())`, [ws, action]);
  for (const [state, block] of [["blocked", "suppressed"], ["cancelled", null]]) {
    const ended = (
      await db.query(
        `insert into actions (workspace_id, idempotency_key, capability, dedupe_class, state, block_reason, spec, spec_hash, created_at, updated_at)
         values ($1, gen_random_uuid(), 'com.trydirex.gmail/email.send', 'queryable', $2, $3, '{}'::jsonb, 'h', now(), now()) returning id`,
        [ws, state, block],
      )
    ).rows[0].id as string;
    await db.query(`insert into action_events (workspace_id, action_id, to_state, version, actor_system, at) values ($1, $2, $3, 1, 'dispatcher', now())`, [ws, ended, state]);
  }
  // Two plans, a campaign each. Each campaign's second step depends on its first (a table that references
  // itself). A standing rule on the first campaign's first step covers the sent Action's approval.
  const campaign = async () => {
    const plan = (await db.query(`insert into marketing_plans (workspace_id, title, created_at, updated_at) values ($1, 'Plan', now(), now()) returning id`, [ws])).rows[0].id;
    return (await db.query(`insert into campaigns (workspace_id, plan_id, owner_user_id, created_at, updated_at) values ($1, $2, $3, now(), now()) returning id`, [ws, plan, user])).rows[0].id as string;
  };
  const [ruled, dropped] = [await campaign(), await campaign()];
  for (const campaign of [ruled, dropped]) {
    await db.query(`insert into campaign_steps (workspace_id, campaign_id, step_key, type, updated_at) values ($1, $2, 's1', 'email', now())`, [ws, campaign]);
    await db.query(`insert into campaign_steps (workspace_id, campaign_id, step_key, type, depends_on_step_key, updated_at) values ($1, $2, 's2', 'email', 's1', now())`, [ws, campaign]);
  }
  const rule = (
    await db.query(
      `insert into standing_rules (workspace_id, capability, touch_class, campaign_id, step_key, template_revision, facts, capability_hash, daily_cap, expires_at, granted_by, granted_at, people_as_of)
       values ($1, 'cap', 'cold', $2, 's1', 1, '[]', 'hash', 50, now() + interval '90 days', $3, now(), now()) returning id`,
      [ws, ruled, user],
    )
  ).rows[0].id;
  await db.query(
    `insert into approvals (workspace_id, action_id, draft_version, spec_hash, snapshot, approver_id, approved_at, key_id, signature, standing_rule_id)
     values ($1, $2, 1, 'h', '{}'::jsonb, $3, now(), 'k', 's', $4)`,
    [ws, action, user, rule],
  );
  const boss = createBoss({ consume: false });
  await boss.start();
  try {
    await boss.createQueue("purge_test");
    await boss.createQueue(EXPORT_QUEUE);
    const later = { startAfter: new Date(Date.now() + 3_600_000) };
    await boss.send("purge_test", { workspaceId: ws }, later);
    await boss.send(EXPORT_QUEUE, { exportOf: ws, exportId: crypto.randomUUID() }, later);
  } finally {
    await boss.stop({ graceful: false, close: true });
  }
  const keys = (await db.query(`select storage_key from media where workspace_id = $1 union all select storage_key from workspace_exports where workspace_id = $1`, [ws])).rows.map(
    (r) => r.storage_key as string,
  );
  const orgId = (await db.query(`select org_id from workspaces where id = $1`, [ws])).rows[0].org_id as string;
  return { ws, cookie, user, consented, orgId, keys };
}

const W = await seed("purged");
// Another Workspace of the same Organization, so the Organization outlives W's purge.
const sibling = crypto.randomUUID();
await db.query(`insert into workspaces (id, org_id, name, created_at) values ($1, $2, 'Return', now())`, [sibling, W.orgId]);
const W2 = await seed("kept");
const beforeW2 = await counts(W2.ws);
let beforeW: Record<string, number>;

const refusal = (ws: string) => purgeWorkspace(ws, "cli:test", deps).then(
  () => "purged",
  (e: unknown) => (e instanceof PurgeRefused ? e.reason : Promise.reject(e)),
);
const receipts = async (ws: string) => (await db.query(`select * from system.purge_receipts where workspace = $1`, [ws])).rows;

test("the purge refuses a live, recent or system Workspace and one with an Action in flight, and changes nothing", async () => {
  expect(await refusal(W.ws)).toBe("live");
  expect((await previewPurge(db, W.ws)).refusal).toBe("live");
  await db.query(`update workspaces set deleted_at = now() - interval '29 days' where id = $1`, [W.ws]);
  expect(await refusal(W.ws)).toBe("recent");
  expect(await refusal(SYSTEM)).toBe("system");
  expect(await refusal(crypto.randomUUID())).toBe("not_found");

  // An unknown outcome is held, not final: it may have gone out, so a person settles it first.
  const busy = await seed("busy");
  await db.query(`update workspaces set deleted_at = now() - interval '31 days' where id = $1`, [busy.ws]);
  await db.query(
    `insert into actions (workspace_id, idempotency_key, capability, dedupe_class, state, hold_reason, spec, spec_hash, created_at, updated_at)
     values ($1, gen_random_uuid(), 'com.trydirex.gmail/email.send', 'queryable', 'held', 'outcome_unknown', '{}'::jsonb, 'h', now(), now())`,
    [busy.ws],
  );
  expect(await refusal(busy.ws)).toBe("in_flight");

  for (const ws of [W.ws, busy.ws]) {
    expect(await receipts(ws)).toEqual([]);
    expect((await db.query(`select purging_at from workspaces where id = $1`, [ws])).rows[0].purging_at).toBeNull();
    expect(await jobs(ws)).toBe(2);
  }
  expect(await withWorkspace(W.ws, async () => "reachable")).toBe("reachable");
});

test("a purge stopped half way fences the Workspace from requests and jobs, then resumes where it stopped", async () => {
  await db.query(`update workspaces set deleted_at = now() - interval '31 days' where id = $1`, [W.ws]);
  const preview = await previewPurge(db, W.ws);
  expect(preview).toMatchObject({ refusal: null, jobs: 2, files: 2 });
  expect(preview.remove).toMatchObject({ "public.actions": 3, "public.action_events": 3, "public.approvals": 1, "public.person_eligibility": 1, "public.workspaces": 1 });
  expect(preview.remove["public.organizations"]).toBeUndefined();
  beforeW = await counts(W.ws);

  // The connection drops on the fourth batch of rows.
  let batches = 0;
  const flaky: OwnerDb = {
    query: (text, params) => {
      if (text.includes("purge_workspace_batch") && params?.[1] !== "pgboss.job" && ++batches === 4) return Promise.reject(new Error("connection lost"));
      return db.query(text, params);
    },
  };
  await expect(purgeWorkspace(W.ws, "cli:test", { ...deps, db: flaky })).rejects.toThrow("connection lost");

  const [open] = await receipts(W.ws);
  expect(open).toMatchObject({ actor: "cli:test", outcome: null, files_removed: 2, hashes_written: 2 });
  expect(await jobs(W.ws)).toBe(0);
  for (const key of W.keys) expect(existsSync(join(dir, key))).toBe(false);
  // No request or job reaches it from here: a member's export routes are gone, and a job's transaction is refused.
  expect((await call(`/api/exports/${W.ws}`, W.cookie)).status).toBe(404);
  await expect(withWorkspace(W.ws, async () => "reachable")).rejects.toBeInstanceOf(WorkspacePurging);
  const exportId = (await db.query(`select id from workspace_exports where workspace_id = $1`, [W.ws])).rows[0]?.id ?? crypto.randomUUID();
  await expect(handlers.get(EXPORT_QUEUE)!([{ data: { exportOf: W.ws, exportId } }])).rejects.toBeInstanceOf(WorkspacePurging);
  // Its suppression rows stay until the hashes are written, which they are; nothing is purged twice.
  expect(await refusal(W.ws)).toBe("purged");
});

let receipt: Receipt;
test("the purged Workspace leaves no row in any table, its own row included, and the receipt holds every count", async () => {
  const [closed] = await receipts(W.ws);
  receipt = { ...closed, rows: closed.rows, kept: closed.kept } as Receipt;
  expect(receipt).toMatchObject({ outcome: "purged", replay: false, files_removed: 2, hashes_written: 2 });
  // The ledger, the consent record, its Person, the credential, the standing rule, the campaigns and the plans all go.
  expect(receipt.kept).toEqual({});
  expect(await counts(W.ws)).toEqual({});
  for (const t of LEDGER) expect(receipt.rows[t], t).toBeGreaterThan(0);
  // Jobs are counted with the rows, under their table; the workspaces row is among the rows.
  const removed: Record<string, number> = { "pgboss.job": 2, ...beforeW };
  expect(receipt.rows).toEqual(removed);
  expect(Object.keys(removed).length).toBeGreaterThan(10);
  // No credential, Person or Workspace row is left; the Organization stays for its other Workspace.
  expect((await db.query(`select ciphertext, nonce, deleted_at from credentials where workspace_id = $1`, [W.ws])).rows).toEqual([]);
  expect((await db.query(`select id from people where workspace_id = $1`, [W.ws])).rows).toEqual([]);
  expect((await db.query(`select w.id, o.id as org from organizations o left join workspaces w on w.id = $1 where o.id = $2`, [W.ws, W.orgId])).rows[0]).toEqual({ id: null, org: W.orgId });
  // The receipt names tables and counts, nothing a person wrote.
  expect(JSON.stringify(receipt)).not.toMatch(/example\.com|Mailbox|purged marketing/);
  // Purged once is purged: there is no row left to purge again.
  expect(await refusal(W.ws)).toBe("purged");
});

test("its opt-outs live on as keyed hashes, read by the send-time check of the same Organization only", async () => {
  const hash = (await hasher())!;
  expect(hash).not.toBeNull();
  const stored = (await db.query(`select org_id, hash from system.suppression_hashes order by hash`)).rows;
  expect(stored).toEqual(
    [hash("gone-purged@example.com"), hash("bounced-purged@example.com")].sort().map((h) => ({ org_id: W.orgId, hash: h })),
  );
  expect(JSON.stringify(stored)).not.toContain("example.com");

  // The other Workspace of the same Organization, and one elsewhere, each with a Person at the opted-out address.
  const check = outreachFloors(async () => true, () => new Date(), hasher);
  const verdict = async (ws: string, address: string) => {
    const personId = await createPerson(ws);
    expect((await addKey(ws, personId, "email", address)).ok).toBe(true);
    const action = { capability: "com.trydirex.gmail/email.send", spec: { touch: { personId, touchClass: "cold" } }, workspaceId: ws, credentialId: null };
    return withWorkspace(ws, (tx) => check(tx, action as never, { approverId: W.user, standingRuleId: null, producerDigest: null }));
  };
  expect(await verdict(sibling, "Gone-Purged@example.com")).toEqual({ kind: "block", reason: "suppressed" });
  expect(await verdict(sibling, "fresh@example.com")).not.toEqual({ kind: "block", reason: "suppressed" });
  // A placement email names no Person, only addresses, and is held to the same opt-outs.
  const placement = (ws: string, to: string) =>
    withWorkspace(ws, (tx) => check(tx, { capability: "com.trydirex.gmail/placement.send", spec: { to: [to] }, workspaceId: ws, credentialId: null } as never, { approverId: W.user, standingRuleId: null, producerDigest: null }));
  expect(await placement(sibling, "bounced-purged@example.com")).toEqual({ kind: "block", reason: "suppressed" });
  expect(await placement(sibling, "fresh@example.com")).toEqual({ kind: "ok" });
  const elsewhere = (await createOrg(await signIn(), "Elsewhere")).workspace.id;
  expect(await verdict(elsewhere, "gone-purged@example.com")).not.toEqual({ kind: "block", reason: "suppressed" });
});

test("purging the last Workspace of an Organization removes the Organization too, and its hashes stay", async () => {
  const last = await seed("last");
  await db.query(`update workspaces set deleted_at = now() - interval '31 days' where id = $1`, [last.ws]);
  expect((await previewPurge(db, last.ws)).remove["public.organizations"]).toBe(1);
  const done = await purgeWorkspace(last.ws, "cli:test", deps);
  expect(done.kept).toEqual({});
  expect(done.rows).toMatchObject({ "public.actions": 3, "public.person_eligibility": 1, "public.workspaces": 1, "public.organizations": 1 });
  expect(await counts(last.ws)).toEqual({});
  expect((await db.query(`select id from organizations where id = $1`, [last.orgId])).rows).toEqual([]);
  // The hashes carry the Organization id as a plain value, with no foreign key, so they outlive it.
  expect(Number((await db.query(`select count(*) from system.suppression_hashes where org_id = $1`, [last.orgId])).rows[0].count)).toBe(2);
});

test("the second Organization's Workspace is untouched: its rows, jobs and files", async () => {
  expect(await counts(W2.ws)).toEqual(beforeW2);
  expect((await db.query(`select id from organizations where id = $1`, [W2.orgId])).rows).toEqual([{ id: W2.orgId }]);
  expect(await jobs(W2.ws)).toBe(2);
  for (const key of W2.keys) expect(existsSync(join(dir, key))).toBe(true);
  expect(await receipts(W2.ws)).toEqual([]);
});
