// SPDX-License-Identifier: AGPL-3.0-only
// A Workspace export over HTTP, on the disk store (ADR 0030 rule 008, spec Testing 4): Owners only and
// only their own Workspace; the ZIP holds every table the Workspace has rows in and its media files,
// and no ciphertext, key or token hash; it holds the proof Direx keeps no copy of after a purge (the
// ledger, consent records with their evidence, People and plaintext opt-outs); a deleted Workspace still
// exports; after 24 hours it is gone.
import type { OpenAPIHono } from "@hono/zod-openapi";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, expect, test } from "vitest";
import { ownerClient } from "../../../../../test/db";
import { TEST_SECRET, testIdentity } from "../media/fixtures/support";
import { createMedia, diskStore, mediaRoutes } from "../media/index";
import { addKey, createPerson } from "../people/index";
import { TENANT_TABLES } from "./adapters/export-repo";
import { KEPT, OMITTED } from "./domain/omitted";
import { unzip } from "./fixtures/unzip";
import { createExports, EXPORT_QUEUE, EXPORT_SWEEP, exportRoutes } from "./index";

process.env.DIREX_AUTH_SECRET = TEST_SECRET;
const dir = await mkdtemp(join(tmpdir(), "direx-export-"));
afterAll(() => rm(dir, { recursive: true, force: true }));
let now = new Date();
const store = () => diskStore(dir);
const files = createMedia({ store, now: () => now });
const exports = createExports({ store, now: () => now, scratch: () => dir });
const { routes, auth, signIn, createOrg, addMember, call } = testIdentity();
(routes as unknown as OpenAPIHono).route("/", mediaRoutes({ media: () => files }));
(routes as unknown as OpenAPIHono).route("/", exportRoutes({ auth, exports: () => exports }));

// A pg-boss that records: the test runs the build and the sweep by hand.
const sent: { exportOf: string; exportId: string }[] = [];
const handlers = new Map<string, (jobs: { data: unknown }[]) => Promise<unknown>>();
await exports.work({
  createQueue: async () => {},
  schedule: async () => {},
  work: (async (queue: string, handler: (jobs: { data: unknown }[]) => Promise<unknown>) => void handlers.set(queue, handler)) as never,
  send: (async (_queue: string, data: { exportOf: string; exportId: string }) => void sent.push(data)) as never,
});
const runBuilds = async () => {
  await handlers.get(EXPORT_QUEUE)!(sent.splice(0).map((data) => ({ data })));
};

const owner = await signIn();
const W = (await createOrg(owner, "Export")).workspace.id;
const otherOwner = await signIn();
const W2 = (await createOrg(otherOwner, "Other")).workspace.id;

const SECRET = "deadbeefcafe0123";
const TOKEN_HASH = "ab".repeat(32);
const db = await ownerClient();
afterAll(() => db.end());
const user = (await db.query(`select user_id from workspace_members where workspace_id = $1`, [W])).rows[0].user_id as string;
await db.query(`insert into workspace_keys (workspace_id, key_version, wrapped_dek, root_key_id, created_at) values ($1, 7, $2, 'r', now())`, [W, Buffer.from(`${SECRET}-dek`)]);
await db.query(
  `insert into credentials (workspace_id, scope, kind, key, name, ciphertext, nonce, key_version, created_by, created_at, updated_at)
   values ($1, 'workspace', 'api_key', 'k', 'Exported key', $2, $3, 7, $4, now(), now())`,
  [W, Buffer.from(`${SECRET}-sealed`), Buffer.from(`${SECRET}-nonce`), user],
);
await db.query(
  `insert into external_tokens (workspace_id, name, token_hash, hint, readers, kinds, created_by, created_at, expires_at)
   values ($1, 'Agent', $2, 'abcd', '{}', '{}', $3, now(), now() + interval '30 days')`,
  [W, TOKEN_HASH, user],
);

