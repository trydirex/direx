// SPDX-License-Identifier: AGPL-3.0-only
// The whole send path over HTTP, through the real Gmail plugin to a fake Gmail: add a Person, write
// an email, approve it, and see the bytes that went out. Then each floor stopping one.
import { createFakeKit, createGmailPlugin, createKitPlugin } from "@direx/extensions";
import { startFakeGmail } from "@direx/extensions/gmail/fake";
import { OpenAPIHono } from "@hono/zod-openapi";
import { afterAll, expect, test } from "vitest";
import { createVault, credentialLabel, credentialReady, rootKeyFromEnv } from "../credentials/index";
import { approverMayApprove, workspaceLive } from "../identity/index";
import { createItems, itemRoutes } from "../items/index";
import { loadPlugins } from "../plugins/index";
import { directQuery } from "../plugins/fixtures/query";
import { touchCheck } from "../schedule/index";
import { appClient, ownerClient } from "../../../../../test/db";
import { passMailboxCheck, TEST_SECRET, testIdentity, testLedger } from "./fixtures/support";
import { createOutreach, mailFrom, newsletterSync, outreachFloors, outreachRoutes } from "./index";
import { inWorkspace, upsertSubscribers } from "./adapters/repo";
import { REPLY_STOP, TRACKED_PER_RECIPIENT } from "./domain/footer";
import { createTrackingDomains } from "../tracking/index";

process.env.DIREX_AUTH_SECRET = TEST_SECRET;

