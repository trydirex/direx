// SPDX-License-Identifier: AGPL-3.0-only
// A mailbox provider that core has never heard of: a draft binds to it through its credential, it
// sends through the real ledger, the sending floors hold it, and the poll sweep finds it.
import { createGmailPlugin } from "@direx/extensions";
import { startFakeGmail } from "@direx/extensions/gmail/fake";
import type { OpenAPIHono } from "@hono/zod-openapi";
import { afterAll, expect, test } from "vitest";
import { appClient } from "../../../test/db";
import { createBoss } from "./jobs/boss";
import { createVault, credentialLabel, credentialReady, rootKeyFromEnv } from "./modules/credentials/index";
import { approverMayApprove, workspaceLive } from "./modules/identity/index";
import { createItems, itemRoutes } from "./modules/items/index";
import { TEST_SECRET, testIdentity, testLedger } from "./modules/outreach/fixtures/support";
import { connectedMailboxes, createOutreach, outreachFloors, outreachRoutes } from "./modules/outreach/index";
import { createTestMail } from "./modules/plugins/fixtures/mailbox";
import { EMAIL_RECEIVED, loadPlugins, mailboxRepliesRead } from "./modules/plugins/index";
import { touchCheck } from "./modules/schedule/index";
import { sendForCredential } from "./worker";
import { passMailboxCheck } from "./modules/outreach/fixtures/support";

process.env.DIREX_AUTH_SECRET = TEST_SECRET;

const fake = startFakeGmail();
const testMail = createTestMail();
const boss = createBoss();
await boss.start();
await boss.createQueue("plugins.poll");
const HOUR = 60 * 60 * 1000;

const plugins = loadPlugins({
  sources: [
    { mode: "in_process", plugin: testMail.plugin },
    { mode: "in_process", plugin: createGmailPlugin({ baseUrl: fake.url, timeoutMs: 1000 }) },
  ],
  credentials: async (_ws, id) => (id === gmailId ? { accessToken: fake.token, expiresAt: "" } : { key: "k" }),
  confinement: "none",
  log: () => {},
  boss,
  now: () => clock.at,
  onEvent: async () => {},
});
const { clock, ledger } = await testLedger({
  effects: plugins.effects,
  resolvers: { credential: credentialLabel, capability: async (_tx, id) => plugins.capabilityVersion(id) },
  checks: [
    workspaceLive(),
    outreachFloors(mailboxRepliesRead(plugins, { now: () => clock.at, withinMs: HOUR })),
    approverMayApprove(),
    touchCheck({ effects: plugins.effects, now: () => clock.at }),
    credentialReady,
  ],
  now: () => clock.at,
});
const items = createItems({ ledger, now: () => clock.at });
const vault = createVault({ rootKey: rootKeyFromEnv({ DIREX_MASTER_KEY: "11".repeat(32) })!, now: () => clock.at });
const outreach = createOutreach({ items: () => items, send: sendForCredential(plugins, vault), baseUrl: () => "http://direx.test", now: () => clock.at });

const { routes, signIn, createOrg, call } = testIdentity();
const routed = routes as unknown as OpenAPIHono;
routed.route("/", itemRoutes({ items: () => items }));
routed.route("/", outreachRoutes({ outreach: () => outreach }));
const cookie = await signIn();
const W = (await createOrg(cookie, "Acme")).workspace.id;
const post = async <T>(path: string, body: unknown, method = "POST"): Promise<{ status: number; body: T }> => {
  const r = await call(`/api/w/${W}${path}`, cookie, { method, body });
  return { status: r.status, body: (await r.json()) as T };
};
const db = await appClient();
afterAll(async () => {
  fake.stop();
  await db.end();
  await boss.stop({ graceful: false, close: true });
});
async function q(text: string, params: unknown[] = []) {
  await db.query("begin");
  await db.query("select set_config('app.workspace_id', $1, true)", [W]);
  const r = await db.query(text, params);
  await db.query("commit");
  return r.rows;
}

const owner = (await q("select user_id from workspace_members"))[0].user_id as string;
async function credential(key: string, connection: string | null): Promise<string> {
  const made = await vault.create({ workspaceId: W, actorUserId: owner, scope: "workspace", kind: "api_key", key, name: key, meta: {}, value: { key: "x" } });
  if (!made.ok) throw new Error(made.reason);
  await q("update credentials set connection = $1 where id = $2", [connection, made.credential.id]);
  await passMailboxCheck(W, made.credential.id);
  return made.credential.id;
}
const testMailbox = await credential("testmail-box", "testmail");
const gmailId = await credential("gmail-box", "google");
const modelKey = await credential("model-key", null);
await post("/outreach/identity", { senderName: "Sam at Acme", postalAddress: "1 Main St, Springfield" }, "PUT");

