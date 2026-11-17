// SPDX-License-Identifier: AGPL-3.0-only
// A docs tool over HTTP, against the real Notion plugin on a fake Notion and real Postgres: pages read for
// brand facts (P1), and a database imported to the Calendar (P2). Posts are made through `writePost`,
// which here makes a real Item and keeps its state and revision, as the social module's write would.
import { expect, test } from "vitest";
import { createFakeNotion, createNotionPlugin, type FakeNotionSource } from "@direx/extensions";
import { itemsApp } from "../items/fixtures/items";
import { PluginError } from "@direx/plugin-sdk";
import { CallFailed, docsProviders, loadPlugins } from "../plugins/index";
import { directQuery } from "../plugins/fixtures/query";
import { createDocs, docsRoutes } from "./index";

const PAGE = "11111111-1111-4111-8111-111111111111";
const EMPTY = "22222222-2222-4222-8222-222222222222";
const CAL = "33333333-3333-4333-8333-333333333333";
const row = (n: number) => `44444444-4444-4444-8444-44444444444${n}`;
const LINKEDIN = "55555555-5555-4555-8555-555555555551";
const calendar: FakeNotionSource = {
  id: CAL,
  title: "Content calendar",
  columns: { Name: { type: "title" }, Date: { type: "date" }, Channel: { type: "select", options: ["LinkedIn", "TikTok"] }, Caption: { type: "rich_text" } },
  rows: [
    { id: row(1), editedAt: "2026-11-12T09:00:00.000Z", values: { Name: "Launch post", Date: "2026-12-01", Channel: "LinkedIn", Caption: "We're live." } },
    { id: row(2), editedAt: "2026-11-12T09:00:00.000Z", values: { Name: "Teaser", Date: null, Channel: "LinkedIn", Caption: "Soon." } },
    { id: row(3), editedAt: "2026-11-12T09:00:00.000Z", values: { Name: "Old", Date: "2026-11-01", Channel: "LinkedIn", Caption: "Past." } },
    { id: row(4), editedAt: "2026-11-12T09:00:00.000Z", values: { Name: "Video", Date: "2026-12-02", Channel: "TikTok", Caption: "Clip." } },
    { id: row(5), editedAt: "2026-11-12T09:00:00.000Z", values: { Name: "Recap", Date: "2026-12-05T15:30:00.000Z", Channel: "LinkedIn", Caption: "Thanks all." } },
  ],
};
const notion = createFakeNotion({ pages: [{ id: PAGE, title: "Brand guide", blocks: [{ type: "paragraph", text: "We sell bookkeeping to clinics." }] }, { id: EMPTY, title: "Empty", blocks: [] }], sources: [calendar] });
const plugin = createNotionPlugin({ fetch: notion.fetch });
const started: { workspaceId: string; text: string; startedBy: string }[] = [];
let connected = new Set<string>();

