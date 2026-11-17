// SPDX-License-Identifier: AGPL-3.0-only
// A password Mailbox end to end: the connect route signs in before saving, the vault hands the
// plugin its settings, an approved Action goes through the real ledger to a real mail server, a
// cut-off send settles without a second send, and a reply arrives in the shape reply handling reads.
import { createImapSmtpPlugin, mailboxProviders, type ImapSmtpOptions } from "@direx/extensions";
import { startFakeSmtp } from "@direx/extensions/imap-smtp/fake";
import { ImapFlow } from "imapflow";
import nodemailer from "nodemailer";
import { afterAll, expect, test, vi } from "vitest";
import { createBoss } from "../../jobs/boss";
import { createVault, credentialLabel, rootKeyFromEnv } from "./index";
import { testApp, vaultDb } from "./test-helpers";
import { approverIdFromSession, createLedger, oneKey } from "../ledger/index";
import { TRIGGERS } from "@direx/plugin-sdk/host";
import { EMAIL_RECEIVED, loadPlugins, type TriggerEvent } from "../plugins/index";
import { sendForCredential } from "../../worker";

vi.setConfig({ testTimeout: 30_000 });
const HOST = "127.0.0.1";
const IDS = "com.trydirex.imap-smtp";
const clock = { at: new Date() };
const logs: string[] = [];
const handed: TriggerEvent[] = [];
const fake = await startFakeSmtp();
const seeder = nodemailer.createTransport({ host: HOST, port: 3465, secure: true, auth: { user: "alice@example.com", pass: "secret" }, tls: { rejectUnauthorized: false } });
const boss = createBoss();
await boss.start();
await boss.createQueue("plugins.poll");
const vault = createVault({ rootKey: rootKeyFromEnv({ DIREX_MASTER_KEY: "22".repeat(32) })!, now: () => clock.at });

const load = (test: NonNullable<ImapSmtpOptions["test"]>) =>
  loadPlugins({
    sources: [{ mode: "in_process", plugin: createImapSmtpPlugin({ timeoutMs: 800, now: () => clock.at.getTime(), test: { untrustedCerts: true, ...test } }) }],
    credentials: vault.credentials,
    confinement: "none",
    log: (l) => logs.push(l),
    boss,
    now: () => clock.at,
    onEvent: async (_tx, e) => void handed.push(e),
  });
const plugins = load({ implicitTlsPort: 3465 });
const cutOff = load({ plainSmtp: true });
const ledgerOf = (effects: typeof plugins.effects) => createLedger({ boss, signingKeys: oneKey({ id: "test", secret: "t".repeat(32) }), effects, now: () => clock.at, resolvers: { credential: credentialLabel } });
const ledger = ledgerOf(plugins.effects);
await ledger.ensureQueue();
const cutOffLedger = ledgerOf(cutOff.effects);

const offered = mailboxProviders();
const onSelfHost = { providers: () => offered.filter((p) => p.deployments.includes("self_host")), check: plugins.checkMailbox };
const onCloud = { providers: () => offered.filter((p) => p.deployments.includes("cloud")), check: plugins.checkMailbox };
const { call, workspace } = testApp(vault, "http://direx.test", onSelfHost);
const cloud = testApp(vault, "http://direx.test", onCloud);
const { ws: W, owner } = await workspace();
const db = vaultDb();

afterAll(async () => {
  seeder.close();
  fake.stop();
  await db.close();
  await boss.stop({ graceful: false, close: true });
});

const approver = approverIdFromSession("00000000-0000-4000-8000-000000000001");
const person = { userId: approver as string };

function imap(email: string) {
  const c = new ImapFlow({ host: HOST, port: 3993, secure: true, auth: { user: email, pass: email }, logger: false, tls: { rejectUnauthorized: false } });
  c.on("error", () => {});
  return c;
}
async function withBox<T>(email: string, use: (c: ImapFlow) => Promise<T>) {
  const c = imap(email);
  await c.connect();
  try {
    return await use(c);
  } finally {
    await c.logout();
  }
}
const messages = (email: string) => withBox(email, async (c) => { const s = await c.status("INBOX", { messages: true }); return (s && s.messages) || 0; }).catch(() => 0);
async function until(check: () => Promise<boolean>) {
  for (let i = 0; i < 80; i++) {
    if (await check()) return;
    await Bun.sleep(100);
  }
  throw new Error("timed out");
}
const deliver = (to: string, subject: string, extra: string[] = []) =>
  seeder.sendMail({
    envelope: { from: "alice@example.com", to: [to] },
    raw: [`From: Kim <kim@example.org>`, `To: ${to}`, `Subject: ${subject}`, `Date: ${new Date().toUTCString()}`, `Message-ID: <${crypto.randomUUID()}@example.org>`, ...extra, "", "Hi there"].join("\r\n"),
  });
