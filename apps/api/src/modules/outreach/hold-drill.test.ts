// SPDX-License-Identifier: AGPL-3.0-only
// The suspension drill (docs/operator-holds.md): an Organization with two Workspaces, each with a
// Mailbox on GreenMail, approves 20 cold emails, and two dispatchers send them. An operator hold on
// the Organization lands mid-run. Nothing whose dispatch starts after the hold commits reaches
// GreenMail, and the rest wait as operator_hold. An opt-out recorded while held stops that Person:
// lifting the hold checks everything again, so they get nothing and the others go out. Run by hand
// on a staging server too, where the time from the hold to the last delivery is recorded.
import { createImapSmtpPlugin } from "@direx/extensions";
import type { Credential } from "@direx/plugin-sdk";
import { OpenAPIHono } from "@hono/zod-openapi";
import { ImapFlow } from "imapflow";
import nodemailer from "nodemailer";
import { afterAll, expect, test, vi } from "vitest";
import { ownerClient } from "../../../../../test/db";
import { createVault, credentialLabel, credentialReady, rootKeyFromEnv } from "../credentials/index";
import { approverMayApprove, workspaceLive } from "../identity/index";
import { createItems, itemRoutes } from "../items/index";
import { loadPlugins } from "../plugins/index";
import { touchCheck } from "../schedule/index";
import { passMailboxCheck, TEST_SECRET, testIdentity, testLedger } from "./fixtures/support";
import { createOutreach, outreachFloors, outreachRoutes } from "./index";

vi.setConfig({ testTimeout: 180_000 });
process.env.DIREX_AUTH_SECRET = TEST_SECRET;

const HOST = "127.0.0.1";
const SEND = "com.trydirex.imap-smtp/email.send";
const EMAILS = 20;
const HOLD_AFTER = 6;
// GreenMail makes a mailbox for any address it delivers to, with the address as its password.
const login = (email: string): Credential => ({ username: email, password: email, settings: { fromAddress: email, smtpHost: HOST, smtpPort: "3465", imapHost: HOST, imapPort: "3993" } });
const seeder = nodemailer.createTransport({ host: HOST, port: 3465, secure: true, auth: { user: "alice@example.com", pass: "secret" }, tls: { rejectUnauthorized: false } });
afterAll(() => seeder.close());

const boxes = new Map<string, Credential>();
const plugins = loadPlugins({
  sources: [{ mode: "in_process", plugin: createImapSmtpPlugin({ timeoutMs: 10_000, test: { untrustedCerts: true, implicitTlsPort: 3465 } }) }],
  credentials: async (_ws, credentialId) => (credentialId && boxes.get(credentialId)) || null,
  confinement: "none",
  log: () => {},
});
const { clock, ledger } = await testLedger({
  effects: plugins.effects,
  resolvers: { credential: credentialLabel },
  checks: [workspaceLive(), outreachFloors(async () => true, () => clock.at), approverMayApprove(), touchCheck({ effects: plugins.effects, now: () => clock.at }), credentialReady],
  now: () => clock.at,
});
const items = createItems({ ledger, now: () => clock.at });
const outreach = createOutreach({
  items: () => items,
  send: () => ({ id: SEND, dedupe: "queryable", prepare: (ws, input) => plugins.prepare(ws, SEND, input) }),
  baseUrl: () => "https://direx.example",
  ledger: () => ledger,
  now: () => clock.at,
});
const { routes, signIn, createOrg, call } = testIdentity();
const routed = routes as unknown as OpenAPIHono;
routed.route("/", itemRoutes({ items: () => items }));
routed.route("/", outreachRoutes({ outreach: () => outreach }));

const db = await ownerClient();
afterAll(() => db.end());
const q = async (text: string, values: unknown[] = []) => (await db.query(text, values)).rows;
const vault = createVault({ rootKey: rootKeyFromEnv({ DIREX_MASTER_KEY: "11".repeat(32) })!, now: () => clock.at });
const cookie = await signIn();
const owner = ((await (await call("/api/me", cookie)).json()) as { user: { id: string } }).user.id;
const post = async <T>(ws: string, path: string, body: unknown) => {
  const r = await call(`/api/w/${ws}${path}`, cookie, { method: "POST", body });
  return { status: r.status, body: (await r.json()) as T };
};

/** A Workspace in `org` with a Mailbox on GreenMail, ready to send cold email. */
async function sendingWorkspace(name: string, org?: string) {
  const ws = (await createOrg(cookie, name)).workspace.id;
  if (org) await q("update workspaces set org_id = $2 where id = $1", [ws, org]);
  expect((await call(`/api/w/${ws}/outreach/identity`, cookie, { method: "PUT", body: { senderName: "Sam", postalAddress: "1 Main St, Springfield" } })).status).toBe(200);
  const address = `sender-${crypto.randomUUID()}@example.com`;
  await seeder.sendMail({ envelope: { from: "alice@example.com", to: [address] }, raw: `From: seed@example.org\r\nTo: ${address}\r\nSubject: Seed\r\n\r\nSeed` });
  const made = await vault.create({ workspaceId: ws, actorUserId: owner, scope: "workspace", kind: "api_key", key: address, name: "Mailbox", meta: {}, value: { key: "x" } });
  if (!made.ok) throw new Error(made.reason);
  boxes.set(made.credential.id, login(address));
  await passMailboxCheck(ws, made.credential.id);
  return { ws, credentialId: made.credential.id, org: (await q("select org_id from workspaces where id = $1", [ws]))[0]!.org_id as string };
}

