// SPDX-License-Identifier: AGPL-3.0-only
import { expect, test } from "vitest";
import { createFakeNotion, type FakeNotionPage, type FakeNotionSource } from "./fake-notion";
import { createNotionPlugin, NOTION_VERSION, NotionError } from "./plugin";

const BRAND = "11111111-1111-4111-8111-111111111111";
const VOICE = "22222222-2222-4222-8222-222222222222";
const pages: FakeNotionPage[] = [
  {
    id: BRAND,
    title: "Brand guide",
    blocks: [
      { type: "heading_1", text: "Who we are" },
      { type: "paragraph", text: "We sell bookkeeping to clinics." },
      { type: "bulleted_list_item", text: "Plain words", children: [{ type: "paragraph", text: "No jargon, ever." }] },
      { type: "image" },
      { type: "child_page", text: "Old notes", children: [{ type: "paragraph", text: "never read" }] },
      { type: "paragraph", text: "" },
    ],
  },
  { id: VOICE, title: "", blocks: [] },
];
const CAL = "33333333-3333-4333-8333-333333333333";
const sources: FakeNotionSource[] = [
  {
    id: CAL,
    title: "Content calendar",
    columns: { Name: { type: "title" }, Date: { type: "date" }, Channel: { type: "select", options: ["LinkedIn", "X"] }, Tags: { type: "multi_select", options: ["Launch"] }, Caption: { type: "rich_text" }, Owner: { type: "people" } },
    rows: [
      { id: "44444444-4444-4444-8444-444444444441", editedAt: "2026-11-12T09:00:00.000Z", values: { Name: "Launch post", Date: "2026-12-01T09:00:00.000+00:00", Channel: "LinkedIn", Tags: ["Launch"], Caption: "We're live." } },
      { id: "44444444-4444-4444-8444-444444444442", editedAt: "2026-11-11T09:00:00.000Z", values: { Name: "Teaser", Date: null, Channel: null, Tags: [], Caption: null } },
      { id: "44444444-4444-4444-8444-444444444443", editedAt: "2026-11-13T09:00:00.000Z", values: { Name: "Recap", Date: "2026-12-05", Channel: "X", Tags: [], Caption: "" } },
    ],
  },
];
const setup = (o: Parameters<typeof createNotionPlugin>[0] = {}, pageSize?: number) => {
  const n = createFakeNotion({ pages, sources, ...(pageSize && { pageSize }) });
  const plugin = createNotionPlugin({ fetch: n.fetch, ...o });
  return { n, q: (name: string, input: unknown, key = n.token) => plugin.queries[name]!(input, { workspaceId: "w1", log: () => {}, credential: { key } }) };
};

test("lists the pages shared with the integration, newest edit first, with the version header", async () => {
  const { n, q } = setup();
  expect(await q("docs.sources", {})).toEqual({
    pages: [
      { id: BRAND, title: "Brand guide", url: `https://www.notion.so/${BRAND.replaceAll("-", "")}`, editedAt: "2026-11-10T10:00:00.000Z" },
      { id: VOICE, title: "Untitled", url: `https://www.notion.so/${VOICE.replaceAll("-", "")}`, editedAt: "2026-11-10T10:00:00.000Z" },
    ],
    more: false,
  });
  expect(n.calls[0]).toMatchObject({ method: "POST", path: "/search", version: NOTION_VERSION, body: { filter: { property: "object", value: "page" }, sort: { direction: "descending", timestamp: "last_edited_time" }, page_size: 100 } });
  await expect(q("docs.sources", { query: "x" })).rejects.toThrow("docs.sources takes { kind?: page | database }");
});

test("a page's text keeps its words and nested lines, and skips images, child pages and empty blocks", async () => {
  const { q } = setup({}, 2);
  expect(await q("docs.page_text", { pageId: BRAND })).toEqual({
    title: "Brand guide",
    text: "Who we are\nWe sell bookkeeping to clinics.\n- Plain words\nNo jargon, ever.",
    cut: false,
  });
  expect(await q("docs.page_text", { pageId: BRAND.replaceAll("-", "") })).toMatchObject({ title: "Brand guide" });
  await expect(q("docs.page_text", { pageId: "nope" })).rejects.toThrow("docs.page_text takes { pageId }");
});