const { routes, call, signIn, createOrg, addMember, items } = await itemsApp({ kinds: { "test.import": { permission: "item.approve", apply: async () => ({ ok: true }) } } });
// What the social module would hold for each post: its words, time, state and revision.
const posts = new Map<string, { text: string; at: Date; state: string; revision: number }>();
const docs = createDocs({
  provider: () => docsProviders([plugin.manifest])[0],
  credentials: async (workspaceId) => (connected.has(workspaceId) ? [{ id: "c1", connection: "notion" }, { id: "c0", connection: "beehiiv" }] : []),
  // As the host does: the plugin's query, by its capability id, with the stored key.
  // A plugin's failure reaches core as the host's CallFailed, with the plugin's typed fields.
  query: (workspaceId, capability, input) =>
    directQuery(plugin, () => ({ key: notion.token }))(workspaceId, capability, input, "c1").catch((e: unknown) => {
      throw new CallFailed(`plugin error: ${(e as Error).message}`, e instanceof PluginError ? e : { reason: "failed" });
    }),
  startBrandReader: async (workspaceId, a) => {
    started.push({ workspaceId, ...a });
    return { ok: true, run: { id: crypto.randomUUID() } };
  },
  accounts: async () => [{ id: LINKEDIN, credentialId: crypto.randomUUID(), connection: "linkedin", networkId: "urn:li:person:1", name: "Sam" }],
  writePost: async (workspaceId, p, userId) => {
    const made = await items.createItem(workspaceId, { kind: "test.import", payload: {}, actor: { userId }, details: { title: p.text, warnings: [] } });
    if (!made.ok) return { ok: false, reason: made.reason };
    posts.set(made.item.id, { text: p.text, at: p.at, state: "needs_approval", revision: 1 });
    return { ok: true, itemId: made.item.id };
  },
  editPost: async (_w, itemId, text) => {
    const p = posts.get(itemId)!;
    posts.set(itemId, { ...p, text, revision: p.revision + 1 });
    return { ok: true };
  },
  movePost: async (_w, itemId, at) => {
    posts.set(itemId, { ...posts.get(itemId)!, at });
    return { ok: true };
  },
  postOf: async (_w, itemId) => posts.get(itemId),
  timeZone: async () => "America/New_York",
  now: () => new Date("2026-11-14T12:00:00.000Z"),
});
routes.route("/", docsRoutes({ docs: () => docs }));
const owner = await signIn();
const W = (await createOrg(owner)).workspace.id;
const viewer = (await addMember(owner, W, "viewer")).cookie;
const url = (rest: string) => `/api/w/${W}/docs${rest}`;
const send = (path: string, cookie = owner, method = "POST", body?: unknown) => call(url(path), cookie, { method, ...(body !== undefined && { body }) });
const mapping = { date: "Date", channel: "Channel", text: { column: "Caption" }, accounts: { LinkedIn: LINKEDIN } };

test("found by its queries, Notion is offered; until a key is stored, reading is refused as not connected", async () => {
  connected = new Set();
  expect(await (await call(url(""), viewer)).json()).toEqual({ provider: "Notion", connected: false, imports: true, signIn: null });
  const r = await call(url("/pages"), owner);
  expect(r.status).toBe(409);
  expect(await r.json()).toEqual({ error: "not_connected" });
});

test("connected, it lists the shared pages, and reading one starts the brand reader on its title and text", async () => {
  connected = new Set([W]);
  const pages = (await (await call(url("/pages"), owner)).json()) as { pages: { id: string; title: string }[] };
  expect(pages.pages.map((p) => p.title)).toEqual(["Brand guide", "Empty"]);
  const read = await send(`/pages/${PAGE}/read`);
  expect(read.status).toBe(200);
  expect(await read.json()).toMatchObject({ title: "Brand guide", cut: false });
  expect(started.at(-1)).toMatchObject({ workspaceId: W, text: "Brand guide\n\nWe sell bookkeeping to clinics." });
});

test("an empty page, a page not shared, a revoked key and a viewer are each refused, and none starts a run", async () => {
  connected = new Set([W]);
  const before = started.length;
  expect(await (await send(`/pages/${EMPTY}/read`)).json()).toEqual({ error: "empty_page" });
  notion.failNext("not_shared");
  expect(await (await send(`/pages/${PAGE}/read`)).json()).toEqual({ error: "no_access" });
  notion.failNext("revoked");
  expect(await (await call(url("/pages"), owner)).json()).toEqual({ error: "needs_reconnecting" });
  expect((await send(`/pages/${PAGE}/read`, viewer)).status).toBe(403);
  expect((await send("/pages/not-an-id/read")).status).toBe(400);
  expect(started.length).toBe(before);
});