async function newAddress() {
  const email = `u${crypto.randomUUID()}@example.com`;
  await deliver(email, "Seed");
  await until(async () => (await messages(email)) > 0);
  return email;
}
const settingsFor = (email: string, smtpPort = "3465") => ({ fromAddress: email, smtpHost: HOST, smtpPort, imapHost: HOST, imapPort: "3993" });
const connect = (email: string, over: object = {}) =>
  call(`/api/w/${W}/mailboxes/imap_smtp`, owner.cookie, { method: "POST", body: { username: email, password: email, settings: settingsFor(email), ...over } });
async function connected(email: string) {
  const r = await connect(email);
  expect(r.status).toBe(201);
  return ((await r.json()) as { credential: { id: string } }).credential.id;
}
async function approved(l: typeof ledger, p: typeof plugins, credentialId: string, to: string) {
  const SEND = `${IDS}/email.send`;
  const { spec } = await p.prepare(W, SEND, { to: [to], subject: "Quick question", text: "Hi" });
  const { action } = await l.createAction(W, { idempotencyKey: crypto.randomUUID(), capability: SEND, dedupe: "queryable", spec, credentialId, actor: person });
  await l.submitForApproval(W, action.id, person);
  const r = await l.approve(W, action.id, { approverId: approver, draftVersion: 1, snapshot: [] });
  if (!r.ok) throw new Error(`approve: ${r.reason}`);
  return action.id;
}

test("the screen is told what to ask for; cloud isn't offered it and the route refuses there", async () => {
  const r = (await (await call(`/api/w/${W}/mailbox-providers`, owner.cookie)).json()) as { providers: { connection: string; connect: string; fields?: { name: string }[]; presets?: { values: Record<string, string> }[] }[] };
  const form = r.providers.find((p) => p.connection === "imap_smtp")!;
  expect(form.connect).toBe("form");
  expect(form.fields!.map((f) => f.name)).toEqual(["fromAddress", "fromName", "smtpHost", "smtpPort", "imapHost", "imapPort"]);
  expect(form.presets!.length).toBeGreaterThan(0);

  const other = await cloud.workspace();
  const list = (await (await cloud.call(`/api/w/${other.ws}/mailbox-providers`, other.owner.cookie)).json()) as { providers: { connection: string }[] };
  expect(list.providers.map((p) => p.connection)).toEqual(["google"]);
  const refused = await cloud.call(`/api/w/${other.ws}/mailboxes/imap_smtp`, other.owner.cookie, { method: "POST", body: { username: "a", password: "b", settings: {} } });
  expect(refused.status).toBe(404);
});

test("a correct form saves one Mailbox, the settings in the clear and the password encrypted, and never echoes it", async () => {
  const email = await newAddress();
  const secret = email;
  const res = await connect(email);
  expect(res.status).toBe(201);
  const text = await res.text();
  const { credential, hasSent } = JSON.parse(text) as { credential: { id: string; kind: string; scope: string; connection: string; key: string; ownerUserId: string; meta: Record<string, string> }; hasSent: boolean };
  expect(credential).toMatchObject({ kind: "basic", scope: "user", connection: "imap_smtp", key: email, ownerUserId: owner.userId });
  expect(credential.meta).toMatchObject({ username: email, smtpHost: HOST, smtpPort: "3465" });
  expect(credential.meta).not.toHaveProperty("password");
  expect(hasSent).toBe(false);
  const [row] = await db.q(W, "select * from credentials where id = $1", [credential.id]);
  const { meta: _meta, key: _key, name: _name, ...sealed } = row;
  expect(JSON.stringify(sealed)).not.toContain(secret);
  // A second connection of the same address is a duplicate, not a second Mailbox.
  expect((await connect(email)).status).toBe(409);
});

test("a wrong password, an unreachable server or a bad setting saves nothing, and says which side failed", async () => {
  const email = await newAddress();
  const password = `wrong-${crypto.randomUUID()}`;
  const count = async () => (await db.q(W, "select count(*)::int as n from credentials where key = $1", [email]))[0].n;
  const wrong = await connect(email, { password });
  expect(wrong.status).toBe(422);
  const body = await wrong.text();
  expect(body).toMatch(/SMTP/);
  expect(body).not.toContain(password);
  const unreachable = await connect(email, { settings: { ...settingsFor(email), smtpPort: "1" } });
  expect(unreachable.status).toBe(422);
  expect(await unreachable.text()).toMatch(/SMTP/);
  const imapDown = await connect(email, { settings: { ...settingsFor(email), imapPort: "1" } });
  expect(imapDown.status).toBe(422);
  expect(await imapDown.text()).toMatch(/IMAP/);
  expect((await connect(email, { settings: { smtpHost: "bad host" } })).status).toBe(422);
  expect(await count()).toBe(0);
});