// The customer's proof once the Workspace is purged (ADR 0030 Q3): a consent record with its evidence, the
// Person and address it names, an opt-out, and a sent Action with its approval and event.
const person = await createPerson(W);
expect((await addKey(W, person, "email", "consented@example.com")).ok).toBe(true);
await db.query(
  `insert into person_eligibility (workspace_id, person_id, country, basis, evidence, scope, expires_at, recorded_by, recorded_at)
   values ($1, $2, 'CA', 'consent', 'Signed up at the spring fair', 'Product updates', '2028-01-01T00:00:00Z', $3, now())`,
  [W, person, user],
);
await db.query(`insert into suppressions (workspace_id, email, reason, created_at) values ($1, 'Opted-Out@example.com', 'unsubscribe', now())`, [W]);
const actionId = (
  await db.query(
    `insert into actions (workspace_id, idempotency_key, capability, dedupe_class, state, spec, spec_hash, created_at, updated_at)
     values ($1, gen_random_uuid(), 'com.trydirex.gmail/email.send', 'queryable', 'sent', '{}'::jsonb, 'h', now(), now()) returning id`,
    [W],
  )
).rows[0].id as string;
await db.query(`insert into action_events (workspace_id, action_id, to_state, version, actor_system, at) values ($1, $2, 'sent', 1, 'dispatcher', now())`, [W, actionId]);
await db.query(
  `insert into approvals (workspace_id, action_id, draft_version, spec_hash, snapshot, approver_id, approved_at, key_id, signature) values ($1, $2, 1, 'h', '{}'::jsonb, $3, now(), 'k', 's')`,
  [W, actionId, user],
);

const mp4 = new Uint8Array(64);
mp4.set([0, 0, 0, 0x20, ...new TextEncoder().encode("ftypisom")]);
const uploaded = await routes.request(`/api/w/${W}/media?kind=clip`, { method: "POST", headers: { cookie: owner, "x-file-name": "clip.mp4" }, body: mp4 });
const mediaId = ((await uploaded.json()) as { media: { id: string } }).media.id;

type Listed = { exports: { id: string; state: string; readyAt: string | null; expiresAt: string | null; bytes: number | null }[] };
const start = (workspaceId: string, cookie?: string) => call(`/api/exports/${workspaceId}`, cookie, { method: "POST" });
const list = async (workspaceId: string, cookie = owner) => ((await (await call(`/api/exports/${workspaceId}`, cookie)).json()) as Listed).exports;

test("only an Owner of the Workspace may start, list or download an export", async () => {
  const admin = await addMember(owner, W, "admin");
  expect((await start(W)).status).toBe(401);
  expect((await start(W, admin.cookie)).status).toBe(403);
  expect((await call(`/api/exports/${W}`, admin.cookie)).status).toBe(403);
  expect((await start(W, otherOwner)).status).toBe(404);
  expect(sent).toEqual([]);
});

let zip: Map<string, Buffer>;
let exportId: string;
test("the Owner's export builds once, then downloads as one ZIP", async () => {
  const r = await start(W, owner);
  expect(r.status).toBe(202);
  exportId = ((await r.json()) as { export: { id: string; state: string } }).export.id;
  // A second click while it builds starts nothing.
  expect((await start(W, owner)).status).toBe(409);
  expect(sent).toEqual([{ exportOf: W, exportId }]);
  expect((await list(W))[0]).toMatchObject({ id: exportId, state: "building" });

  await runBuilds();
  const [ready] = await list(W);
  expect(ready).toMatchObject({ id: exportId, state: "ready" });
  expect(Date.parse(ready!.expiresAt!) - Date.parse(ready!.readyAt!)).toBe(24 * 60 * 60_000);
  // Another Workspace's Owner can't fetch it by id.
  expect((await call(`/api/exports/${W2}/${exportId}`, otherOwner)).status).toBe(404);

  const download = await call(`/api/exports/${W}/${exportId}`, owner);
  expect(download.status).toBe(200);
  expect(download.headers.get("content-type")).toBe("application/zip");
  expect(download.headers.get("content-disposition")).toMatch(/^attachment; filename="direx-export-\d{4}-\d{2}-\d{2}\.zip"$/);
  const body = Buffer.from(await download.arrayBuffer());
  expect(body.length).toBe(ready!.bytes);
  zip = unzip(body);
  // Nothing of the ZIP is left in the scratch folder: only the stored export and the media file.
  expect((await readdir(dir, { recursive: true })).filter((f) => f.endsWith(".zip"))).toEqual([]);
});

