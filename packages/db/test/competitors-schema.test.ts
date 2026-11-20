// SPDX-License-Identifier: AGPL-3.0-only
// Database-level guarantees of the competitor list, as direx_app inside one Workspace.
import { afterAll, beforeAll, expect, test } from "vitest";
import type pg from "pg";
import { withWorkspace } from "../src/index";
import { organizations, workspaces } from "../src/schema";
import { appClient, insertAuthUser, ownerClient } from "../../../test/db";

let c: pg.Client;
const W = crypto.randomUUID();
const U = crypto.randomUUID();
const add = (name: string, urls: [string | null, string | null, string | null] = ["https://a.example/pricing", null, null]) =>
  c.query(
    `insert into competitors (workspace_id, name, pricing_url, changelog_url, landing_url, created_by, created_at, updated_at)
     values ($1, $2, $3, $4, $5, $6, now(), now()) returning id`,
    [W, name, ...urls, U],
  );

beforeAll(async () => {
  await insertAuthUser(U);
  c = await appClient();
  const orgId = crypto.randomUUID();
  const at = new Date();
  await withWorkspace(W, async (tx) => {
    await tx.insert(organizations).values({ id: orgId, name: "Org", createdAt: at });
    await tx.insert(workspaces).values({ id: W, orgId, name: "W", createdAt: at });
  });
  await c.query("select set_config('app.workspace_id', $1, false)", [W]);
});
afterAll(() => c.end());

test("a name is unique in a Workspace regardless of case", async () => {
  await add("Double");
  await expect(add("DOUBLE")).rejects.toThrow(/competitors_name_key/);
});

test("at least one URL", async () => {
  await expect(add("Finlens", [null, null, null])).rejects.toThrow(/competitors_one_url_check/);
  await expect(add("Finlens", [null, null, "https://www.finlens.app/"])).resolves.toBeDefined();
});

test("a name of 1 to 100 characters", async () => {
  await expect(add("")).rejects.toThrow(/competitors_name_check/);
  await expect(add("x".repeat(101))).rejects.toThrow(/competitors_name_check/);
});

test("a removed competitor's row is gone", async () => {
  const { rows } = await add("Booke AI");
  await c.query("delete from competitors where id = $1", [rows[0].id]);
  expect((await c.query("select id from competitors where id = $1", [rows[0].id])).rows).toEqual([]);
});

const snapshot = (competitorId: string, week: string, failure: string | null = null) =>
  c.query(
    `insert into competitor_snapshots (workspace_id, competitor_id, source, url, week, read_at, failure, parts)
     values ($1, $2, 'changelog', 'https://a.example/changelog', $3, now(), $4, $5) returning id`,
    [W, competitorId, week, failure, failure ? null : JSON.stringify({ lines: ["x"] })],
  );

test("one snapshot per page a week; a read has parts or a failure, never both or neither", async () => {
  const { rows } = await add("Snap");
  const id = rows[0].id;
  await snapshot(id, "2026-11-09");
  await expect(snapshot(id, "2026-11-09")).rejects.toThrow(/competitor_snapshots_week_key/);
  await expect(snapshot(id, "2026-11-16", "robots_disallowed")).resolves.toBeDefined();
  await expect(
    c.query(`insert into competitor_snapshots (workspace_id, competitor_id, source, url, week, read_at) values ($1, $2, 'changelog', 'u', '2026-11-23', now())`, [W, id]),
  ).rejects.toThrow(/competitor_snapshots_outcome_check/);
  await expect(
    c.query(`insert into competitor_snapshots (workspace_id, competitor_id, source, url, week, read_at, parts) values ($1, $2, 'blog', 'u', '2026-11-23', now(), '{}')`, [W, id]),
  ).rejects.toThrow(/competitor_snapshots_source_check/);
});

test("removing a competitor removes its snapshots and Changes", async () => {
  const { rows } = await add("Gone");
  const id = rows[0].id;
  const a = (await snapshot(id, "2026-11-02")).rows[0].id;
  const b = (await snapshot(id, "2026-11-09")).rows[0].id;
  await c.query(
    `insert into competitor_changes (workspace_id, competitor_id, source, before_snapshot_id, after_snapshot_id, detail, created_at) values ($1, $2, 'changelog', $3, $4, '{"added":["y"]}', now())`,
    [W, id, a, b],
  );
  await c.query("delete from competitors where id = $1", [id]);
  expect((await c.query("select id from competitor_snapshots where competitor_id = $1", [id])).rows).toEqual([]);
  expect((await c.query("select id from competitor_changes where competitor_id = $1", [id])).rows).toEqual([]);
});

