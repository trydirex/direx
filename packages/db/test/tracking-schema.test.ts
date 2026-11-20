// SPDX-License-Identifier: AGPL-3.0-only
// Database-level guarantees of tracked links (ADR 0035), as direx_app: hostnames unique across the
// deployment (rule 007), links that never change (rule 004), use and switch shapes (rules 012, 016),
// and the two system definers that answer with yes or no and ids only (rule 021).
import { afterAll, beforeAll, expect, test } from "vitest";
import { getTableConfig, type PgTable } from "drizzle-orm/pg-core";
import type pg from "pg";
import { withWorkspace } from "../src/index";
import { organizations, workspaces } from "../src/schema";
import { campaigns } from "../src/schema-campaigns";
import { trackedLinks, trackedLinkUses, trackingDomains } from "../src/schema-tracking";
import { appClient, insertAuthUser } from "../../../test/db";

let c: pg.Client;
const W = crypto.randomUUID();
const OTHER = crypto.randomUUID();
const GONE = crypto.randomUUID();
const U = crypto.randomUUID();
const linkId = () => Buffer.from(crypto.getRandomValues(new Uint8Array(16))).toString("base64url");
const host = () => `t${crypto.randomUUID().slice(0, 8)}.example.com`;

async function workspace(w: string) {
  const orgId = crypto.randomUUID();
  await withWorkspace(w, async (tx) => {
    await tx.insert(organizations).values({ id: orgId, name: "Org", createdAt: new Date() });
    await tx.insert(workspaces).values({ id: w, orgId, name: "W", createdAt: new Date() });
  });
}

const as = (w: string) => c.query("select set_config('app.workspace_id', $1, false)", [w]);

async function domain(w: string, hostname: string, state = "pending"): Promise<string> {
  await as(w);
  const { rows } = await c.query(
    "insert into tracking_domains (workspace_id, hostname, txt_value, state, created_by, created_at) values ($1, $2, 'v', $3, $4, now()) returning id",
    [w, hostname, state, U],
  );
  return rows[0].id as string;
}

async function campaign(w: string): Promise<string> {
  await as(w);
  const plan = (await c.query("insert into marketing_plans (workspace_id, title, created_at, updated_at) values ($1, 't', now(), now()) returning id", [w])).rows[0].id;
  return (await c.query("insert into campaigns (workspace_id, plan_id, owner_user_id, created_at, updated_at) values ($1, $2, $3, now(), now()) returning id", [w, plan, U])).rows[0].id as string;
}

const link = (w: string, campaignId: string, domainId: string, o: { id?: string; destination?: string } = {}) =>
  c.query("insert into tracked_links (id, workspace_id, campaign_id, step_key, domain_id, destination, created_at) values ($1, $2, $3, 's1', $4, $5, now())", [
    o.id ?? linkId(),
    w,
    campaignId,
    domainId,
    o.destination ?? "https://example.com/page",
  ]);

beforeAll(async () => {
  await insertAuthUser(U);
  await workspace(W);
  await workspace(OTHER);
  await workspace(GONE);
  c = await appClient();
});
afterAll(() => c.end());

test("a hostname is lowercase, well formed, and belongs to one Workspace on the deployment", async () => {
  await expect(domain(W, "Links.Example.com")).rejects.toThrow(/tracking_domains_hostname_check/);
  await expect(domain(W, "localhost")).rejects.toThrow(/tracking_domains_hostname_check/);
  await expect(domain(W, "links..example.com")).rejects.toThrow(/tracking_domains_hostname_check/);
  await expect(domain(W, host(), "live")).rejects.toThrow(/tracking_domains_state_check/);
  const taken = host();
  await domain(W, taken);
  await expect(domain(OTHER, taken)).rejects.toThrow(/tracking_domains_hostname_key/);
});

test("a link's id is 128 random bits, its destination is https and at most 2,048 characters, and it never changes", async () => {
  const d = await domain(W, host());
  const camp = await campaign(W);
  await expect(link(W, camp, d, { id: "short" })).rejects.toThrow(/tracked_links_id_check/);
  await expect(link(W, camp, d, { destination: "http://example.com" })).rejects.toThrow(/tracked_links_destination_check/);
  await expect(link(W, camp, d, { destination: `https://example.com/${"a".repeat(2048)}` })).rejects.toThrow(/tracked_links_destination_check/);
  const id = linkId();
  await link(W, camp, d, { id });
  await expect(c.query("update tracked_links set destination = 'https://evil.example' where id = $1", [id])).rejects.toThrow(/permission denied/);
  await expect(c.query("delete from tracked_links where id = $1", [id])).rejects.toThrow(/permission denied/);
});