test("a database is mapped against its own columns and the Workspace's accounts, or refused saying what's wrong", async () => {
  connected = new Set([W]);
  expect(await (await call(url("/databases"), owner)).json()).toEqual({ databases: [{ id: CAL, title: "Content calendar", editedAt: "2026-11-10T10:00:00.000Z", sourceId: null }] });
  const db = (await (await call(url(`/databases/${CAL}`), owner)).json()) as { columns: { name: string }[]; mapping: unknown };
  expect(db.columns.map((c) => c.name)).toEqual(["Name", "Date", "Channel", "Caption"]);
  expect(db.mapping).toBeNull();
  const put = (m: unknown, cookie = owner) => send(`/databases/${CAL}/mapping`, cookie, "PUT", m);
  expect(await (await put({ ...mapping, date: "Name" })).json()).toEqual({ error: "date_not_a_date" });
  expect(await (await put({ ...mapping, channel: "Caption" })).json()).toEqual({ error: "channel_not_a_choice" });
  expect(await (await put({ ...mapping, accounts: { Instagram: LINKEDIN } })).json()).toEqual({ error: "unknown_channel_value" });
  expect(await (await put({ ...mapping, accounts: { LinkedIn: crypto.randomUUID() } })).json()).toEqual({ error: "unknown_account" });
  expect((await put(mapping, viewer)).status).toBe(403);
  const saved = (await (await put(mapping)).json()) as { sourceId: string };
  expect((await (await call(url(`/databases/${CAL}`), owner)).json()) as unknown).toMatchObject({ sourceId: saved.sourceId, mapping });
  expect(((await (await put(mapping)).json()) as { sourceId: string }).sourceId).toBe(saved.sourceId);
});

test("preview says what each row will do; import makes waiting posts; Check again updates an untouched post and flags an edited one", async () => {
  connected = new Set([W]);
  const { sourceId } = (await (await send(`/databases/${CAL}/mapping`, owner, "PUT", mapping)).json()) as { sourceId: string };
  const preview = (await (await send(`/sources/${sourceId}/preview`)).json()) as { rows: { title: string; outcome: string; reason?: string }[] };
  expect(preview.rows.map((r) => [r.title, r.outcome, r.reason])).toEqual([
    ["Launch post", "make", undefined],
    ["Teaser", "skip", "no_date"],
    ["Old", "skip", "past_date"],
    ["Video", "skip", "no_channel"],
    ["Recap", "make", undefined],
  ]);
  expect(posts.size).toBe(0);

  const first = (await (await send(`/sources/${sourceId}/import`)).json()) as { made: number; skipped: unknown[] };
  expect(first).toMatchObject({ made: 2, updated: 0, changed: 0 });
  expect(first.skipped).toHaveLength(3);
  const made = [...posts.values()];
  expect(made.map((p) => p.text)).toEqual(["We're live.", "Thanks all."]);
  // A day with no time is 9:00 in the Workspace's zone: New York is UTC-5 in December.
  expect(made[0]!.at.toISOString()).toBe("2026-12-01T14:00:00.000Z");
  expect(made[1]!.at.toISOString()).toBe("2026-12-05T15:30:00.000Z");

  // Nothing changed in Notion: importing again does nothing.
  expect(await (await send(`/sources/${sourceId}/import`)).json()).toMatchObject({ made: 0, updated: 0, changed: 0 });

  // Both rows edited in Notion; someone edited the Recap post in Direx meanwhile.
  const [launchId, recapId] = [...posts.keys()];
  posts.set(recapId!, { ...posts.get(recapId!)!, revision: 2 });
  calendar.rows[0] = { ...calendar.rows[0]!, editedAt: "2026-11-14T10:00:00.000Z", values: { ...calendar.rows[0]!.values, Caption: "We're live today.", Date: "2026-12-03" } };
  calendar.rows[4] = { ...calendar.rows[4]!, editedAt: "2026-11-14T10:00:00.000Z", values: { ...calendar.rows[4]!.values, Caption: "Thank you." } };
  const plan = (await (await send(`/sources/${sourceId}/preview`)).json()) as { rows: { title: string; outcome: string }[] };
  expect(plan.rows.filter((r) => r.outcome !== "skip").map((r) => [r.title, r.outcome])).toEqual([
    ["Launch post", "update"],
    ["Recap", "changed"],
  ]);
  expect(await (await send(`/sources/${sourceId}/import`)).json()).toMatchObject({ made: 0, updated: 1, changed: 1 });
  expect(posts.get(launchId!)).toMatchObject({ text: "We're live today.", revision: 2 });
  expect(posts.get(launchId!)!.at.toISOString()).toBe("2026-12-03T14:00:00.000Z");
  expect(posts.get(recapId!)!.text).toBe("Thanks all.");
  // The updated post is untouched again at its new revision; the flagged one stays as it is.
  expect(await (await send(`/sources/${sourceId}/import`)).json()).toMatchObject({ made: 0, updated: 0, changed: 0 });
});