test("a label is whole or absent: noise has no kind, an answer has one, sameAs only on an answer to the same competitor", async () => {
  let week = 0;
  const change = async (competitorId: string) => {
    const a = (await snapshot(competitorId, `2026-10-0${++week}`)).rows[0].id;
    const b = (await snapshot(competitorId, `2026-10-0${++week}`)).rows[0].id;
    const { rows } = await c.query(
      `insert into competitor_changes (workspace_id, competitor_id, source, before_snapshot_id, after_snapshot_id, detail, created_at) values ($1, $2, 'changelog', $3, $4, '{"added":["y"]}', now()) returning id`,
      [W, competitorId, a, b],
    );
    return rows[0].id as string;
  };
  const label = (id: string, l: string | null, kind: string | null, reason: string | null = "why", sameAs: string | null = null) =>
    c.query(`update competitor_changes set label = $2, kind = $3, reason = $4, same_as_change_id = $5, labelled_at = case when $2::text is null then null else now() end where id = $1`, [
      id,
      l,
      kind,
      reason,
      sameAs,
    ]);
  const double = (await add("Labelled")).rows[0].id;
  const other = (await add("Elsewhere")).rows[0].id;
  const [first, second, third] = [await change(double), await change(other), await change(double)];

  await expect(label(first, "answer", "comparison_page")).resolves.toBeDefined();
  await expect(label(second, "noise", null)).resolves.toBeDefined();
  await expect(label(third, "noise", "post")).rejects.toThrow(/competitor_changes_kind_check/);
  await expect(label(third, "answer", null)).rejects.toThrow(/competitor_changes_kind_check/);
  await expect(label(third, "answer", "billboard")).rejects.toThrow(/competitor_changes_kind_check/);
  await expect(label(third, "maybe", null)).rejects.toThrow(/competitor_changes_label_check/);
  await expect(label(third, "noise", null, null)).rejects.toThrow(/competitor_changes_labelled_check/);
  await expect(label(third, "noise", null, "x".repeat(201))).rejects.toThrow(/competitor_changes_reason_check/);
  await expect(label(third, "noise", null, "why", first)).rejects.toThrow(/competitor_changes_same_as_check/);
  await expect(label(third, "answer", "post", "why", second)).rejects.toThrow(/competitor_changes_same_as_fk/);
  await expect(label(third, "answer", "comparison_page", "why", first)).resolves.toBeDefined();

  // Removing the competitor takes the sighting that points at it too.
  await c.query("delete from competitors where id = $1", [double]);
  expect((await c.query("select id from competitor_changes where competitor_id = $1", [double])).rows).toEqual([]);
});

test("a counter-move Item goes only on an answer; deleting it nulls item_id and keeps the Change", async () => {
  const id = (await add("Moved")).rows[0].id;
  const a = (await snapshot(id, "2026-09-07")).rows[0].id;
  const b = (await snapshot(id, "2026-09-14")).rows[0].id;
  const change = (
    await c.query(
      `insert into competitor_changes (workspace_id, competitor_id, source, before_snapshot_id, after_snapshot_id, detail, created_at) values ($1, $2, 'changelog', $3, $4, '{"added":["y"]}', now()) returning id`,
      [W, id, a, b],
    )
  ).rows[0].id;
  const item = (await c.query(`insert into items (workspace_id, kind, state, title, warnings, created_at, updated_at) values ($1, 'competitor_move', 'needs_approval', 't', '[]', now(), now()) returning id`, [W])).rows[0].id;
  const setItem = () => c.query("update competitor_changes set item_id = $2 where id = $1", [change, item]);

  await expect(setItem()).rejects.toThrow(/competitor_changes_item_check/);
  await c.query("update competitor_changes set label = 'noise', reason = 'why', labelled_at = now() where id = $1", [change]);
  await expect(setItem()).rejects.toThrow(/competitor_changes_item_check/);
  await c.query("update competitor_changes set label = 'answer', kind = 'post' where id = $1", [change]);
  await expect(setItem()).resolves.toBeDefined();

  // The app can't delete Items; the owner can, and the Change keeps its Workspace.
  const owner = await ownerClient();
  await owner.query("delete from items where id = $1", [item]).finally(() => owner.end());
  const { rows } = await c.query("select item_id, workspace_id from competitor_changes where id = $1", [change]);
  expect(rows).toEqual([{ item_id: null, workspace_id: W }]);
});

