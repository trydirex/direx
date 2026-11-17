// SPDX-License-Identifier: AGPL-3.0-only
// Database-level guarantees of prospecting, as direx_app inside one Workspace.
import { afterAll, beforeAll, expect, test } from "vitest";
import type pg from "pg";
import { withWorkspace } from "../src/index";
import { organizations, workspaces } from "../src/schema";
import { appClient, insertAuthUser } from "../../../test/db";

let c: pg.Client;
const W = crypto.randomUUID();
const OTHER = crypto.randomUUID();
const U = crypto.randomUUID();
let runId: string;
let otherRunId: string;

const as = (workspace: string) => c.query("select set_config('app.workspace_id', $1, false)", [workspace]);
const newRun = async (workspace: string) => {
  await as(workspace);
  const { rows } = await c.query(
    `insert into prospect_runs (workspace_id, source, company_limit, confirmed_micros, confirmed_by, created_at, updated_at)
     values ($1, 'pasted', 1, 0, $2, now(), now()) returning id`,
    [workspace, U],
  );
  await as(W);
  return rows[0].id as string;
};
const newCompany = async (domain: string, run = runId) =>
  (
    await c.query(
      `insert into prospect_companies (workspace_id, domain, website, first_run_id, created_at, updated_at)
       values ($1, $2, $3, $4, now(), now()) returning id`,
      [W, domain, `https://${domain}`, run],
    )
  ).rows[0].id as string;
const newSnapshot = async (company: string) =>
  (
    await c.query(
      `insert into prospect_snapshots (workspace_id, company_id, page_url, digest, text, read_at, expires_at)
       values ($1, $2, 'https://a.test/team', 'd', 'Jane Doe, partner', now(), now()) returning id`,
      [W, company],
    )
  ).rows[0].id as string;
const newAddress = (company: string, snapshot: string, source = "published", pattern: string | null = null) =>
  c.query(
    `insert into prospect_addresses (workspace_id, company_id, email, kind, source, pattern, name, snapshot_id, read_at, notice_found, created_at)
     values ($1, $2, 'jane@a.test', 'named', $3, $4, 'Jane Doe', $5, now(), false, now())`,
    [W, company, source, pattern, snapshot],
  );

beforeAll(async () => {
  c = await appClient();
  const at = new Date();
  for (const id of [W, OTHER]) {
    const orgId = crypto.randomUUID();
    await withWorkspace(id, async (tx) => {
      await tx.insert(organizations).values({ id: orgId, name: "Org", createdAt: at });
      await tx.insert(workspaces).values({ id, orgId, name: "W", createdAt: at });
    });
  }
  await insertAuthUser(U);
  runId = await newRun(W);
  otherRunId = await newRun(OTHER);
});
afterAll(() => c.end());

test("a company's domain is known once per Workspace, lowercased", async () => {
  await newCompany("once.test");
  await expect(newCompany("once.test")).rejects.toThrow(/prospect_companies_domain_key/);
  await expect(newCompany("Upper.test")).rejects.toThrow(/prospect_companies_domain_check/);
  await expect(newCompany("www.site.test")).rejects.toThrow(/prospect_companies_domain_check/);
});

test("a company can't point at another Workspace's run", async () => {
  await expect(newCompany("cross.test", otherRunId)).rejects.toThrow(/prospect_companies_run_fk/);
});

test("a guessed address names its pattern, and a published one has none", async () => {
  const company = await newCompany("guess.test");
  const snapshot = await newSnapshot(company);
  await expect(newAddress(company, snapshot, "guessed")).rejects.toThrow(/prospect_addresses_guess_check/);
  await expect(newAddress(company, snapshot, "published", "first")).rejects.toThrow(/prospect_addresses_guess_check/);
  await newAddress(company, snapshot, "guessed", "first");
});

test("only a snapshot can be deleted, and its signals and addresses go with it", async () => {
  const company = await newCompany("expired.test");
  const snapshot = await newSnapshot(company);
  await newAddress(company, snapshot);
  await c.query(
    `insert into prospect_signals (workspace_id, company_id, type, quote, page_url, snapshot_id, observed_on, created_at)
     values ($1, $2, 'hiring', 'We are hiring', 'https://a.test/careers', $3, current_date, now())`,
    [W, company, snapshot],
  );
  await c.query("delete from prospect_snapshots where id = $1", [snapshot]);
  expect((await c.query("select count(*)::int as n from prospect_addresses where company_id = $1", [company])).rows[0].n).toBe(0);
  expect((await c.query("select count(*)::int as n from prospect_signals where company_id = $1", [company])).rows[0].n).toBe(0);
  for (const table of ["prospect_runs", "prospect_companies", "prospect_signals", "prospect_addresses", "prospect_cohorts", "prospect_people", "prospect_handovers", "prospect_handover_results"])
    await expect(c.query(`delete from ${table}`)).rejects.toThrow(/permission denied/);
});

test("names that were skipped say why, and only names in progress, done or skipped exist", async () => {
  const company = await newCompany("names.test");
  const set = (status: string | null, reason: string | null) => c.query("update prospect_companies set names_status = $1, names_reason = $2 where id = $3", [status, reason, company]);
  await expect(set("skipped", null)).rejects.toThrow(/prospect_companies_names_reason_check/);
  await expect(set("done", "disabled")).rejects.toThrow(/prospect_companies_names_reason_check/);
  await expect(set(null, "disabled")).rejects.toThrow(/prospect_companies_names_reason_check/);
  await expect(set("guessed", null)).rejects.toThrow(/prospect_companies_names_status_check/);
  await set("skipped", "disabled");
  await set("pending", null);
});

test("an address no one is known by is kept as unknown, and anything else isn't a kind", async () => {
  const company = await newCompany("unknown.test");
  const snapshot = await newSnapshot(company);
  const add = (kind: string) =>
    c.query(
      `insert into prospect_addresses (workspace_id, company_id, email, kind, source, snapshot_id, read_at, notice_found, created_at)
       values ($1, $2, $3, $4, 'published', $5, now(), false, now())`,
      [W, company, `${kind}@unknown.test`, kind, snapshot],
    );
  await add("unknown");
  await expect(add("person")).rejects.toThrow(/prospect_addresses_kind_check/);
});

test("a company's person is stored once by name, and only in its own Workspace", async () => {
  const company = await newCompany("people.test");
  const add = (first: string, last: string) =>
    c.query(`insert into prospect_people (workspace_id, company_id, first, last, role, created_at) values ($1, $2, $3, $4, 'Partner', now())`, [W, company, first, last]);
  await add("Jane", "Doe");
  await add("Jane", "");
  await expect(add("Jane", "Doe")).rejects.toThrow(/prospect_people_company_name_key/);
  await expect(
    c.query(`insert into prospect_people (workspace_id, company_id, first, last, names_run_id, created_at) values ($1, $2, 'Raj', 'Patel', $3, now())`, [W, company, crypto.randomUUID()]),
  ).rejects.toThrow(/prospect_people_run_fk/);
  await as(OTHER);
  expect((await c.query("select count(*)::int as n from prospect_people where company_id = $1", [company])).rows[0].n).toBe(0);
  await expect(c.query(`insert into prospect_people (workspace_id, company_id, first, last, created_at) values ($1, $2, 'Lee', 'Wong', now())`, [OTHER, company])).rejects.toThrow(/prospect_people_company_fk/);
  await as(W);
});