test("an unknown source, a viewer, and a revoked key are refused before anything is made", async () => {
  connected = new Set([W]);
  expect((await send(`/sources/${crypto.randomUUID()}/preview`)).status).toBe(404);
  const { sourceId } = (await (await send(`/databases/${CAL}/mapping`, owner, "PUT", mapping)).json()) as { sourceId: string };
  expect((await send(`/sources/${sourceId}/import`, viewer)).status).toBe(403);
  const before = posts.size;
  notion.failNext("revoked");
  expect(await (await send(`/sources/${sourceId}/import`)).json()).toEqual({ error: "needs_reconnecting" });
  expect(posts.size).toBe(before);
});

test("on the Notion OAuth connection, the same reads run through the host with the access token, and sign-in is offered until it's connected", async () => {
  // The real host seam: it checks the credential's kind against the connections each capability runs on.
  const host = loadPlugins({ sources: [{ mode: "in_process", plugin }], credentials: async (_w, id) => (id === "oauth" ? { accessToken: notion.token, expiresAt: "2026-11-14T13:00:00.000Z" } : id === "basic" ? { username: "u", password: "p" } : null), confinement: "none", log: () => {}, onEvent: async () => {} });
  let stored: { id: string; connection: string }[] = [];
  const signedIn = createDocs({
    provider: () => docsProviders([plugin.manifest])[0],
    credentials: async () => stored,
    canSignIn: async (workspaceId, connection) => workspaceId === W && connection === "notion_oauth",
    query: (workspaceId, capability, input, credentialId) => host.query(workspaceId, capability, input, credentialId),
    startBrandReader: async () => ({ ok: true, run: { id: crypto.randomUUID() } }),
    accounts: async () => [],
    writePost: async () => ({ ok: false, reason: "unused" }),
    editPost: async () => ({ ok: true }),
    movePost: async () => ({ ok: true }),
    postOf: async () => undefined,
    timeZone: async () => "UTC",
  });
  expect(docsProviders([plugin.manifest])).toEqual([expect.objectContaining({ connections: ["notion", "notion_oauth"], oauth: "notion_oauth", write: "com.trydirex.notion/docs.row.update" })]);
  expect(await signedIn.status(W)).toEqual({ provider: "Notion", connected: false, imports: true, signIn: "notion_oauth" });
  expect((await signedIn.status(crypto.randomUUID())).signIn).toBeNull();
  stored = [{ id: "oauth", connection: "notion_oauth" }];
  expect(await signedIn.status(W)).toMatchObject({ connected: true });
  expect(await signedIn.pages(W)).toMatchObject({ ok: true, pages: expect.arrayContaining([expect.objectContaining({ id: PAGE, title: "Brand guide" })]) });
  // A kind neither connection declares is refused by the host before the plugin is called.
  stored = [{ id: "basic", connection: "notion_oauth" }];
  expect(await signedIn.pages(W)).toEqual({ ok: false, reason: "failed" });
  await host.close({ force: true });
});