test("a comparison page URL is optional", async () => {
  const id = (await add("Compared")).rows[0].id;
  await c.query("update competitors set comparison_url = 'https://us.example/vs-compared' where id = $1", [id]);
  expect((await c.query("select comparison_url from competitors where id = $1", [id])).rows[0].comparison_url).toBe("https://us.example/vs-compared");
});

test("another Workspace sees none of it, and can't write into this one", async () => {
  const { rows } = await add("Hidden");
  await snapshot(rows[0].id, "2026-11-09");
  await c.query("select set_config('app.workspace_id', $1, false)", [crypto.randomUUID()]);
  expect((await c.query("select id from competitors")).rows).toEqual([]);
  expect((await c.query("select id from competitor_snapshots")).rows).toEqual([]);
  expect((await c.query("select id from competitor_changes")).rows).toEqual([]);
  await expect(add("Xenett")).rejects.toThrow(/row-level security/);
  await c.query("select set_config('app.workspace_id', $1, false)", [W]);
});

const find = (kind: string, site: string | null, terms: string[] | null, micros: number | null, by: string | null) =>
  c.query(`insert into competitor_finds (workspace_id, kind, site, terms, confirmed_micros, confirmed_by, at) values ($1, $2, $3, $4, $5, $6, now()) returning id`, [W, kind, site, terms, micros, by]);
const propose = (findId: string, name: string, key: string) =>
  c.query(`insert into competitor_proposals (workspace_id, find_id, name, name_key, found_at) values ($1, $2, $3, $4, now()) returning id`, [W, findId, name, key]);

test("a find is a site scan or a confirmed search, never a mix, and is never changed or deleted", async () => {
  const scan = (await find("own_site", "https://contoso.example/", null, null, null)).rows[0].id;
  await expect(find("search", null, ["bank rec software"], 120000, U)).resolves.toBeDefined();
  await expect(find("search", null, ["bank rec software"], 120000, null)).rejects.toThrow(/competitor_finds_kind_check/);
  await expect(find("own_site", "https://contoso.example/", ["x"], null, null)).rejects.toThrow(/competitor_finds_kind_check/);
  await expect(find("blog", "https://contoso.example/", null, null, null)).rejects.toThrow(/competitor_finds_kind_check/);
  await expect(c.query("update competitor_finds set site = 'https://other.example/' where id = $1", [scan])).rejects.toThrow(/permission denied/);
  await expect(c.query("delete from competitor_finds where id = $1", [scan])).rejects.toThrow(/permission denied/);
});

test("one proposal per name in a Workspace, only ever closed, and closed whole", async () => {
  const scan = (await find("own_site", "https://contoso.example/", null, null, null)).rows[0].id;
  const { rows } = await propose(scan, "Booke AI", "bookeai");
  await expect(propose(scan, "booke-ai", "bookeai")).rejects.toThrow(/competitor_proposals_name_key/);
  await expect(propose(scan, "Bad", "Bad Key")).rejects.toThrow(/competitor_proposals_name_check/);
  await expect(c.query("update competitor_proposals set closed_at = now(), closed_as = 'dismissed' where id = $1", [rows[0].id])).rejects.toThrow(/competitor_proposals_closed_check/);
  await c.query("update competitor_proposals set closed_at = now(), closed_by = $2, closed_as = 'dismissed' where id = $1", [rows[0].id, U]);
  await expect(c.query("update competitor_proposals set name = 'Other' where id = $1", [rows[0].id])).rejects.toThrow(/permission denied/);
  await expect(c.query("delete from competitor_proposals where id = $1", [rows[0].id])).rejects.toThrow(/permission denied/);
});

test("proposals and finds are invisible from another Workspace", async () => {
  const scan = (await find("own_site", "https://contoso.example/", null, null, null)).rows[0].id;
  await propose(scan, "Karbon", "karbon");
  await c.query("select set_config('app.workspace_id', $1, false)", [crypto.randomUUID()]);
  expect((await c.query("select id from competitor_proposals")).rows).toEqual([]);
  expect((await c.query("select id from competitor_finds")).rows).toEqual([]);
  await c.query("select set_config('app.workspace_id', $1, false)", [W]);
});
