// SPDX-License-Identifier: AGPL-3.0-only
// Approved briefs: kept per Workspace, one per Item, and only the three selectors.
import { afterAll, expect, test } from "vitest";
import { appClient, insertAuthUser } from "../../../../../test/db";
import { inWorkspace, insertBrief, pagesDecidedSince, type NewBrief } from "./adapters/briefs-repo";

const c = await appClient();
afterAll(() => c.end());
const USER = crypto.randomUUID();
await insertAuthUser(USER);

const newWorkspace = async () => {
  const id = crypto.randomUUID();
  const orgId = crypto.randomUUID();
  await c.query("select set_config('app.workspace_id', $1, false)", [id]);
  await c.query("insert into organizations (id, name, created_at) values ($1, 'Org', now())", [orgId]);
  await c.query("insert into workspaces (id, org_id, name, created_at) values ($1, $2, 'W', now())", [id, orgId]);
  return id;
};
const newItem = async (w: string) => {
  await c.query("select set_config('app.workspace_id', $1, false)", [w]);
  const { rows } = await c.query(
    `insert into items (workspace_id, kind, state, title, warnings, created_at, updated_at)
     values ($1, 'seo_brief', 'needs_approval', 't', '[]', now(), now()) returning id`,
    [w],
  );
  return rows[0].id as string;
};
const brief = (workspaceId: string, itemId: string, over: Partial<NewBrief> = {}): NewBrief => ({
  workspaceId,
  itemId,
  pageUrl: "https://acme.example/pricing",
  query: "acme pricing",
  selector: "near_page_one",
  numbers: { impressions: 900, clicks: 12, position: 11.4, from: "2026-10-01", to: "2026-10-28" },
  brief: { gaps: ["no price table"] },
  pageText: "Pricing",
  pageReadAt: new Date("2026-11-01T09:00:00Z"),
  approvedBy: USER,
  approvedAt: new Date("2026-11-02T09:00:00Z"),
  ...over,
});

const A = await newWorkspace();
const B = await newWorkspace();

test("a brief is read back under its Workspace and is invisible to another", async () => {
  const item = await newItem(A);
  await inWorkspace(A, (tx) => insertBrief(tx, brief(A, item)));
  expect(await pagesDecidedSince(A, new Date("2026-11-01T00:00:00Z"))).toEqual(["https://acme.example/pricing"]);
  expect(await pagesDecidedSince(A, new Date("2026-11-03T00:00:00Z"))).toEqual([]);
  expect(await pagesDecidedSince(B, new Date("2026-11-01T00:00:00Z"))).toEqual([]);
});

test("a second brief for the same Item is refused", async () => {
  const item = await newItem(A);
  await inWorkspace(A, (tx) => insertBrief(tx, brief(A, item)));
  await expect(inWorkspace(A, (tx) => insertBrief(tx, brief(A, item)))).rejects.toMatchObject({ cause: { constraint: "seo_briefs_item_key" } });
});

test("a selector outside the three is refused", async () => {
  const item = await newItem(A);
  await expect(inWorkspace(A, (tx) => insertBrief(tx, brief(A, item, { selector: "trending" })))).rejects.toMatchObject({ cause: { constraint: "seo_briefs_selector_check" } });
});

test("a brief can't be written into another Workspace or edited afterwards", async () => {
  const item = await newItem(B);
  await expect(inWorkspace(A, (tx) => insertBrief(tx, brief(B, item)))).rejects.toMatchObject({ cause: { message: expect.stringMatching(/row-level security/) } });
  await c.query("select set_config('app.workspace_id', $1, false)", [A]);
  await expect(c.query("update seo_briefs set query = 'x'")).rejects.toThrow(/permission denied/);
});