test("the ZIP holds a JSON Lines file for every tenant table, each row of this Workspace, and its media", async () => {
  const lines = (table: string) => zip.get(`tables/${table}.jsonl`)!.toString("utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as Record<string, unknown>);
  for (const table of TENANT_TABLES) {
    const { rows } = await db.query(`select count(*)::int as n from ${table} where workspace_id = $1`, [W]);
    const got = lines(table.split(".")[1]!);
    expect(got.length, table).toBe(rows[0].n);
    for (const row of got) expect(row.workspace_id, table).toBe(W);
  }
  expect(lines("credentials").map((c) => c.name)).toEqual(["Exported key"]);
  expect(lines("workspaces")).toEqual([expect.objectContaining({ id: W, name: "Export marketing" })]);
  expect(zip.get(`media/${mediaId}.mp4`)).toEqual(Buffer.from(mp4));
  const about = JSON.parse(zip.get("export.json")!.toString("utf8")) as { workspaceId: string; media: string[]; rows: Record<string, number> };
  expect(about).toMatchObject({ workspaceId: W, media: [`media/${mediaId}.mp4`] });
  expect(Object.keys(about.rows)).toEqual(TENANT_TABLES);
});

test("the ZIP holds the proof a purge leaves no copy of: the ledger, consent evidence, People and plaintext opt-outs", async () => {
  const lines = (table: string) => zip.get(`tables/${table}.jsonl`)!.toString("utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as Record<string, unknown>);
  expect(lines("actions")).toEqual([expect.objectContaining({ id: actionId, state: "sent", capability: "com.trydirex.gmail/email.send" })]);
  expect(lines("approvals")).toEqual([expect.objectContaining({ action_id: actionId, approver_id: user })]);
  expect(lines("action_events")).toEqual([expect.objectContaining({ action_id: actionId, to_state: "sent" })]);
  expect(lines("person_eligibility")).toEqual([
    expect.objectContaining({ person_id: person, country: "CA", basis: "consent", evidence: "Signed up at the spring fair", scope: "Product updates", expires_at: expect.stringMatching(/^2028-01-01/), recorded_by: user, recorded_at: expect.any(String) }),
  ]);
  expect(lines("people").map((p) => p.id)).toEqual([person]);
  expect(lines("person_keys")).toEqual([expect.objectContaining({ person_id: person, kind: "email", value: "consented@example.com" })]);
  expect(lines("suppressions")).toEqual([expect.objectContaining({ email: "Opted-Out@example.com", reason: "unsubscribe" })]);
});

test("the ZIP holds no ciphertext, key material or token hash, and nothing of another Workspace", async () => {
  const all = Buffer.concat([...zip.values()]).toString("utf8");
  const hex = Buffer.from(SECRET).toString("hex");
  for (const leak of [SECRET, hex, TOKEN_HASH, W2]) expect(all.includes(leak), leak).toBe(false);
  for (const [table, columns] of Object.entries(OMITTED)) {
    const rows = zip.get(`tables/${table.split(".")[1]}.jsonl`)!.toString("utf8").split("\n").filter(Boolean);
    for (const row of rows) for (const c of columns) expect(Object.keys(JSON.parse(row) as object), `${table}.${c}`).not.toContain(c);
  }
});

test("every column that looks like a secret is omitted or kept on purpose, and every omitted column exists", async () => {
  const { rows } = await db.query(`
    select n.nspname || '.' || c.relname as tbl, a.attname as col, format_type(a.atttypid, a.atttypmod) as type
    from pg_attribute a join pg_class c on c.oid = a.attrelid join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relkind = 'r' and a.attnum > 0 and not a.attisdropped
      and exists (select 1 from pg_attribute w where w.attrelid = c.oid and w.attname = 'workspace_id')`);
  const listed = (lists: Readonly<Record<string, readonly string[]>>, t: string, c: string) => lists[t]?.includes(c) ?? false;
  const secretLike = /cipher|nonce|wrapped|sealed|token_hash|state_hash|hash_key|secret|password|private|public_key|email_hash/;
  const unclaimed = rows
    .filter((r) => r.type === "bytea" || secretLike.test(r.col))
    .filter((r) => !listed(OMITTED, r.tbl, r.col) && !listed(KEPT, r.tbl, r.col))
    .map((r) => `${r.tbl}.${r.col}`);
  expect(unclaimed).toEqual([]);
  const have = new Set(rows.map((r) => `${r.tbl}.${r.col}`));
  for (const lists of [OMITTED, KEPT]) for (const [t, cols] of Object.entries(lists)) for (const c of cols) expect(have.has(`${t}.${c}`), `${t}.${c}`).toBe(true);
});

test("a deleted Workspace's Owner can still export it, though its other routes are gone", async () => {
  expect((await call(`/api/w/${W2}`, otherOwner, { method: "DELETE" })).status).toBe(200);
  expect((await call(`/api/w/${W2}/media/${mediaId}`, otherOwner)).status).toBe(404);
  expect((await start(W2, otherOwner)).status).toBe(202);
  await runBuilds();
  expect((await list(W2, otherOwner))[0]).toMatchObject({ state: "ready" });
});

test("after 24 hours the link stops working and the sweep removes the ZIP", async () => {
  now = new Date(now.getTime() + 24 * 60 * 60_000 + 60_000);
  expect((await list(W))[0]).toMatchObject({ id: exportId, state: "expired" });
  expect((await call(`/api/exports/${W}/${exportId}`, owner)).status).toBe(404);
  // The sweep reads the database's clock, so move the export back a day instead.
  await db.query(`update workspace_exports set ready_at = ready_at - interval '25 hours', expires_at = expires_at - interval '25 hours' where workspace_id in ($1, $2)`, [W, W2]);
  const swept = (await handlers.get(EXPORT_SWEEP)!([])) as { removed: number; failed: number };
  expect(swept).toEqual({ removed: 2, failed: 0 });
  expect(await readdir(join(dir, W))).toEqual([mediaId]);
  const { rows } = await db.query(`select removed_at from workspace_exports where id = $1`, [exportId]);
  expect(rows[0].removed_at).not.toBeNull();
  expect((await handlers.get(EXPORT_SWEEP)!([])) as object).toEqual({ removed: 0, failed: 0 });
});

test("a build the store refuses is marked failed, leaves nothing behind, and can be started again", async () => {
  const refusing = { ...store(), put: async () => Promise.reject(new Error("disk full")) };
  const failing = createExports({ store: () => refusing, now: () => now, scratch: () => dir });
  const queued: { exportOf: string; exportId: string }[] = [];
  await failing.work({ createQueue: async () => {}, schedule: async () => {}, work: (async () => {}) as never, send: (async (_q: string, d: (typeof queued)[number]) => void queued.push(d)) as never });
  const r = await failing.start(W, user);
  expect(r.ok).toBe(true);
  await failing.build(queued[0]!.exportOf, queued[0]!.exportId);
  expect((await failing.list(W))[0]).toMatchObject({ id: queued[0]!.exportId, state: "failed" });
  expect((await readdir(dir)).filter((f) => f.endsWith(".zip"))).toEqual([]);
  // Building it again does nothing; a new request may start at once.
  await failing.build(queued[0]!.exportOf, queued[0]!.exportId);
  expect((await failing.start(W, user)).ok).toBe(true);
  expect(await failing.sweep()).toEqual({ removed: 1, failed: 0 });
});
