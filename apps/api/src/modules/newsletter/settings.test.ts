// SPDX-License-Identifier: AGPL-3.0-only
// The weekly newsletter's settings: a connected list must be this Workspace's active newsletter key,
// and Substack needs none.
import type { OpenAPIHono } from "@hono/zod-openapi";
import { afterAll, expect, test } from "vitest";
import { appClient } from "../../../../../test/db";
import { createVault, rootKeyFromEnv } from "../credentials/index";
import { TEST_SECRET, testIdentity } from "./fixtures/support";
import { createNewsletter, newsletterRoutes } from "./index";

process.env.DIREX_AUTH_SECRET = TEST_SECRET;
const vault = createVault({ rootKey: rootKeyFromEnv({ DIREX_MASTER_KEY: "11".repeat(32) })!, now: () => new Date() });
let profileDown = false;
const AUDIENCES = [{ id: "a1", name: "Founders", subscriberCount: 340 }, { id: "b2", name: "Customers", subscriberCount: 1200 }];
const newsletter = createNewsletter({
  credentials: (ws) => vault.list(ws),
  lists: () => ["kit", "beehiiv", "mailchimp"],
  hasLists: (c) => c === "mailchimp",
  listsOf: async () => AUDIENCES,
  profileOf: async (_ws, _id, connection, listId) => {
    if (profileDown) throw new Error("Kit answered 503");
    return { subscriberCount: connection === "mailchimp" ? AUDIENCES.find((l) => l.id === listId)!.subscriberCount : 3 };
  },
  setMeta: (ws, id, name, value) => vault.setMeta(ws, id, name, value),
});
const { routes, signIn, createOrg, call } = testIdentity();
(routes as unknown as OpenAPIHono).route("/", newsletterRoutes({ newsletter: () => newsletter, issues: () => { throw new Error("no issues here"); } }));

const cookie = await signIn();
const W = (await createOrg(cookie, "Letters")).workspace.id;
const other = (await createOrg(cookie, "Elsewhere")).workspace.id;
const db = await appClient();
afterAll(() => db.end());
async function ownerOf(ws: string) {
  await db.query("begin");
  await db.query("select set_config('app.workspace_id', $1, true)", [ws]);
  const r = await db.query("select user_id from workspace_members limit 1");
  await db.query("commit");
  return r.rows[0].user_id as string;
}
async function key(ws: string, connection: string) {
  const made = await vault.create({ workspaceId: ws, actorUserId: await ownerOf(ws), scope: "workspace", kind: "api_key", key: `api_key:${connection}`, connection, name: connection, meta: {}, value: { key: "x" } });
  if (!made.ok) throw new Error(made.reason);
  return made.credential.id;
}
const kit = await key(W, "kit");
const elsewhere = await key(other, "kit");
const reoon = await key(W, "reoon");

const put = (ws: string, body: unknown) => call(`/api/w/${ws}/newsletter/settings`, cookie, { method: "PUT", body });
const base = { list: "connected", credentialId: kit, weekday: 2, sendTime: "09:00", timeZone: "Europe/Berlin", enabled: true };

const kitList = { credentialId: kit, connection: "kit", name: "kit" };
const unchosen = { hasLists: false, listId: null, listName: null };
const platforms = [
  { connection: "kit", name: "kit", credentialId: kit, ...unchosen },
  { connection: "beehiiv", name: "beehiiv", credentialId: null, ...unchosen },
  { connection: "mailchimp", name: "mailchimp", credentialId: null, ...unchosen, hasLists: true },
];
test("nothing is set up at first; every platform is offered, and the Workspace's Kit key is the list to pick; its other keys are not", async () => {
  expect(await (await call(`/api/w/${W}/newsletter/settings`, cookie)).json()).toEqual({ settings: null, platforms, lists: [kitList], nextSlot: null, quiet: false, subscriberCount: null });
});

