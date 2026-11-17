// SPDX-License-Identifier: AGPL-3.0-only
// Database-level guarantees of setup samples and Voice (ADR 0022), as direx_app inside one Workspace.
import { afterAll, beforeAll, expect, test } from "vitest";
import type pg from "pg";
import { withWorkspace } from "../src/index";
import { organizations, workspaces } from "../src/schema";
import { appClient, insertAuthUser } from "../../../test/db";

let c: pg.Client;
const W = crypto.randomUUID();
const U = crypto.randomUUID();
let runId: string;

const sample = (kind: string) => c.query(`insert into brand_samples (workspace_id, kind, current_revision, created_at, updated_at) values ($1, $2, 1, now(), now()) returning id`, [W, kind]);
const revision = (sampleId: string, n: number, text = "Hello") =>
  c.query(`insert into brand_sample_revisions (workspace_id, sample_id, revision, text, digest, run_id, at) values ($1, $2, $3, $4, 'd', $5, now())`, [W, sampleId, n, text, runId]);
const entry = (kind: string) => c.query(`insert into voice_entries (workspace_id, kind, current_version, created_at, updated_at) values ($1, $2, 1, now(), now()) returning id`, [W, kind]);
const version = (entryId: string, o: { text?: string | null; prefer?: string | null; source?: string; sample?: [string, number, string] | null } = {}) =>
  c.query(
    `insert into voice_versions (workspace_id, entry_id, version, text, prefer, source, sample_id, sample_revision, sample_digest, digest, actor_user_id, at)
     values ($1, $2, 1, $3, $4, $5, $6, $7, $8, 'd', $9, now())`,
    [W, entryId, o.text === undefined ? "We write plainly." : o.text, o.prefer ?? null, o.source ?? "person", o.sample?.[0] ?? null, o.sample?.[1] ?? null, o.sample?.[2] ?? null, U],
  );

beforeAll(async () => {
  c = await appClient();
  const orgId = crypto.randomUUID();
  const at = new Date();
  await insertAuthUser(U);
  await withWorkspace(W, async (tx) => {
    await tx.insert(organizations).values({ id: orgId, name: "Org", createdAt: at });
    await tx.insert(workspaces).values({ id: W, orgId, name: "W", createdAt: at });
  });
  await c.query("select set_config('app.workspace_id', $1, false)", [W]);
  runId = (
    await c.query(
      `insert into agent_runs (workspace_id, idempotency_key, agent, definition_version, prompt_revision, prompt_digest, tool_set_digest, trigger, status, deadline_ms, step_cap, cost_cap_micros, input, created_at, updated_at)
       values ($1, 'samples', 'sample_writer', 1, 'r', 'd', 'd', 'user_request', 'queued', 600000, 30, 1000000, '{}', now(), now()) returning id`,
      [W],
    )
  ).rows[0].id;
});
afterAll(() => c.end());

test("one sample of each known kind per Workspace, kept with revisions that never change", async () => {
  const id = (await sample("linkedin_post")).rows[0].id;
  await expect(sample("linkedin_post")).rejects.toThrow(/brand_samples_one_per_kind/);
  await expect(sample("press_release")).rejects.toThrow(/brand_samples_kind_check/);
  await revision(id, 1);
  await expect(revision(id, 1)).rejects.toThrow(/brand_sample_revisions_pkey/);
  await expect(revision(id, 2, "")).rejects.toThrow(/brand_sample_revisions_text_check/);
  await expect(c.query("update brand_sample_revisions set text = 'x'")).rejects.toThrow(/permission denied/);
  await expect(c.query("delete from brand_sample_revisions")).rejects.toThrow(/permission denied/);
  await expect(c.query("delete from brand_samples")).rejects.toThrow(/permission denied/);
});

test("a Voice version names its sample exactly when it came from one, and keeps to its lengths", async () => {
  const id = (await entry("example")).rows[0].id;
  await expect(version(id, { source: "sample" })).rejects.toThrow(/voice_versions_sample_check/);
  await expect(version(id, { sample: [crypto.randomUUID(), 1, "d"] })).rejects.toThrow(/voice_versions_sample_check/);
  await expect(version(id, { text: "x".repeat(601) })).rejects.toThrow(/voice_versions_length_check/);
  await expect(version(id, { text: "users", prefer: "y".repeat(41) })).rejects.toThrow(/voice_versions_length_check/);
  await expect(entry("tagline")).rejects.toThrow(/voice_entries_kind_check/);
  await expect(version(id, { source: "sample", sample: [crypto.randomUUID(), 2, "d"] })).resolves.toBeDefined();
});

test("a Voice version changes only to be erased, once, keeping its digest", async () => {
  const id = (await entry("swap")).rows[0].id;
  await version(id, { text: "users", prefer: "customers" });
  await expect(c.query("update voice_versions set text = 'clients' where entry_id = $1", [id])).rejects.toThrow(/voice_versions_erase_only/);
  await expect(c.query("update voice_versions set digest = 'x' where entry_id = $1", [id])).rejects.toThrow(/permission denied/);
  await c.query("update voice_versions set text = null, prefer = null, erased_at = now() where entry_id = $1", [id]);
  const { rows } = await c.query("select text, prefer, digest from voice_versions where entry_id = $1", [id]);
  expect(rows[0]).toEqual({ text: null, prefer: null, digest: "d" });
  await expect(c.query("update voice_versions set text = null, prefer = null, erased_at = now() where entry_id = $1", [id])).rejects.toThrow(/voice_versions_erase_only/);
  await expect(c.query("delete from voice_versions")).rejects.toThrow(/permission denied/);
  await expect(c.query("delete from voice_entries")).rejects.toThrow(/permission denied/);
});

test("a row for another Workspace is refused by the policy", async () => {
  await expect(c.query(`insert into voice_entries (workspace_id, kind, current_version, created_at, updated_at) values ($1, 'example', 1, now(), now())`, [crypto.randomUUID()])).rejects.toThrow(/row-level security/);
  await expect(c.query(`insert into brand_samples (workspace_id, kind, current_revision, created_at, updated_at) values ($1, 'cold_email', 1, now(), now())`, [crypto.randomUUID()])).rejects.toThrow(/row-level security/);
});
