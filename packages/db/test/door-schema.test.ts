// SPDX-License-Identifier: AGPL-3.0-only
// Database-level guarantees of External tokens (ADR 0032 rule 005) and the door's proposal record
// (rule 004), as direx_app inside one Workspace.
import { afterAll, beforeAll, expect, test } from "vitest";
import { getTableConfig } from "drizzle-orm/pg-core";
import type pg from "pg";
import { withWorkspace } from "../src/index";
import { organizations, workspaces } from "../src/schema";
import { doorProposals } from "../src/schema-door";
import { appClient, insertAuthUser } from "../../../test/db";

let c: pg.Client;
const W = crypto.randomUUID();
const OTHER = crypto.randomUUID();
const U = crypto.randomUUID();
const hash = () => Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("hex");

async function workspace(w: string) {
  const orgId = crypto.randomUUID();
  await withWorkspace(w, async (tx) => {
    await tx.insert(organizations).values({ id: orgId, name: "Org", createdAt: new Date() });
    await tx.insert(workspaces).values({ id: w, orgId, name: "W", createdAt: new Date() });
  });
}

type Row = { name?: string; hash?: string; hint?: string; expires?: string; revokedBy?: string | null; revokedAt?: string | null };
const add = (o: Row = {}) =>
  c.query(
    `insert into external_tokens (workspace_id, name, token_hash, hint, readers, kinds, created_by, created_at, expires_at, revoked_by, revoked_at)
     values ($1, $2, $3, $4, '{read_changes}', '{}', $5, now(), now() + $6::interval, $7, $8) returning id`,
    [W, o.name ?? "Zapier", o.hash ?? hash(), o.hint ?? "abcd", U, o.expires ?? "30 days", o.revokedBy ?? null, o.revokedAt ?? null],
  );

beforeAll(async () => {
  await insertAuthUser(U);
  await workspace(W);
  await workspace(OTHER);
  c = await appClient();
  await c.query("select set_config('app.workspace_id', $1, false)", [W]);
});
afterAll(() => c.end());

test("name, hash, hint and revocation shape are checked", async () => {
  await expect(add({ name: "" })).rejects.toThrow(/external_tokens_name_check/);
  await expect(add({ name: "x".repeat(61) })).rejects.toThrow(/external_tokens_name_check/);
  await expect(add({ hash: "dxt_not-a-hash" })).rejects.toThrow(/external_tokens_token_hash_check/);
  await expect(add({ hint: "abc" })).rejects.toThrow(/external_tokens_hint_check/);
  await expect(add({ revokedBy: U })).rejects.toThrow(/external_tokens_revoked_check/);
  await expect(add({ revokedAt: new Date().toISOString() })).rejects.toThrow(/external_tokens_revoked_check/);
  await expect(add({ name: "x".repeat(60) })).resolves.toBeDefined();
});

test("a token always expires, and within a year", async () => {
  await expect(add({ expires: "0 days" })).rejects.toThrow(/external_tokens_expiry_check/);
  await expect(add({ expires: "366 days" })).rejects.toThrow(/external_tokens_expiry_check/);
  await expect(add({ expires: "365 days" })).resolves.toBeDefined();
});

test("a hash is never shared within a Workspace", async () => {
  const h = hash();
  await add({ hash: h });
  await expect(add({ hash: h })).rejects.toThrow(/external_tokens_workspace_id_token_hash_key/);
});

test("the app may record a revocation and a use, and nothing else; it never deletes", async () => {
  const id = (await add()).rows[0].id as string;
  await expect(c.query("update external_tokens set name = 'Other' where id = $1", [id])).rejects.toThrow(/permission denied/);
  await expect(c.query("update external_tokens set expires_at = now() + interval '300 days' where id = $1", [id])).rejects.toThrow(/permission denied/);
  await expect(c.query("update external_tokens set readers = '{read_needs_you}' where id = $1", [id])).rejects.toThrow(/permission denied/);
  await expect(c.query("delete from external_tokens where id = $1", [id])).rejects.toThrow(/permission denied/);
  expect((await c.query("update external_tokens set last_used_at = now() where id = $1", [id])).rowCount).toBe(1);
  expect((await c.query("update external_tokens set revoked_by = $2, revoked_at = now() where id = $1", [id, U])).rowCount).toBe(1);
});

test("another Workspace sees none of these tokens", async () => {
  await add();
  await c.query("select set_config('app.workspace_id', $1, false)", [OTHER]);
  try {
    expect((await c.query("select 1 from external_tokens")).rowCount).toBe(0);
    await expect(add()).rejects.toThrow(/row-level security/);
  } finally {
    await c.query("select set_config('app.workspace_id', $1, false)", [W]);
  }
});

const request = (tokenId: string, outcome = "ok") =>
  c.query("insert into door_requests (workspace_id, token_id, reader, outcome, at) values ($1, $2, 'read_changes', $3, now()) returning id", [W, tokenId, outcome]);