const SEND = "com.trydirex.gmail/email.send";
const fake = startFakeGmail();
afterAll(() => fake.stop());
const plugins = loadPlugins({
  sources: [{ mode: "in_process", plugin: createGmailPlugin({ baseUrl: fake.url, timeoutMs: 1000 }) }],
  credentials: async () => ({ accessToken: fake.token, expiresAt: "" }),
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
// The address recipients reach Direx at. Public HTTPS unless a test says otherwise.
let base = "https://direx.example";
const outreach = createOutreach({
  items: () => items,
  send: () => ({ id: SEND, dedupe: "queryable", prepare: (ws, input) => plugins.prepare(ws, SEND, input) }),
  baseUrl: () => base,
  ledger: () => ledger,
  now: () => clock.at,
});

const { routes, signIn, createOrg, call } = testIdentity();
const routed = routes as unknown as OpenAPIHono;
routed.route("/", itemRoutes({ items: () => items }));
routed.route("/", outreachRoutes({ outreach: () => outreach }));

const cookie = await signIn();
const W = (await createOrg(cookie, "Acme")).workspace.id;
const post = async <T>(path: string, body: unknown, method = "POST"): Promise<{ status: number; body: T }> => {
  const r = await call(`/api/w/${W}${path}`, cookie, body === undefined ? { method } : { method, body });
  return { status: r.status, body: (await r.json()) as T };
};

const db = await appClient();
afterAll(() => db.end());
async function q(text: string, params: unknown[] = []) {
  await db.query("begin");
  await db.query("select set_config('app.workspace_id', $1, true)", [W]);
  const r = await db.query(text, params);
  await db.query("commit");
  return r.rows;
}
const owner = (await q("select user_id from workspace_members"))[0].user_id as string;
const vault = createVault({ rootKey: rootKeyFromEnv({ DIREX_MASTER_KEY: "11".repeat(32) })!, now: () => clock.at });
const mailbox = await vault.create({ workspaceId: W, actorUserId: owner, scope: "workspace", kind: "api_key", key: "me@acme.test", name: "Mailbox", meta: {}, value: { key: "x" } });
if (!mailbox.ok) throw new Error(mailbox.reason);
const credentialId = mailbox.credential.id;
await passMailboxCheck(W, credentialId);

const email = () => `${crypto.randomUUID()}@example.com`;
const addPerson = async (over: object = {}, to = email()) => {
  const r = await post<{ id: string }>("/outreach/people", { email: to, country: "US", basis: "published_address", evidence: "their site's contact page", ...over });
  expect(r.status).toBe(200);
  return { personId: r.body.id, to };
};
const write = (personId: string, subject = `Hello ${crypto.randomUUID()}`) =>
  post<{ itemId: string; error?: string }>("/outreach/emails", { personId, credentialId, touchClass: "cold", subject, text: "Hi there" });

async function approve(itemId: string) {
  const { item } = (await (await call(`/api/w/${W}/items/${itemId}`, cookie)).json()) as { item: { revision: number } };
  const r = await call(`/api/w/${W}/items/${itemId}/approve`, cookie, { method: "POST", body: { revision: item.revision } });
  expect(r.status).toBe(200);
  return (await q("select action_id from items where id = $1", [itemId]))[0].action_id as string;
}
const stateOf = async (actionId: string) => (await ledger.getAction(W, actionId))!;
/** The message as Gmail received it. */
const message = (i: number) => {
  const raw = Buffer.from(fake.sent[i]!.raw, "base64url").toString();
  const [head, body] = raw.split("\r\n\r\n") as [string, string];
  return { head: head.split("\r\n"), text: Buffer.from(body, "base64").toString() };
};
const header = (i: number, name: string) => message(i).head.find((l) => l.startsWith(`${name}: `))?.slice(name.length + 2);

test("an email shows the Mailbox it goes from, by the name Direx knows it under", async () => {
  expect(await mailFrom(W, credentialId)).toEqual({ kind: "email", from: "Mailbox" });
});

test("before a sender and address are saved, no email can be written", async () => {
  const { personId } = await addPerson();
  expect(await write(personId)).toMatchObject({ status: 409, body: { error: "sender_identity_missing" } });
  expect((await post("/outreach/identity", { senderName: "Sam at Acme", postalAddress: "1 Main St, Springfield" }, "PUT")).status).toBe(200);
});

test("without a public HTTPS address, the email asks for a stop reply and carries no unsubscribe link or header", async () => {
  base = "http://localhost:3000";
  try {
    const { personId } = await addPerson();
    const w = await write(personId, "No link here");
    const before = fake.sent.length;
    await ledger.run(W, await approve(w.body.itemId));
    expect(fake.sent).toHaveLength(before + 1);
    const { text } = message(before);
    expect(text).toContain(`Sam at Acme\n1 Main St, Springfield\n${REPLY_STOP}`);
    expect(text).not.toContain("Unsubscribe:");
    expect(header(before, "List-Unsubscribe")).toBeUndefined();
    expect(header(before, "List-Unsubscribe-Post")).toBeUndefined();
  } finally {
    base = "https://direx.example";
  }
});

test("add, write, approve: one message goes out with the footer and the one-click unsubscribe", async () => {
  const { personId, to } = await addPerson();
  const w = await write(personId, "Quick question");
  expect(w.status).toBe(200);
  const before = fake.sent.length;
  const actionId = await approve(w.body.itemId);
  await ledger.run(W, actionId);
  expect(await stateOf(actionId)).toMatchObject({ state: "sent" });
  expect(fake.sent).toHaveLength(before + 1);
  const url = header(before, "List-Unsubscribe")!.slice(1, -1);
  expect(url).toMatch(new RegExp(`^https://direx.example/api/unsubscribe/${W}/[0-9a-f]{64}$`));
  expect(header(before, "List-Unsubscribe-Post")).toBe("List-Unsubscribe=One-Click");
  expect(header(before, "To")).toBe(to);
  const { text } = message(before);
  expect(text).toContain("Sam at Acme\n1 Main St, Springfield");
  expect(text).toContain(`${REPLY_STOP}\nUnsubscribe: ${url}`);

  // A scanner following the link changes nothing; the POST does, and only with the real token.
  const path = new URL(url).pathname;
  expect((await routed.request(path)).status).toBe(200);
  expect((await post<{ people: { id: string; suppressed: boolean }[] }>("/outreach", undefined, "GET")).body.people.find((p) => p.id === personId)?.suppressed).toBe(false);
  expect((await routed.request(path.replace(/.{4}$/, "0000"), { method: "POST" })).status).toBe(404);
  expect((await routed.request(path, { method: "POST" })).status).toBe(200);
  expect((await post<{ people: { id: string; suppressed: boolean }[] }>("/outreach", undefined, "GET")).body.people.find((p) => p.id === personId)?.suppressed).toBe(true);
});

type Row = { id: string; name: string | null; company: string | null; campaign: unknown; lastEmailAt: string | null; replied: boolean };
const rowOf = async (personId: string) => (await post<{ people: Row[] }>("/outreach", undefined, "GET")).body.people.find((p) => p.id === personId)!;

test("each Person's row says when Direx last emailed them and whether they replied", async () => {
  const { personId, to } = await addPerson();
  expect(await rowOf(personId)).toMatchObject({ name: null, company: null, campaign: null, lastEmailAt: null, replied: false });
  const actionId = await approve((await write(personId)).body.itemId);
  await ledger.run(W, actionId);
  expect((await rowOf(personId)).lastEmailAt).toBe((await stateOf(actionId)).firstDispatchedAt!.toISOString());
  await q("insert into reply_signals (workspace_id, event_id, sender_email, person_id, kind, status, received_at) values ($1, $2, $3, $4, 'reply', 'not_opt_out', now())", [W, crypto.randomUUID(), to, personId]);
  expect((await rowOf(personId)).replied).toBe(true);
});

test("an opt-out after approval blocks the send, and only for that Person's group", async () => {
  const a = await addPerson();
  const b = await addPerson();
  const [wa, wb] = [await write(a.personId), await write(b.personId)];
  const [ia, ib] = [await approve(wa.body.itemId), await approve(wb.body.itemId)];
  await post("/outreach/suppressions", { email: a.to.toUpperCase() });
  const before = fake.sent.length;
  await ledger.run(W, ia);
  await ledger.run(W, ib);
  expect(await stateOf(ia)).toMatchObject({ state: "blocked", blockReason: "suppressed" });
  expect(await stateOf(ib)).toMatchObject({ state: "sent" });
  expect(fake.sent).toHaveLength(before + 1);
});

const list = await vault.create({ workspaceId: W, actorUserId: owner, scope: "workspace", kind: "api_key", key: "api_key:kit", name: "Kit", meta: {}, value: { key: "x" } });
if (!list.ok) throw new Error(list.reason);
const onList = (to: string) => inWorkspace(W, (tx) => upsertSubscribers(tx, W, list.credential.id, [{ email: to, state: "subscribed" }], clock.at));
const warningsOf = async (itemId: string) => ((await (await call(`/api/w/${W}/items/${itemId}`, cookie)).json()) as { item: { warnings: { code: string; text: string }[] } }).item.warnings;

test("a cold email to a newsletter subscriber says so, and sends once a person approves it", async () => {
  const { personId, to } = await addPerson();
  await onList(to.toUpperCase());
  const listed = (await post<{ people: { id: string; newsletterSince: string | null }[] }>("/outreach", undefined, "GET")).body.people;
  expect(listed.find((p) => p.id === personId)?.newsletterSince).toBe(clock.at.toISOString());
  const w = await write(personId);
  expect((await warningsOf(w.body.itemId))).toContainEqual({ code: "newsletter_subscriber", text: `${to} is a newsletter subscriber. Send this cold email anyway?` });
  const actionId = await approve(w.body.itemId);
  expect(((await stateOf(actionId)).spec as { touch: object }).touch).toEqual({ personId, touchClass: "cold", newsletterSubscriber: true });
  const before = fake.sent.length;
  await ledger.run(W, actionId);
  expect(await stateOf(actionId)).toMatchObject({ state: "sent" });
  expect(fake.sent).toHaveLength(before + 1);
});

test("a cold email approved before the person joined the list waits for a person", async () => {
  const { personId, to } = await addPerson();
  const w = await write(personId);
  expect((await warningsOf(w.body.itemId)).map((x) => x.code)).not.toContain("newsletter_subscriber");
  const actionId = await approve(w.body.itemId);
  await onList(to);
  const before = fake.sent.length;
  await ledger.run(W, actionId);
  expect(await stateOf(actionId)).toMatchObject({ state: "held", holdReason: "newsletter_subscriber" });
  expect(fake.sent).toHaveLength(before);

  // It goes back to a person: the same message, word for word and link for link, now saying who it reaches.
  const approved = (await stateOf(actionId)).spec as { touch: object } & Record<string, unknown>;
  expect(await outreach.askAgainForSubscribers(W)).toBe(1);
  const asked = await stateOf(actionId);
  expect(asked.state).toBe("needs_approval");
  const { touch, ...message } = asked.spec as { touch: object } & Record<string, unknown>;
  const { touch: oldTouch, ...oldMessage } = approved;
  expect(message).toEqual(oldMessage);
  expect(touch).toEqual({ ...oldTouch, newsletterSubscriber: true });
  expect(await warningsOf(w.body.itemId)).toContainEqual({ code: "newsletter_subscriber", text: `${to} is a newsletter subscriber. Send this cold email anyway?` });
  expect(await outreach.askAgainForSubscribers(W)).toBe(0);

  // Sent only after a second yes.
  await approve(w.body.itemId);
  await ledger.run(W, actionId);
  expect(await stateOf(actionId)).toMatchObject({ state: "sent" });
  expect(fake.sent).toHaveLength(before + 1);
});

test("end to end with the fake Kit: read the list, warn, send on a yes, hold a late subscriber and ask again", async () => {
  const early = await addPerson();
  const late = await addPerson();
  const fan = await addPerson({ basis: "consent" });
  const kit = createFakeKit({ subscribers: [early.to, fan.to].map((e) => ({ email: e, state: "active", createdAt: "2026-11-01T00:00:00Z" })) });
  const plugin = createKitPlugin({ fetch: kit.fetch });
  const sync = newsletterSync({
    query: directQuery(plugin, () => ({ key: kit.key })),
    now: () => clock.at,
    sleep: async () => {},
  });
  const read = () => sync(W, list.credential.id, "com.trydirex.kit/newsletter.subscribers");

  // An email to the late subscriber is approved before they join.
  const lateDraft = await write(late.personId);
  const lateAction = await approve(lateDraft.body.itemId);

  // The list is read, as on connect.
  expect(await read()).toMatchObject({ kind: "done", addresses: 2 });

  // A cold draft to someone on the list warns, and sends once approved.
  const earlyDraft = await write(early.personId);
  expect((await warningsOf(earlyDraft.body.itemId)).map((x) => x.code)).toContain("newsletter_subscriber");
  const earlyAction = await approve(earlyDraft.body.itemId);
  const before = fake.sent.length;
  await ledger.run(W, earlyAction);
  expect(await stateOf(earlyAction)).toMatchObject({ state: "sent" });

  // The late subscriber joins; the next read finds them, their approved email waits and asks again.
  kit.subscribers.push({ email: late.to, state: "active", createdAt: "2026-11-04T00:00:00Z" });
  await read();
  await ledger.run(W, lateAction);
  expect(await stateOf(lateAction)).toMatchObject({ state: "held", holdReason: "newsletter_subscriber" });
  expect(await outreach.askAgainForSubscribers(W)).toBe(1);
  expect(await stateOf(lateAction)).toMatchObject({ state: "needs_approval" });
  await approve(lateDraft.body.itemId);
  await ledger.run(W, lateAction);
  expect(await stateOf(lateAction)).toMatchObject({ state: "sent" });

  // Consented marketing to a subscriber goes as approved, with no warning.
  const news = await post<{ itemId: string }>("/outreach/emails", { personId: fan.personId, credentialId, touchClass: "consented_marketing", subject: `News ${crypto.randomUUID()}`, text: "Hi there" });
  expect((await warningsOf(news.body.itemId)).map((x) => x.code)).not.toContain("newsletter_subscriber");
  const newsAction = await approve(news.body.itemId);
  await ledger.run(W, newsAction);
  expect((await stateOf(newsAction)).holdReason).not.toBe("newsletter_subscriber");
  expect(fake.sent.length).toBeGreaterThanOrEqual(before + 2);
});

test("consented marketing to a subscriber is never held for being on the list", async () => {
  const { personId, to } = await addPerson({ basis: "consent" });
  await onList(to);
  const w = await post<{ itemId: string }>("/outreach/emails", { personId, credentialId, touchClass: "consented_marketing", subject: `News ${crypto.randomUUID()}`, text: "Hi there" });
  expect((await warningsOf(w.body.itemId)).map((x) => x.code)).not.toContain("newsletter_subscriber");
  const actionId = await approve(w.body.itemId);
  await ledger.run(W, actionId);
  expect((await stateOf(actionId)).holdReason).not.toBe("newsletter_subscriber");
});

test("the emergency pause holds every send at once; lifting it lets a resume through", async () => {
  const { personId } = await addPerson();
  const actionId = await approve((await write(personId)).body.itemId);
  await post("/outreach/pause", { paused: true }, "PUT");
  const before = fake.sent.length;
  await ledger.run(W, actionId);
  expect(await stateOf(actionId)).toMatchObject({ state: "held", holdReason: "workspace_paused" });
  await post("/outreach/pause", { paused: false }, "PUT");
  await ledger.resume(W, actionId, { system: "test" });
  await ledger.run(W, actionId);
  expect(await stateOf(actionId)).toMatchObject({ state: "sent" });
  expect(fake.sent).toHaveLength(before + 1);
});

test("no country is refused: an approved email to Germany sends, and an opt-out there still stops one", async () => {
  const { personId } = await addPerson({ country: "DE", basis: "consent" });
  const actionId = await approve((await write(personId)).body.itemId);
  await ledger.run(W, actionId);
  expect(await stateOf(actionId)).toMatchObject({ state: "sent" });

  const other = await addPerson({ country: "DE", basis: "consent" });
  const next = await approve((await write(other.personId)).body.itemId);
  await post("/outreach/suppressions", { email: other.to });
  await ledger.run(W, next);
  expect(await stateOf(next)).toMatchObject({ state: "blocked" });
});

test("nothing goes out for a deleted Workspace", async () => {
  const { personId } = await addPerson();
  const actionId = await approve((await write(personId)).body.itemId);
  await q("select system.soft_delete_workspace($1, $2)", [W, owner]);
  const before = fake.sent.length;
  await ledger.run(W, actionId);
  // No product path undoes a delete; the owner role does, so the tests after this one keep W.
  const undo = await ownerClient();
  await undo.query("update workspaces set deleted_at = null where id = $1", [W]);
  await undo.end();
  expect(await stateOf(actionId)).toMatchObject({ state: "blocked", blockReason: "workspace_deleted" });
  expect(fake.sent).toHaveLength(before);
});

test("the same request twice gives one draft, and a link in another Workspace's path is refused", async () => {
  const { personId } = await addPerson();
  const first = await write(personId, "Once");
  expect((await write(personId, "Once")).body.itemId).toBe(first.body.itemId);
  const token = "a".repeat(64);
  expect((await routed.request(`/api/unsubscribe/not-a-uuid/${token}`, { method: "POST" })).status).toBe(404);
  expect((await routed.request(`/api/unsubscribe/${crypto.randomUUID()}/${token}`, { method: "POST" })).status).toBe(404);
});

const composed = (personId: string, over: object = {}) => ({ personId, credentialId, touchClass: "cold" as const, subject: "Step", text: "Same words", ...over });
const itemOf = <T extends { ok: boolean }>(r: T) => {
  if (!r.ok) throw new Error(JSON.stringify(r));
  return (r as unknown as { item: { id: string; revision: number; warnings: { code: string; text: string }[]; groupKey: string | null } }).item;
};

test("a caller's key makes one Action even when the text differs, and two keys make two with the same text", async () => {
  const { personId } = await addPerson();
  const first = itemOf(await outreach.compose(W, composed(personId, { idempotencyKey: `k1:${personId}` }), owner));
  const edited = itemOf(await outreach.compose(W, composed(personId, { idempotencyKey: `k1:${personId}`, text: "Other words" }), owner));
  const other = itemOf(await outreach.compose(W, composed(personId, { idempotencyKey: `k2:${personId}` }), owner));
  expect(edited.id).toBe(first.id);
  expect(other.id).not.toBe(first.id);
});

test("the same email again writes no second unsubscribe token", async () => {
  const { personId, to } = await addPerson();
  const once = itemOf(await outreach.compose(W, composed(personId, { idempotencyKey: `t:${personId}` }), owner));
  const again = itemOf(await outreach.compose(W, composed(personId, { idempotencyKey: `t:${personId}` }), owner));
  expect(again.id).toBe(once.id);
  expect(await q("select count(*)::int as n from unsubscribe_tokens where email = $1", [to])).toEqual([{ n: 1 }]);
});

test("warnings and a group carry onto the Item", async () => {
  const { personId } = await addPerson();
  const item = itemOf(await outreach.compose(W, composed(personId, { groupKey: "c:first", groupLabel: "First email", warnings: [{ code: "untrusted_source", text: "untrusted_input" }] }), owner));
  expect(item).toMatchObject({ groupKey: "c:first", warnings: [{ code: "untrusted_source", text: "untrusted_input" }] });
});

test("revising keeps the Action, the footer and the one-click header, and voids an approval", async () => {
  const { personId } = await addPerson();
  const item = itemOf(await outreach.compose(W, composed(personId), owner));
  const actionId = await approve(item.id);

  const revised = await outreach.revise(W, item.id, composed(personId, { text: "New words" }), owner);
  expect(revised.ok).toBe(true);
  expect((await q("select action_id from items where id = $1", [item.id]))[0].action_id).toBe(actionId);

  const before = fake.sent.length;
  await ledger.run(W, actionId);
  expect(fake.sent).toHaveLength(before);

  await approve(item.id);
  await ledger.run(W, actionId);
  expect(fake.sent).toHaveLength(before + 1);
  expect(message(before).text).toContain("New words");
  expect(message(before).text).not.toContain("Same words");
  expect(message(before).text).toContain("Unsubscribe: https://direx.example/api/unsubscribe/");
  expect(header(before, "List-Unsubscribe-Post")).toBe("List-Unsubscribe=One-Click");
});

test("a tracking Campaign's email carries its links on the tracking domain, says a US Person's are tracked, and records each use", async () => {
  const hostname = `links${crypto.randomUUID().slice(0, 8)}.example.com`;
  let txt = "";
  const domains = createTrackingDomains({ dns: { records: async () => ({ cname: ["t.direx.example"], txt: [txt] }), handshake: async () => true }, target: () => "t.direx.example" });
  const d = await domains.add(W, owner, hostname);
  if (typeof d === "string") throw new Error(d);
  txt = d.txtValue;
  await domains.check(W, d.id);
  const [plan] = await q("insert into marketing_plans (workspace_id, title, created_at, updated_at) values ($1, 't', now(), now()) returning id", [W]);
  const [campaign] = await q(
    `insert into campaigns (workspace_id, plan_id, owner_user_id, tracking_domain_id, tracking_on, tracking_set_by, tracking_wording_version, per_person_on, per_person_set_by, per_person_wording_version, created_at, updated_at)
     values ($1, $2, $3, $4, true, $3, 1, true, $3, 1, now(), now()) returning id`,
    [W, plan.id, owner, d.id],
  );
  const tracking = { campaignId: campaign.id as string, stepKey: "s1" };
  const { personId } = await addPerson();
  const item = itemOf(await outreach.compose(W, composed(personId, { text: "See https://acme.example/a", tracking }), owner));
  const uses = () => q("select l.destination, u.token_hash, u.person_id from tracked_link_uses u join tracked_links l on l.id = u.link_id join items i on i.action_id = u.action_id where i.id = $1 order by l.destination", [item.id]);
  const used = (destination: string) => ({ destination, token_hash: expect.stringMatching(/^[0-9a-f]{64}$/), person_id: personId });
  expect(await uses()).toEqual([used("https://acme.example/a")]);

  // A revise records the new text's links; the old use stays, as uses are never deleted.
  expect((await outreach.revise(W, item.id, composed(personId, { text: "Now https://acme.example/b", tracking }), owner)).ok).toBe(true);
  expect(await uses()).toEqual([used("https://acme.example/a"), used("https://acme.example/b")]);

  const before = fake.sent.length;
  await ledger.run(W, await approve(item.id));
  const { text } = message(before);
  expect(text).toMatch(new RegExp(`^Now https://${hostname.replaceAll(".", "\\.")}/t/[A-Za-z0-9_-]{22}/[A-Za-z0-9_-]{43}\\n`));
  expect(text).not.toContain("acme.example");
  expect(text).toContain(`\n${TRACKED_PER_RECIPIENT}\n${REPLY_STOP}\nUnsubscribe: https://direx.example/api/unsubscribe/`);
});

test("revising a sent email is refused and nothing changes", async () => {
  const { personId } = await addPerson();
  const item = itemOf(await outreach.compose(W, composed(personId), owner));
  const actionId = await approve(item.id);
  await ledger.run(W, actionId);
  expect((await outreach.revise(W, item.id, composed(personId, { text: "Too late" }), owner)).ok).toBe(false);
  expect(await stateOf(actionId)).toMatchObject({ state: "sent" });
});

const day = (offset: number) => new Date(clock.at.getTime() + offset * 86_400_000).toISOString().slice(0, 10);

test("a basis past its expiry holds the send, and a new record lets it go after every check runs again", async () => {
  const to = email();
  const { personId } = await addPerson({ basis: "consent", expiresAt: day(-1) }, to);
  const actionId = await approve((await write(personId)).body.itemId);
  const before = fake.sent.length;
  await ledger.run(W, actionId);
  expect(await stateOf(actionId)).toMatchObject({ state: "held", holdReason: "not_eligible", reasonDetail: `basis expired on ${day(-1)}` });

  // A record that is still expired is resumed, checked again and held again.
  await addPerson({ basis: "consent", expiresAt: day(-2) }, to);
  await ledger.run(W, actionId);
  expect(await stateOf(actionId)).toMatchObject({ state: "held", holdReason: "not_eligible", reasonDetail: `basis expired on ${day(-2)}` });

  await addPerson({ basis: "consent", expiresAt: day(30) }, to);
  await ledger.run(W, actionId);
  expect(await stateOf(actionId)).toMatchObject({ state: "sent" });
  expect(fake.sent).toHaveLength(before + 1);
});

test("a Person held for having no basis is resumed once one is recorded, and nobody else is", async () => {
  const to = email();
  const made = await outreach.ensurePerson(W, to);
  if (!made.ok) throw new Error(made.reason);
  const other = await outreach.ensurePerson(W, email());
  if (!other.ok) throw new Error(other.reason);
  const [mine, theirs] = [await approve((await write(made.id)).body.itemId), await approve((await write(other.id)).body.itemId)];
  await ledger.run(W, mine);
  await ledger.run(W, theirs);
  expect(await stateOf(mine)).toMatchObject({ state: "held", holdReason: "not_eligible", reasonDetail: "no basis recorded" });

  await addPerson({}, to);
  await ledger.run(W, mine);
  await ledger.run(W, theirs);
  expect(await stateOf(mine)).toMatchObject({ state: "sent" });
  expect(await stateOf(theirs)).toMatchObject({ state: "held", holdReason: "not_eligible" });
});

test("the record's new fields are saved and come back with what the country research suggests", async () => {
  expect((await post("/outreach/identity", { senderName: "Sam at Acme", postalAddress: "1 Main St, Springfield", senderCountry: "US" }, "PUT")).status).toBe(200);
  const { personId } = await addPerson({ country: "GB", entityType: "sole_trader", scope: "Product updates", expiresAt: day(90) });
  const record = await post<Record<string, unknown>>(`/outreach/people/${personId}`, undefined, "GET");
  expect(record).toMatchObject({
    status: 200,
    body: { country: "GB", entityType: "sole_trader", scope: "Product updates", confidence: "stated", warnings: ["entity_needs_consent"], expiresAt: `${day(90)}T00:00:00.000Z` },
  });
  const overview = await post<{ senderCountry: string; people: { id: string; warnings: string[] }[] }>("/outreach", undefined, "GET");
  expect(overview.body.senderCountry).toBe("US");
  expect(overview.body.people.find((p) => p.id === personId)?.warnings).toEqual(["entity_needs_consent"]);

  expect((await addPersonRaw({ entityType: "sole" })).status).toBe(400);
  expect((await addPersonRaw({ expiresAt: "2026-13-01" })).status).toBe(400);
  expect((await post(`/outreach/people/${crypto.randomUUID()}`, undefined, "GET")).status).toBe(404);
});

test("adding an email that is already a Person replaces its record and says it was updated", async () => {
  const to = email();
  const first = await post<{ id: string; updated: boolean }>("/outreach/people", { email: to, country: "US", basis: "published_address", evidence: "site" });
  expect(first.body.updated).toBe(false);
  const again = await post<{ id: string; updated: boolean }>("/outreach/people", { email: to.toUpperCase(), country: "GB", basis: "consent", evidence: "form" });
  expect(again.body).toEqual({ id: first.body.id, updated: true });
  expect((await post<{ country: string }>(`/outreach/people/${first.body.id}`, undefined, "GET")).body.country).toBe("GB");
});

const addPersonRaw = (over: object) => post("/outreach/people", { email: email(), country: "US", basis: "published_address", evidence: "site", ...over });

// A Mailbox whose provider hasn't shown it delivers the opt-out unchanged sends no cold mail.
const otherMailbox = async () => {
  const r = await vault.create({ workspaceId: W, actorUserId: owner, scope: "workspace", kind: "api_key", key: `${crypto.randomUUID().slice(0, 8)}@acme.test`, name: "Other", meta: {}, value: { key: "x" } });
  if (!r.ok) throw new Error(r.reason);
  return r.credential.id;
};
const writeFrom = (personId: string, from: string) => post<{ itemId: string; error?: string }>("/outreach/emails", { personId, credentialId: from, touchClass: "cold", subject: `Hello ${crypto.randomUUID()}`, text: "Hi there" });
const recordCheck = (credentialId: string, state: "replies_only" | "pending") =>
  q("insert into mailbox_header_checks (workspace_id, credential_id, settings_hash, state, created_at) values ($1, $2, $3, $4, now())", [W, credentialId, "whatever", state]);

test("cold mail from a Mailbox never checked is held, and goes once its check passes and every check runs again", async () => {
  const from = await otherMailbox();
  const { personId } = await addPerson();
  const w = await writeFrom(personId, from);
  expect(w.status).toBe(200);
  const actionId = await approve(w.body.itemId);
  const before = fake.sent.length;
  await ledger.run(W, actionId);
  expect(await stateOf(actionId)).toMatchObject({ state: "held", holdReason: "mailbox_unchecked" });
  expect(fake.sent).toHaveLength(before);

  await passMailboxCheck(W, from);
  expect(await ledger.resumeHeldBy(W, "mailbox_unchecked", { system: "outreach" }, async (_tx, held) => held.credentialId === from)).toBe(1);
  await ledger.run(W, actionId);
  expect(await stateOf(actionId)).toMatchObject({ state: "sent" });
});

test("a check passed for other settings doesn't count, and a pending one holds too", async () => {
  const from = await otherMailbox();
  await recordCheck(from, "pending");
  const { personId } = await addPerson();
  const actionId = await approve((await writeFrom(personId, from)).body.itemId);
  await ledger.run(W, actionId);
  expect(await stateOf(actionId)).toMatchObject({ state: "held", holdReason: "mailbox_unchecked" });
});

test("a replies-only Mailbox can't write cold mail, and what was already approved from it is held", async () => {
  const from = await otherMailbox();
  const { personId } = await addPerson();
  const actionId = await approve((await writeFrom(personId, from)).body.itemId);
  await passMailboxCheck(W, from);
  await q("update mailbox_header_checks set state = 'replies_only' where credential_id = $1", [from]);
  expect(await writeFrom(personId, from)).toMatchObject({ status: 409, body: { error: "mailbox_replies_only" } });
  await ledger.run(W, actionId);
  expect(await stateOf(actionId)).toMatchObject({ state: "held", holdReason: "mailbox_replies_only" });
});