test("a link can't use another Workspace's domain", async () => {
  const theirs = await domain(OTHER, host());
  const camp = await campaign(W);
  await expect(link(W, camp, theirs)).rejects.toThrow(/tracked_links_domain_fk/);
});

test("a long non-ASCII destination fits and still deduplicates within a step", async () => {
  const d = await domain(W, host());
  const camp = await campaign(W);
  // Distinct characters keep this URL from compressing below PostgreSQL's B-tree key limit.
  const path = Array.from({ length: 2_000 }, (_, i) => String.fromCodePoint(0x4e00 + i)).join("");
  const destination = `https://example.com/${path}`;
  const id = linkId();
  await link(W, camp, d, { id, destination });
  const stored = await c.query("select destination from tracked_links where id = $1", [id]);
  expect(stored.rows).toEqual([{ destination }]);
  await expect(link(W, camp, d, { destination })).rejects.toThrow(/tracked_links_destination_key/);
  expect((await link(W, camp, d, { destination: `${destination}a` })).rowCount).toBe(1);
});

test("a use names one message, a token comes with a Person and is a SHA-256, and a DM never carries one", async () => {
  await as(W);
  const use = (actionId: string | null, dmId: string | null, tokenHash: string | null, personId: string | null) =>
    c.query("insert into tracked_link_uses (workspace_id, link_id, action_id, dm_id, token_hash, person_id, inputs_hash, created_at) values ($1, $2, $3, $4, $5, $6, 'h', now())", [
      W,
      linkId(),
      actionId,
      dmId,
      tokenHash,
      personId,
    ]);
  const id = crypto.randomUUID();
  const sha = "a".repeat(64);
  await expect(use(null, null, null, null)).rejects.toThrow(/tracked_link_uses_one_message_check/);
  await expect(use(id, id, null, null)).rejects.toThrow(/tracked_link_uses_one_message_check/);
  await expect(use(id, null, sha, null)).rejects.toThrow(/tracked_link_uses_token_check/);
  await expect(use(id, null, "not-a-hash", id)).rejects.toThrow(/tracked_link_uses_token_hash_check/);
  await expect(use(null, id, sha, id)).rejects.toThrow(/tracked_link_uses_dm_token_check/);
});

test("tracking needs a domain, a setter and a wording version, and per-Person needs tracking", async () => {
  const camp = await campaign(W);
  const d = await domain(W, host());
  await expect(c.query("update campaigns set tracking_on = true where id = $1", [camp])).rejects.toThrow(/campaigns_tracking_check/);
  await expect(c.query("update campaigns set per_person_on = true, per_person_set_by = $2, per_person_wording_version = 1 where id = $1", [camp, U])).rejects.toThrow(
    /campaigns_per_person_check/,
  );
  await c.query("update campaigns set tracking_domain_id = $2, tracking_on = true, tracking_set_by = $3, tracking_set_at = now(), tracking_wording_version = 1 where id = $1", [camp, d, U]);
  await c.query("update campaigns set per_person_on = true, per_person_set_by = $2, per_person_set_at = now(), per_person_wording_version = 1 where id = $1", [camp, U]);
  const { rows } = await c.query("select tracking_on, per_person_on from campaigns where id = $1", [camp]);
  expect(rows[0]).toEqual({ tracking_on: true, per_person_on: true });
});

test("the edge may get a certificate only for a host whose DNS matched, in a live Workspace", async () => {
  const pending = host();
  const ok = host();
  const verified = host();
  const stopped = host();
  const gone = host();
  await domain(W, pending);
  await domain(W, ok, "dns_ok");
  await domain(W, verified, "verified");
  await domain(W, stopped, "stopped");
  await domain(GONE, gone, "verified");
  await as(GONE);
  await c.query("select system.soft_delete_workspace($1, $2)", [GONE, U]);
  await as("");
  const allowed = async (h: string) => (await c.query("select system.tracking_host_allowed($1) as ok", [h])).rows[0].ok as boolean;
  expect(await allowed(pending)).toBe(false);
  expect(await allowed(ok)).toBe(true);
  expect(await allowed(ok.toUpperCase())).toBe(true);
  expect(await allowed(verified)).toBe(true);
  expect(await allowed(stopped)).toBe(false);
  expect(await allowed(gone)).toBe(false);
  expect(await allowed("unknown.example.com")).toBe(false);
});