test("a page past the limit, or nested deeper than read, is cut and says so", async () => {
  expect(await setup({ maxChars: 20 }).q("docs.page_text", { pageId: BRAND })).toEqual({ title: "Brand guide", text: "Who we are\nWe sell b", cut: true });
  expect(await setup({ maxDepth: 1 }).q("docs.page_text", { pageId: BRAND })).toEqual({ title: "Brand guide", text: "Who we are\nWe sell bookkeeping to clinics.\n- Plain words", cut: true });
  expect(await setup({ maxBlocks: 2 }).q("docs.page_text", { pageId: BRAND })).toMatchObject({ text: "Who we are\nWe sell bookkeeping to clinics.", cut: true });
});

test("a revoked token, a page not shared and a busy Notion each fail with a reason, and no token is no call", async () => {
  const { n, q } = setup({ now: () => 0 });
  n.failNext("revoked");
  await expect(q("docs.sources", {})).rejects.toThrow(new NotionError(401, "needs_reconnecting"));
  n.failNext("not_shared");
  await expect(q("docs.page_text", { pageId: BRAND })).rejects.toThrow("Notion answered 404: no_access");
  n.failNext("rate_limited");
  await expect(q("docs.sources", {})).rejects.toThrow("Notion answered 429; wait 3000 ms: busy");
  const before = n.calls.length;
  await expect(createNotionPlugin({ fetch: n.fetch }).queries["docs.sources"]!({}, { workspaceId: "w1", log: () => {}, credential: null })).rejects.toThrow("Notion is not connected");
  expect(n.calls.length).toBe(before);
});

test("the OAuth connection's access token is sent as the typed key is", async () => {
  const n = createFakeNotion({ pages, sources });
  const plugin = createNotionPlugin({ fetch: n.fetch });
  const out = await plugin.queries["docs.sources"]!({}, { workspaceId: "w1", log: () => {}, credential: { accessToken: n.token, expiresAt: "2026-11-14T13:00:00.000Z" } });
  expect(out).toMatchObject({ pages: expect.arrayContaining([expect.objectContaining({ id: BRAND })]) });
  await expect(plugin.queries["docs.sources"]!({}, { workspaceId: "w1", log: () => {}, credential: { username: "u", password: n.token } })).rejects.toThrow("Notion is not connected");
});

test("databases are listed by their data source, and a source's rows come with its columns, oldest edit first", async () => {
  const { n, q } = setup({}, 2);
  expect(await q("docs.sources", { kind: "database" })).toEqual({ pages: [{ id: CAL, title: "Content calendar", url: null, editedAt: "2026-11-10T10:00:00.000Z" }], more: false });
  expect(n.calls.at(-1)!.body).toMatchObject({ filter: { property: "object", value: "data_source" } });
  const first = (await q("docs.rows", { sourceId: CAL })) as { title: string; columns: unknown[]; rows: { id: string; values: unknown }[]; next: string | null };
  expect(first.title).toBe("Content calendar");
  // Ids as well as names, so a write-back goes by id and a rename can't redirect it (ADR 0025 rule 003).
  expect(first.columns).toEqual([
    { name: "Name", id: "Name", type: "title", options: null, choices: null },
    { name: "Date", id: "Date", type: "date", options: null, choices: null },
    { name: "Channel", id: "Channel", type: "select", options: ["LinkedIn", "X"], choices: [{ id: "opt-LinkedIn", name: "LinkedIn" }, { id: "opt-X", name: "X" }] },
    { name: "Tags", id: "Tags", type: "multi_select", options: ["Launch"], choices: [{ id: "opt-Launch", name: "Launch" }] },
    { name: "Caption", id: "Caption", type: "rich_text", options: null, choices: null },
    { name: "Owner", id: "Owner", type: "people", options: null, choices: null },
  ]);
  expect(first.rows.map((r) => r.values)).toEqual([
    { Name: "Teaser", Date: null, Channel: null, Tags: [], Caption: null, Owner: null },
    { Name: "Launch post", Date: "2026-12-01T09:00:00.000+00:00", Channel: "LinkedIn", Tags: ["Launch"], Caption: "We're live.", Owner: null },
  ]);
  expect(first.next).toBe("2");
  const second = (await q("docs.rows", { sourceId: CAL, cursor: first.next })) as { rows: { id: string }[]; next: string | null };
  expect(second.rows.map((r) => r.id)).toEqual(["44444444-4444-4444-8444-444444444443"]);
  expect(second.next).toBeNull();
  expect(n.calls.at(-1)!.body).toMatchObject({ start_cursor: "2", sorts: [{ timestamp: "last_edited_time", direction: "ascending" }] });
});