test("a door request is one of the known outcomes, for a token of this Workspace, and the app never changes it", async () => {
  const tokenId = (await add()).rows[0].id as string;
  await expect(request(tokenId, "maybe")).rejects.toThrow(/door_requests_outcome_check/);
  await expect(request(crypto.randomUUID())).rejects.toThrow(/door_requests_token_fk/);
  const id = (await request(tokenId)).rows[0].id as number;
  await expect(c.query("update door_requests set outcome = 'error' where id = $1", [id])).rejects.toThrow(/permission denied/);
  await expect(c.query("delete from door_requests where id = $1", [id])).rejects.toThrow(/permission denied/);
  await c.query("select set_config('app.workspace_id', $1, false)", [OTHER]);
  try {
    expect((await c.query("select 1 from door_requests")).rowCount).toBe(0);
  } finally {
    await c.query("select set_config('app.workspace_id', $1, false)", [W]);
  }
});

test("a counter counts up in one statement, stays positive, and belongs to its Workspace", async () => {
  const bump = () =>
    c.query(
      `insert into door_counters (workspace_id, scope, minute, count) values ($1, 'workspace', date_trunc('minute', now()), 1)
       on conflict (workspace_id, scope, minute) do update set count = door_counters.count + 1 returning count`,
      [W],
    );
  const first = (await bump()).rows[0].count as number;
  expect((await bump()).rows[0].count).toBe(first + 1);
  await expect(c.query("insert into door_counters (workspace_id, scope, minute, count) values ($1, 'x', now(), 0)", [W])).rejects.toThrow(/door_counters_count_check/);
  expect((await c.query("delete from door_counters where workspace_id = $1 and minute < now() - interval '10 minutes'", [W])).rowCount).toBe(0);
  await c.query("select set_config('app.workspace_id', $1, false)", [OTHER]);
  try {
    expect((await c.query("select 1 from door_counters")).rowCount).toBe(0);
  } finally {
    await c.query("select set_config('app.workspace_id', $1, false)", [W]);
  }
});

// Proposals (ADR 0032 rule 004, door-proposals P1): one row per token and idempotency key, written once.
const digest = () => hash();
async function proposal(key: string) {
  const token = (await add()).rows[0].id as string;
  const item = (await c.query(`insert into items (workspace_id, kind, state, title, warnings, created_at, updated_at) values ($1, 'plan_change', 'needs_approval', 't', '[]', now(), now()) returning id`, [W])).rows[0].id as string;
  const put = (k = key, d = digest()) =>
    c.query(`insert into door_proposals (workspace_id, token_id, idempotency_key, body_digest, kind, item_id, created_at) values ($1, $2, $3, $4, 'draft', $5, now())`, [W, token, k, d, item]);
  return { token, item, put };
}

test("a token's idempotency key is used once, and the app can't change or delete the record", async () => {
  const p = await proposal("retry-1");
  await p.put();
  await expect(p.put()).rejects.toThrow(/door_proposals_pkey/);
  await expect(p.put("", digest())).rejects.toThrow(/door_proposals_key_check/);
  await expect(p.put("other", "not-a-digest")).rejects.toThrow(/door_proposals_body_digest_check/);
  await expect(c.query("update door_proposals set item_id = item_id where token_id = $1", [p.token])).rejects.toThrow(/permission denied/);
  await expect(c.query("delete from door_proposals where token_id = $1", [p.token])).rejects.toThrow(/permission denied/);
});

test("another Workspace sees no proposal", async () => {
  const p = await proposal("seen-once");
  await p.put();
  await c.query("select set_config('app.workspace_id', $1, false)", [OTHER]);
  try {
    expect((await c.query("select count(*)::int as n from door_proposals where token_id = $1", [p.token])).rows[0].n).toBe(0);
  } finally {
    await c.query("select set_config('app.workspace_id', $1, false)", [W]);
  }
  expect((await c.query("select count(*)::int as n from door_proposals where token_id = $1", [p.token])).rows[0].n).toBe(1);
});

test("a request records its operation, and the proposal refusals are outcomes too", async () => {
  const token = (await add()).rows[0].id as string;
  const req = (outcome: string) => c.query(`insert into door_requests (workspace_id, token_id, reader, operation, outcome, at) values ($1, $2, 'fact_proposal', 'fact_proposal', $3, now())`, [W, token, outcome]);
  for (const outcome of ["kind_not_allowed", "already_waiting", "idempotency_conflict", "proposal_cap", "refused"]) await expect(req(outcome)).resolves.toBeDefined();
  await expect(req("maybe")).rejects.toThrow(/door_requests_outcome_check/);
});

test("the schema declares door_proposals' keys and checks as migration 0151 made them", async () => {
  const t = getTableConfig(doorProposals);
  const declared = [...t.primaryKeys.map((k) => k.getName()), ...t.foreignKeys.map((f) => f.getName()), ...t.checks.map((ch) => ch.name)].sort();
  const migrated = (await c.query("select conname from pg_constraint where conrelid = 'door_proposals'::regclass and contype <> 'n' order by conname")).rows.map((r) => r.conname as string);
  expect(declared).toEqual(migrated);
});