test("the lookup returns ids only, for the link's own host, and a stopped domain still resolves", async () => {
  const mine = host();
  const theirs = host();
  const d = await domain(W, mine, "stopped");
  await domain(OTHER, theirs, "verified");
  const camp = await campaign(W);
  const id = linkId();
  await link(W, camp, d, { id });
  const otherId = linkId();
  await link(W, camp, d, { id: otherId, destination: "https://example.com/another" });
  const personId = crypto.randomUUID();
  await c.query("insert into people (id, workspace_id, coordination_id, created_at) values ($1, $2, $1, now())", [personId, W]);
  const action = await c.query<{ id: string }>(
    `insert into actions (workspace_id, idempotency_key, capability, dedupe_class, state, spec, spec_hash, created_at, updated_at)
     values ($1, gen_random_uuid(), 'test.send', 'blind', 'draft', '{}', 'h', now(), now()) returning id`,
    [W],
  );
  const useId = crypto.randomUUID();
  const token = "a".repeat(64);
  await c.query(
    `insert into tracked_link_uses (id, workspace_id, link_id, action_id, token_hash, person_id, inputs_hash, created_at)
     values ($1, $2, $3, $4, $5, $6, 'h', now())`,
    [useId, W, id, action.rows[0]!.id, token, personId],
  );
  await as("");
  const lookup = async (h: string, l: string, token: string | null = null) => (await c.query("select * from system.tracking_link_lookup($1, $2, $3)", [h, l, token])).rows;
  expect(await lookup(mine, id)).toEqual([{ workspace_id: W, link_id: id, use_id: null }]);
  expect(await lookup(theirs, id)).toEqual([]);
  expect(await lookup(mine, linkId())).toEqual([]);
  expect(await lookup(mine, id, token)).toEqual([{ workspace_id: W, link_id: id, use_id: useId }]);
  expect(await lookup(mine, otherId)).toEqual([{ workspace_id: W, link_id: otherId, use_id: null }]);
  expect(await lookup(mine, otherId, token)).toEqual([]);
  // A token that names no use of this link finds nothing.
  expect(await lookup(mine, id, "b".repeat(64))).toEqual([]);
  // RLS still hides the rows themselves from the app with no Workspace set.
  expect((await c.query("select count(*)::int as n from tracked_links")).rows[0].n).toBe(0);
});

test("the drizzle schema names the same checks, keys, foreign keys and indexes as migration 0158", async () => {
  const names = (t: PgTable) => {
    const cfg = getTableConfig(t);
    const fks = cfg.foreignKeys.map((f) => {
      f.reference();
      return f.getName();
    });
    return [...cfg.checks.map((x) => x.name), ...cfg.uniqueConstraints.map((u) => u.name), ...fks, ...cfg.indexes.map((i) => i.config.name)].sort();
  };
  const tables = { trackingDomains, trackedLinks, trackedLinkUses };
  await as("");
  const { rows } = await c.query(
    `select conrelid::regclass::text as tbl, conname from pg_constraint
     where conrelid::regclass::text in ('tracking_domains', 'tracked_links', 'tracked_link_uses')
       and contype in ('c', 'u', 'f')
     union all
     select i.indrelid::regclass::text, i.indexrelid::regclass::text
     from pg_index i
     where i.indrelid::regclass::text in ('tracking_domains', 'tracked_links', 'tracked_link_uses')
       and not exists (select 1 from pg_constraint c where c.conindid = i.indexrelid)`,
  );
  for (const [, table] of Object.entries(tables)) {
    const sqlName = getTableConfig(table).name;
    const inDb = rows.filter((r) => r.tbl === sqlName).map((r) => r.conname as string).sort();
    expect(names(table), sqlName).toEqual(inDb);
  }
  expect(getTableConfig(campaigns).checks.map((x) => x.name)).toEqual(expect.arrayContaining(["campaigns_tracking_check", "campaigns_per_person_check"]));
});