test("a connected Kit list and a Tuesday slot save and read back", async () => {
  expect((await put(W, base)).status).toBe(200);
  expect(await (await call(`/api/w/${W}/newsletter/settings`, cookie)).json()).toEqual({ settings: { ...base, readOnlySince: null, readOnlyReason: null, lastSentAt: null }, platforms, lists: [kitList], nextSlot: expect.stringMatching(/^\d{4}-\d\d-\d\dT0[78]:00:00\.000Z$/), quiet: false, subscriberCount: 3 });
});

test("another Workspace's list, a key that isn't a newsletter, or an unknown zone is refused", async () => {
  expect(await (await put(W, { ...base, credentialId: elsewhere })).json()).toEqual({ error: "list_not_connected" });
  expect(await (await put(W, { ...base, credentialId: reoon })).json()).toEqual({ error: "list_not_connected" });
  expect(await (await put(W, { ...base, timeZone: "Mars/Olympus" })).json()).toEqual({ error: "bad_time_zone" });
  // A refused field comes back as a plain error the page can show, not the validator's object.
  expect(await (await put(W, { ...base, sendTime: "25:00" })).json()).toEqual({ error: expect.stringMatching(/^sendTime: /) });
});

test("a tool that can't be read gives no subscriber count, and the page still loads", async () => {
  profileDown = true;
  const r = await call(`/api/w/${W}/newsletter/settings`, cookie);
  profileDown = false;
  expect(r.status).toBe(200);
  expect(await r.json()).toMatchObject({ settings: { credentialId: kit }, subscriberCount: null });
});

test("Substack needs no connection, and drops one sent along", async () => {
  const r = await put(W, { ...base, list: "substack", credentialId: kit });
  expect(((await r.json()) as { settings: { credentialId: string | null } }).settings.credentialId).toBeNull();
  expect(await (await call(`/api/w/${W}/newsletter/settings`, cookie)).json()).toMatchObject({ subscriberCount: null });
});

test("one Workspace's settings are never another's", async () => {
  expect(await (await call(`/api/w/${other}/newsletter/settings`, cookie)).json()).toMatchObject({ settings: null, lists: [{ credentialId: elsewhere }] });
});

test("a key's lists are read and one is chosen through the routes; a key without lists, or another Workspace's, is refused", async () => {
  const mailchimp = await key(W, "mailchimp");
  const lists = (id: string, ws = W) => call(`/api/w/${ws}/newsletter/keys/${id}/lists`, cookie);
  const choose = (id: string, listId: string) => call(`/api/w/${W}/newsletter/keys/${id}/list`, cookie, { method: "PUT", body: { listId } });
  expect(await (await lists(mailchimp)).json()).toEqual({ lists: AUDIENCES });
  expect(await (await choose(mailchimp, "zz9")).json()).toEqual({ error: "not_listed" });
  expect(await (await choose(kit, "a1")).json()).toEqual({ error: "no_lists" });
  expect((await lists(elsewhere)).status).toBe(404);
  expect(await (await choose(mailchimp, "b2")).json()).toEqual({ list: AUDIENCES[1] });
  const page = (await (await call(`/api/w/${W}/newsletter/settings`, cookie)).json()) as { platforms: unknown[] };
  expect(page.platforms[2]).toEqual({ connection: "mailchimp", name: "mailchimp", credentialId: mailchimp, hasLists: true, listId: "b2", listName: "Customers" });
  // The count is the chosen list's, not the whole account's.
  expect((await put(W, { ...base, credentialId: mailchimp })).status).toBe(200);
  expect(await (await call(`/api/w/${W}/newsletter/settings`, cookie)).json()).toMatchObject({ subscriberCount: 1200 });
});

test("the preview is the issue's own rendering, so what a person sees is what goes out", async () => {
  const r = await call(`/api/w/${W}/newsletter/preview`, cookie, { method: "POST", body: { markdown: "# Hi\n\n<b>x</b> **y**" } });
  expect(await r.json()).toEqual({ html: "<h2>Hi</h2>\n<p>&lt;b&gt;x&lt;/b&gt; <strong>y</strong></p>" });
});