test("rows edited since a time come alone; a bad input or an unknown source is refused", async () => {
  const { n, q } = setup();
  const since = (await q("docs.rows", { sourceId: CAL.replaceAll("-", ""), editedSince: "2026-11-12T00:00:00.000Z" })) as { rows: { id: string }[] };
  expect(since.rows.map((r) => r.id)).toEqual(["44444444-4444-4444-8444-444444444441", "44444444-4444-4444-8444-444444444443"]);
  expect(n.calls.at(-1)!.body).toMatchObject({ filter: { timestamp: "last_edited_time", last_edited_time: { on_or_after: "2026-11-12T00:00:00.000Z" } } });
  await expect(q("docs.rows", { sourceId: CAL, editedSince: "yesterday" })).rejects.toThrow("docs.rows takes { sourceId, cursor?, editedSince? }");
  await expect(q("docs.rows", { sourceId: "55555555-5555-4555-8555-555555555555" })).rejects.toThrow("Notion answered 404: no_access");
});

test("a write-back sets the status and link by id, only over an option Direx wrote or none, and says what it made", async () => {
  const { n } = setup();
  const plugin = createNotionPlugin({ fetch: n.fetch });
  const effect = plugin.effects["docs.row.update"]!;
  const ctx = { workspaceId: "w1", log: () => {}, credential: { key: n.token }, idempotencyKey: "a1" };
  const row = "44444444-4444-4444-8444-444444444441";
  const base = { pageId: row, statusPropertyId: "Channel", statusType: "select" as const, optionId: "opt-X", lastOptionId: null };
  // "LinkedIn" is a person's own choice: Direx never wrote it, so it stands.
  expect(await effect.execute((await effect.prepare(base, ctx)).spec, ctx)).toEqual({ kind: "refused", permanent: true, retryable: false, detail: "changed_in_source" });
  expect(n.calls.filter((c) => c.method === "PATCH")).toHaveLength(0);
  // Over the option Direx last wrote, it writes, with the link, and hands back the edit time it made.
  const spec = { ...base, lastOptionId: "opt-LinkedIn", urlPropertyId: "Caption", url: "https://example.com/p/1" };
  const sent = await effect.execute(spec, ctx);
  expect(sent).toEqual({ kind: "sent", providerRef: "2026-11-20T00:01:00.000Z" });
  expect(n.calls.at(-1)).toMatchObject({ method: "PATCH", path: `/pages/${row}`, body: { properties: { Channel: { select: { id: "opt-X" } }, Caption: { url: "https://example.com/p/1" } } } });
  expect(n.sources[0]!.rows[0]!.values.Channel).toBe("X");
  await expect(effect.prepare({ ...base, name: "Channel" }, ctx)).rejects.toThrow();
  // A property gone since it was read: Notion answers 400, and that is final, not an unknown outcome.
  expect(await effect.execute({ ...spec, lastOptionId: "opt-X", urlPropertyId: "Gone" }, ctx)).toEqual({ kind: "refused", permanent: true, retryable: false, detail: "rejected" });
});

test("reconcile reads the row back: the whole patch is sent, the old value is not sent, anything else is unknown, and access errors are final", async () => {
  const { n } = setup();
  const effect = createNotionPlugin({ fetch: n.fetch }).effects["docs.row.update"]!;
  const ctx = { workspaceId: "w1", log: () => {}, credential: { key: n.token }, idempotencyKey: "a1" };
  const row = "44444444-4444-4444-8444-444444444443";
  const spec = { pageId: row, statusPropertyId: "Channel", statusType: "select" as const, optionId: "opt-LinkedIn", lastOptionId: "opt-X" };
  expect(await effect.reconcile!("a1", ctx, spec)).toEqual({ kind: "not_sent" });
  expect(await effect.reconcile!("a1", ctx, { ...spec, optionId: "opt-X", lastOptionId: null })).toMatchObject({ kind: "sent" });
  expect(await effect.reconcile!("a1", ctx, { ...spec, optionId: "opt-Other", lastOptionId: "opt-Old" })).toEqual({ kind: "unknown" });
  expect(await effect.reconcile!("a1", ctx, "not a spec")).toEqual({ kind: "unknown" });
  n.failNext("not_shared");
  expect(await effect.reconcile!("a1", ctx, spec)).toEqual({ kind: "refused", detail: "row_gone" });
  n.failNext("revoked");
  expect(await effect.execute(spec, ctx)).toEqual({ kind: "refused", permanent: true, retryable: false, detail: "needs_reconnecting", credentialRejected: true });
  n.failNext("rate_limited");
  expect(await effect.execute(spec, ctx)).toEqual({ kind: "refused", permanent: false, retryable: true, detail: "busy" });
  n.failNext("rate_limited");
  expect(await effect.reconcile!("a1", ctx, spec)).toEqual({ kind: "unknown" });
});