test("a viewer can't connect a Mailbox", async () => {
  const other = await workspace();
  const res = await call(`/api/w/${other.ws}/mailboxes/imap_smtp`, undefined, { method: "POST", body: { username: "a", password: "b", settings: {} } });
  expect(res.status).toBe(401);
});

test("an approved email goes from the saved Mailbox through the ledger to the recipient, once", async () => {
  const email = await newAddress();
  const to = await newAddress();
  const credentialId = await connected(email);
  const bound = await sendForCredential(plugins, vault)(W, credentialId);
  expect(bound).toMatchObject({ id: `${IDS}/email.send`, dedupe: "queryable" });
  const id = await approved(ledger, plugins, credentialId, to);
  await ledger.run(W, id);
  expect(await ledger.getAction(W, id)).toMatchObject({ state: "sent", correlationKey: `<${id}@example.com>` });
  await until(async () => (await messages(to)) === 2);
  await Bun.sleep(200);
  expect(await messages(to)).toBe(2);
});

async function cutOffMailbox() {
  const email = await newAddress();
  const made = await vault.create({
    workspaceId: W,
    actorUserId: owner.userId,
    scope: "user",
    kind: "basic",
    connection: "imap_smtp",
    key: email,
    name: email,
    meta: { ...settingsFor(email, String(fake.port)), username: email },
    value: { password: email },
  });
  if (!made.ok) throw new Error(made.reason);
  return { email, credentialId: made.credential.id };
}
async function nextRetry(id: string) {
  const a = (await cutOffLedger.getAction(W, id))!;
  if (!a.nextAttemptAt) throw new Error("no retry scheduled");
  clock.at = a.nextAttemptAt;
  await cutOffLedger.run(W, id);
}

test("a send cut off after the server took it is found in Sent and settled, with no second send", async () => {
  const { email, credentialId } = await cutOffMailbox();
  fake.script.afterData = "drop";
  const before = fake.messages.length;
  const id = await approved(cutOffLedger, cutOff, credentialId, "kim@example.org");
  await cutOffLedger.run(W, id);
  expect((await cutOffLedger.getAction(W, id))!.state).not.toBe("sent");
  delete fake.script.afterData;
  await withBox(email, async (c) => {
    await c.mailboxCreate("Sent");
    await c.append("Sent", fake.messages.at(-1)!);
  });
  await nextRetry(id);
  expect(await cutOffLedger.getAction(W, id)).toMatchObject({ state: "sent", providerRef: `<${id}@example.com>` });
  expect(fake.messages).toHaveLength(before + 1);
});

test("with no Sent copy, it stays unknown at every try and waits for a person, having sent once", async () => {
  const { credentialId } = await cutOffMailbox();
  fake.script.afterData = "drop";
  const before = fake.messages.length;
  const id = await approved(cutOffLedger, cutOff, credentialId, "kim@example.org");
  await cutOffLedger.run(W, id);
  delete fake.script.afterData;
  for (let i = 0; i < 3; i++) await nextRetry(id);
  const held = (await cutOffLedger.getAction(W, id))!;
  expect(held.state).toBe("held");
  expect(held.nextAttemptAt).toBeNull();
  expect(fake.messages).toHaveLength(before + 1);
});

test("a reply reaches the host once, in the shape reply handling reads, matched to its send", async () => {
  const email = await newAddress();
  const credentialId = await connected(email);
  const sendId = `<${crypto.randomUUID()}@example.com>`;
  const before = await messages(email);
  await deliver(email, "Re: Quick question", [`In-Reply-To: ${sendId}`]);
  await until(async () => (await messages(email)) > before);
  handed.length = 0;
  const poll = () => plugins.runPoll({ workspaceId: W, pluginId: IDS, trigger: EMAIL_RECEIVED, credentialId });
  await poll();
  const reply = handed.find((e) => (e.data as { headers: { subject: string } }).headers.subject === "Re: Quick question")!;
  // IMAP's real message fits the catalogue's strict email.received entry.
  const parsed = TRIGGERS["email.received"].data.parse(reply.data);
  expect(parsed.headers.inReplyTo).toBe(sendId);
  expect(parsed.headers.from).toContain("kim@example.org");
  expect(reply.credentialId).toBe(credentialId);
  const count = handed.length;
  await poll();
  expect(handed).toHaveLength(count);
});

test("no log line holds a password", () => {
  expect(logs.join("\n")).not.toMatch(/@example\.com.*secret|wrong-/);
});