const addPerson = async () =>
  (await post<{ id: string }>("/outreach/people", { email: `${crypto.randomUUID()}@example.com`, country: "US", basis: "published_address", evidence: "their site's contact page" })).body.id;
const write = async (credentialId: string) => post<{ itemId: string; error?: string }>("/outreach/emails", { personId: await addPerson(), credentialId, touchClass: "cold", subject: `Hello ${crypto.randomUUID()}`, text: "Hi" });
async function approve(itemId: string) {
  const { item } = (await (await call(`/api/w/${W}/items/${itemId}`, cookie)).json()) as { item: { revision: number } };
  const r = await call(`/api/w/${W}/items/${itemId}/approve`, cookie, { method: "POST", body: { revision: item.revision } });
  expect(r.status).toBe(200);
  return (await q("select action_id from items where id = $1", [itemId]))[0].action_id as string;
}
const poll = (credentialId: string) => plugins.runPoll({ workspaceId: W, pluginId: "com.example.testmail", trigger: EMAIL_RECEIVED, credentialId });

test("each draft binds to the provider behind its Mailbox, with that provider's dedupe class", async () => {
  const a = await write(testMailbox);
  const g = await write(gmailId);
  const rows = await q("select i.id, a.capability, a.dedupe_class as dedupe from items i join actions a on a.id = i.action_id where i.id = any($1)", [[a.body.itemId, g.body.itemId]]);
  expect(rows.find((r) => r.id === a.body.itemId)).toMatchObject({ capability: "com.example.testmail/email.send", dedupe: "blind" });
  expect(rows.find((r) => r.id === g.body.itemId)).toMatchObject({ dedupe: "queryable" });
});

test("a credential with no mailbox provider can't write an email", async () => {
  expect(await write(modelKey)).toMatchObject({ status: 404 });
  expect(await outreach.canSendFrom(W, modelKey)).toBe(false);
  expect(await outreach.canSendFrom(W, testMailbox)).toBe(true);
});

test("a provider core doesn't know is held until its replies are read, then sends once", async () => {
  const before = testMail.sent.length;
  const w = await write(testMailbox);
  const actionId = await approve(w.body.itemId);
  await ledger.run(W, actionId);
  expect(await ledger.getAction(W, actionId)).toMatchObject({ state: "held", holdReason: "replies_not_read" });
  expect(testMail.sent).toHaveLength(before);

  await poll(testMailbox);
  await ledger.resumeHeldBy(W, "replies_not_read", { system: "outreach" }, async () => true);
  await ledger.run(W, actionId);
  expect(await ledger.getAction(W, actionId)).toMatchObject({ state: "sent" });
  expect(testMail.sent).toHaveLength(before + 1);
});

test("the sweep lists active credentials of any kind on the connections it is given, and no others", async () => {
  const listed = async (connections: string[]) => (await connectedMailboxes(connections)).filter((m) => m.workspaceId === W);
  expect((await listed(["testmail"])).map((m) => [m.credentialId, m.connection])).toEqual([[testMailbox, "testmail"]]);
  expect((await listed(["testmail", "google"])).map((m) => m.credentialId).sort()).toEqual([testMailbox, gmailId].sort());
  expect(await listed([])).toEqual([]);
  expect((await listed(["testmail", "google"])).map((m) => m.credentialId)).not.toContain(modelKey);
});

test("a capability's version moves only with its own declaration", () => {
  const base = createGmailPlugin({ baseUrl: fake.url, timeoutMs: 1000 });
  const SEND = `${base.manifest.id}/email.send`;
  const versionWith = (capabilities: typeof base.manifest.capabilities) =>
    loadPlugins({ sources: [{ mode: "in_process", plugin: { ...base, manifest: { ...base.manifest, capabilities } } }], credentials: async () => ({ key: "k" }), confinement: "none", log: () => {} }).capabilityVersion(SEND);
  const original = base.manifest.capabilities;
  const version = versionWith(original);
  expect(version).toBeTruthy();
  expect(versionWith(original.filter((c) => c.name !== "mail.from"))).toBe(version);
  expect(versionWith(original.map((c) => (c.name === "email.send" ? { ...c, risk: "high" as const } : c)))).not.toBe(version);
  expect(versionWith(original.filter((c) => c.name !== "email.send"))).toBeNull();
});