/** One approved cold email to a new GreenMail address. */
async function approved(w: { ws: string; credentialId: string }) {
  const to = `p-${crypto.randomUUID()}@example.com`;
  const person = await post<{ id: string }>(w.ws, "/outreach/people", { email: to, country: "US", basis: "published_address", evidence: "their site" });
  const written = await post<{ itemId: string }>(w.ws, "/outreach/emails", { personId: person.body.id, credentialId: w.credentialId, touchClass: "cold", subject: "Hello", text: "Hi there" });
  const { item } = (await (await call(`/api/w/${w.ws}/items/${written.body.itemId}`, cookie)).json()) as { item: { revision: number; actionId: string } };
  expect((await call(`/api/w/${w.ws}/items/${written.body.itemId}/approve`, cookie, { method: "POST", body: { revision: item.revision } })).status).toBe(200);
  const actionId = (await q("select action_id from items where id = $1", [written.body.itemId]))[0]!.action_id as string;
  return { ws: w.ws, actionId, to };
}

async function inbox(address: string): Promise<number> {
  const c = new ImapFlow({ host: HOST, port: 3993, secure: true, auth: { user: address, pass: address }, logger: false, tls: { rejectUnauthorized: false } });
  c.on("error", () => {});
  try {
    await c.connect();
    const s = await c.status("INBOX", { messages: true });
    await c.logout();
    return (s && s.messages) || 0;
  } catch {
    // GreenMail has no mailbox for an address nothing was delivered to.
    return 0;
  }
}

test("an Organization hold stops the run mid-way; lifting it checks everything again and the Person who opted out gets nothing", async () => {
  const a = await sendingWorkspace("Agency A");
  const b = await sendingWorkspace("Agency B", a.org);
  const jobs = [];
  for (let i = 0; i < EMAILS; i++) jobs.push(await approved(i % 2 ? b : a));

  // Two dispatchers, as a deployment runs. The first to see HOLD_AFTER sent sets the hold.
  const queue = [...jobs];
  const sentAt = new Map<string, number>();
  const startedAfterHold = new Set<string>();
  let heldAt: number | null = null;
  const dispatcher = async () => {
    for (let job = queue.shift(); job; job = queue.shift()) {
      if (heldAt !== null) startedAfterHold.add(job.actionId);
      await ledger.run(job.ws, job.actionId);
      if ((await ledger.getAction(job.ws, job.actionId))!.state === "sent") sentAt.set(job.actionId, performance.now());
      if (heldAt === null && sentAt.size >= HOLD_AFTER) {
        await q("select system.set_operator_hold('organization', $1, 'drill', 'cli:drill')", [a.org]);
        heldAt = performance.now();
      }
    }
  };
  await Promise.all([dispatcher(), dispatcher()]);

  // Only a send already under way when the hold committed may finish: one per other dispatcher.
  const sentAfter = [...sentAt].filter(([, at]) => at > heldAt!).map(([id]) => id);
  expect(sentAfter.length).toBeLessThanOrEqual(1);
  expect([...startedAfterHold].filter((id) => sentAt.has(id))).toEqual([]);
  const lastDelivery = Math.max(...sentAt.values());
  expect(lastDelivery - heldAt!).toBeLessThan(60_000);
  const held = jobs.filter((j) => !sentAt.has(j.actionId));
  expect(held.length).toBeGreaterThanOrEqual(EMAILS - HOLD_AFTER - 1);
  for (const j of held) expect(await ledger.getAction(j.ws, j.actionId)).toMatchObject({ state: "held", holdReason: "operator_hold", reasonDetail: "organization" });
  for (const j of jobs) expect(await inbox(j.to)).toBe(sentAt.has(j.actionId) ? 1 : 0);

  // While held, one of the waiting Persons opts out; recording it isn't held.
  const optedOut = held[0]!;
  expect((await post(optedOut.ws, "/outreach/suppressions", { email: optedOut.to })).status).toBe(200);

  await q("select system.lift_operator_hold('organization', $1, 'cli:drill')", [a.org]);
  expect(await ledger.releaseOperatorHolds()).toBe(held.length);
  for (const j of held) await ledger.run(j.ws, j.actionId);
  expect(await ledger.getAction(optedOut.ws, optedOut.actionId)).toMatchObject({ state: "blocked", blockReason: "suppressed" });
  for (const j of held.slice(1)) expect((await ledger.getAction(j.ws, j.actionId))!.state).toBe("sent");
  for (const j of jobs) expect(await inbox(j.to)).toBe(j === optedOut ? 0 : 1);
});
