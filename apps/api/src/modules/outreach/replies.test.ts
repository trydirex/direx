// SPDX-License-Identifier: AGPL-3.0-only
// Mail arriving, end to end: a real poll through the real Gmail plugin against a fake Gmail, into the
// floors a send has to pass.
import { createGmailPlugin } from "@direx/extensions";
import { startFakeGmail } from "@direx/extensions/gmail/fake";
import { OpenAPIHono } from "@hono/zod-openapi";
import { afterAll, expect, test } from "vitest";
import { appClient } from "../../../../../test/db";
import { createBoss } from "../../jobs/boss";
import { createVault, credentialLabel, credentialReady, rootKeyFromEnv } from "../credentials/index";
import { approverMayApprove, workspaceLive } from "../identity/index";
import { createItems, itemRoutes } from "../items/index";
import { approverIdFromSession } from "../ledger/index";
import { addKey } from "../people/index";
import { CallFailed, EMAIL_RECEIVED, loadPlugins, receivedMail } from "../plugins/index";
import { touchCheck } from "../schedule/index";
import { setPause, clearPause, pauseOf } from "./adapters/pauses";
import { inWorkspace } from "./adapters/repo";
import { mailMembers, replyOwner } from "./application/reply-desk";
import { resultLines } from "./application/results";
import { passMailboxCheck, TEST_SECRET, testIdentity, testLedger } from "./fixtures/support";
import { clearOldReplyText, connectedMailboxes, createMailboxPauses, createOutreach, createReplies, createReplyDesk, mailboxNeedsReconnect, optOutReviewKind, outreachFloors, outreachRoutes, replyDeskKind, sendingPaused } from "./index";

process.env.DIREX_AUTH_SECRET = TEST_SECRET;

let repliesBeingRead = true;
const SEND = "com.trydirex.gmail/email.send";
const PLUGIN = "com.trydirex.gmail";
const fake = startFakeGmail();
const boss = createBoss();
await boss.start();
afterAll(async () => {
  fake.stop();
  await boss.stop({ graceful: false, close: true });
});

let searchFails = false;
// A Mailbox in the Workspace couldn't be searched, such as one that needs reconnecting.
let searchIncomplete = false;
// The opt-out model, scripted. It refuses unless a test says otherwise, so a reply the rules leave goes to a person.
let modelSays: { answer: string; quote?: string | null } | "refuse" = "refuse";
// The reply desk's label, scripted the same way.
let labelSays: { label: string; quote: string } | "refuse" = "refuse";
// What the reply desk's owner alerts would send, and whether sending one fails.
const alerts: { userIds: string[]; subject: string; text: string }[] = [];
let alertFails = false;
const modelCalls: string[] = [];
const fakeGenerate = (async (req: { purpose: string; parts: { kind: string; text: string }[] }) => {
  modelCalls.push(`${req.purpose}:${req.parts.map((p) => p.kind).join(",")}`);
  if (req.purpose === "reply_label") return labelSays === "refuse" ? { ok: false, callId: null, refusal: "no_route" } : { ok: true, callId: crypto.randomUUID(), trust: "untrusted", output: labelSays, toolCalls: [], routeHash: "r" };
  return modelSays === "refuse" ? { ok: false, callId: null, refusal: "no_route" } : { ok: true, callId: crypto.randomUUID(), trust: "untrusted", output: modelSays, toolCalls: [], routeHash: "r" };
}) as never;
const replies: ReturnType<typeof createReplies> = createReplies({
  boss,
  items: () => items,
  ledger: () => ledger,
  now: () => clock.at,
  generate: () => fakeGenerate,
  searchMailboxes: async (workspaceId, email) => {
    if (searchFails) throw new Error("the provider is down");
    const { events } = await plugins.query(workspaceId, "com.trydirex.gmail/mail.from", { email }, credentialId);
    return { events: receivedMail(events).map((e) => ({ ...e, workspaceId, credentialId })), complete: !searchIncomplete };
  },
  desk: createReplyDesk({
    items: () => items,
    generate: () => fakeGenerate,
    notify: async (_w, userIds, mail) => {
      if (alertFails) throw new Error("smtp down");
      alerts.push({ userIds, ...mail });
    },
  }),
});
await replies.ensureQueue();
await boss.createQueue("plugins.poll");
const plugins = loadPlugins({
  sources: [{ mode: "in_process", plugin: createGmailPlugin({ baseUrl: fake.url, timeoutMs: 1000 }) }],
  credentials: async () => ({ accessToken: fake.token, expiresAt: "" }),
  confinement: "none",
  log: () => {},
  boss,
  onEvent: async (tx, e) => {
    if (!e.custom && e.trigger === EMAIL_RECEIVED) await replies.intake(tx, e);
  },
});
const { clock, ledger } = await testLedger({
  effects: plugins.effects,
  resolvers: { credential: credentialLabel },
  checks: [workspaceLive(), outreachFloors(async () => repliesBeingRead), approverMayApprove(), touchCheck({ effects: plugins.effects, now: () => clock.at }), credentialReady],
  now: () => clock.at,
});
const items = createItems({ ledger, kinds: { ...optOutReviewKind({ boss, now: () => clock.at }), ...replyDeskKind() }, now: () => clock.at });
const outreach = createOutreach({
  items: () => items,
  send: () => ({ id: SEND, dedupe: "queryable", prepare: (ws, input) => plugins.prepare(ws, SEND, input) }),
  baseUrl: () => "http://direx.test",
  now: () => clock.at,
  generate: () => fakeGenerate,
});

const { routes, signIn, createOrg, call, addMember } = testIdentity();
const routed = routes as unknown as OpenAPIHono;
routed.route("/", itemRoutes({ items: () => items }));
routed.route("/", outreachRoutes({ outreach: () => outreach, pauses: () => createMailboxPauses({ ledger: () => ledger, now: () => clock.at }) }));

const cookie = await signIn();
const W = (await createOrg(cookie, "Acme")).workspace.id;
const post = async <T>(path: string, body: unknown, method = "POST"): Promise<{ status: number; body: T }> => {
  const r = await call(`/api/w/${W}${path}`, cookie, { method, body });
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
await post("/outreach/identity", { senderName: "Sam at Acme", postalAddress: "1 Main St, Springfield" }, "PUT");

const poll = async () => expect(await plugins.runPoll({ workspaceId: W, pluginId: PLUGIN, trigger: "email.received", credentialId })).toBe("handed_off");
const newEmail = () => `${crypto.randomUUID()}@example.com`;
const addPerson = async (to = newEmail()) => {
  const r = await post<{ id: string }>("/outreach/people", { email: to, country: "US", basis: "published_address", evidence: "their site" });
  expect(r.status).toBe(200);
  return { personId: r.body.id, to };
};
async function approved(personId: string) {
  const w = await post<{ itemId: string }>("/outreach/emails", { personId, credentialId, touchClass: "cold", subject: `Hello ${crypto.randomUUID()}`, text: "Hi there" });
  expect(w.status).toBe(200);
  const { item } = (await (await call(`/api/w/${W}/items/${w.body.itemId}`, cookie)).json()) as { item: { revision: number } };
  expect((await call(`/api/w/${W}/items/${w.body.itemId}/approve`, cookie, { method: "POST", body: { revision: item.revision } })).status).toBe(200);
  return (await q("select action_id from items where id = $1", [w.body.itemId]))[0].action_id as string;
}
const stateOf = async (id: string) => (await ledger.getAction(W, id))!;
const signals = (sender: string) => q("select * from reply_signals where sender_email = $1", [sender]);
const suppressed = async (email: string) => (await q("select reason from suppressions where email = $1", [email]))[0]?.reason as string | undefined;
const reviewOf = async (signalId: string) => (await q("select id from items where kind = 'opt_out_review' and payload->>'signalId' = $1", [signalId]))[0]?.id as string;
async function choose(itemId: string, choice: string) {
  const { item } = (await (await call(`/api/w/${W}/items/${itemId}`, cookie)).json()) as { item: { revision: number } };
  return call(`/api/w/${W}/items/${itemId}/approve`, cookie, { method: "POST", body: { revision: item.revision, choice } });
}
const FOOTER = "> --\n> Sam at Acme\n> 1 Main St, Springfield\n> Unsubscribe: http://direx.test/api/unsubscribe/w/abc";

test("mail from a stranger outside our threads leaves nothing behind", async () => {
  const stranger = newEmail();
  fake.deliver({ from: stranger, subject: "Buy my thing", text: "Please remove me from your thing" });
  await poll();
  expect(await signals(stranger)).toEqual([]);
  expect(await suppressed(stranger)).toBeUndefined();
});

test("a Person asking to stop is suppressed at once, and their approved send is blocked with no provider call", async () => {
  const { personId, to } = await addPerson();
  const actionId = await approved(personId);
  fake.deliver({ from: `Kim <${to}>`, subject: "Re: Hello", text: "Please remove me" });
  await poll();
  const [signal] = await signals(to);
  expect(signal).toMatchObject({ status: "opted_out", decided_by: "rule", quote: "Please remove me", text: null });
  expect(await suppressed(to)).toBe("reply");
  const before = fake.sent.length;
  await ledger.run(W, actionId);
  expect(await stateOf(actionId)).toMatchObject({ state: "blocked", blockReason: "suppressed" });
  expect(fake.sent).toHaveLength(before);
});

test("a friendly reply over our quoted footer isn't an opt-out", async () => {
  const { to } = await addPerson();
  fake.deliver({ from: to, subject: "Re: Hello", text: `Sounds great\n\nOn Mon, Sam wrote:\n${FOOTER}` });
  await poll();
  expect(await suppressed(to)).toBeUndefined();
  expect((await signals(to))[0]).toMatchObject({ status: "pending", text: "Sounds great" });
});

test("an out-of-office isn't an opt-out and holds nothing", async () => {
  const { personId, to } = await addPerson();
  fake.deliver({ from: to, subject: "Away", text: "I'm away, please remove me from your thoughts", headers: { "Auto-Submitted": "auto-replied" } });
  await poll();
  expect((await signals(to))[0]).toMatchObject({ status: "not_opt_out", decided_by: "rule", text: null });
  expect(await suppressed(to)).toBeUndefined();
  const actionId = await approved(personId);
  await ledger.run(W, actionId);
  expect(await stateOf(actionId)).toMatchObject({ state: "sent" });
});

test("a reply nothing can settle holds that Person's sends until a person says it's fine, and every check runs again", async () => {
  const { personId, to } = await addPerson();
  const other = await addPerson();
  const held = await approved(personId);
  const free = await approved(other.personId);
  fake.deliver({ from: to, subject: "Re: Hello", text: "Who gave you my address?" });
  await poll();
  const [signal] = await signals(to);
  await ledger.run(W, held);
  await ledger.run(W, free);
  expect(await stateOf(held)).toMatchObject({ state: "held", holdReason: "reply_unread" });
  expect(await stateOf(free)).toMatchObject({ state: "sent" });

  await replies.decide(W, signal.id);
  expect((await signals(to))[0]).toMatchObject({ status: "needs_person" });
  await replies.decide(W, signal.id);
  expect(await stateOf(held)).toMatchObject({ state: "held" });

  const item = await reviewOf(signal.id);
  expect((await choose(item, "maybe")).status).not.toBe(200);
  expect((await choose(item, "not_opt_out")).status).toBe(200);
  // The words stay for the reply desk, which drops them when its Item is settled.
  expect((await signals(to))[0]).toMatchObject({ status: "not_opt_out", decided_by: "person", text: "Who gave you my address?", quote: null });
  await replies.decide(W, signal.id);
  await ledger.run(W, held);
  expect(await stateOf(held)).toMatchObject({ state: "sent" });
});

test("when a person says it was an opt-out, the held send ends blocked and the words are kept", async () => {
  const { personId, to } = await addPerson();
  const held = await approved(personId);
  fake.deliver({ from: to, subject: "Re: Hello", text: "Enough of this, whoever you are" });
  await poll();
  const [signal] = await signals(to);
  await ledger.run(W, held);
  await replies.decide(W, signal.id);
  expect((await choose(await reviewOf(signal.id), "opted_out")).status).toBe(200);
  expect((await signals(to))[0]).toMatchObject({ status: "opted_out", decided_by: "person", quote: "Enough of this, whoever you are", text: null });
  expect(await suppressed(to)).toBe("reply");
  await replies.decide(W, signal.id);
  await ledger.run(W, held);
  expect(await stateOf(held)).toMatchObject({ state: "blocked", blockReason: "suppressed" });
});

test("a colleague asking to stop in our thread stops both addresses", async () => {
  const { personId, to } = await addPerson();
  const actionId = await approved(personId);
  await ledger.run(W, actionId);
  const key = (await stateOf(actionId)).correlationKey!;
  const colleague = newEmail();
  fake.deliver({ from: colleague, subject: "Re: Hello", text: "Please remove me and Kim", headers: { "In-Reply-To": key, References: key } });
  await poll();
  expect(await suppressed(colleague)).toBe("reply");
  expect(await suppressed(to)).toBe("reply");
});

const notice = (email: string, status: string) => ({
  from: "Mail Delivery Subsystem <mailer-daemon@googlemail.com>",
  subject: "Delivery Status Notification (Failure)",
  text: "It failed",
  deliveryStatus: `Reporting-MTA: dns; x\n\nFinal-Recipient: rfc822; ${email}\nAction: failed\nStatus: ${status}\n`,
});

test("a hard bounce stops that address with its own reason; a sender block and a forged notice stop nothing", async () => {
  const hard = await addPerson();
  const blocked = await addPerson();
  for (const p of [hard, blocked]) await ledger.run(W, await approved(p.personId));
  // Past the cap of one touch per three days.
  clock.at = new Date(clock.at.getTime() + 4 * 24 * 60 * 60 * 1000);
  const next = await approved(hard.personId);
  const stranger = newEmail();
  fake.deliver(notice(hard.to, "5.1.1"));
  fake.deliver(notice(blocked.to, "5.7.1"));
  fake.deliver(notice(stranger, "5.1.1"));
  await poll();
  expect(await suppressed(hard.to)).toBe("hard_bounce");
  expect(await suppressed(blocked.to)).toBeUndefined();
  expect(await suppressed(stranger)).toBeUndefined();
  expect((await signals(blocked.to))[0]).toMatchObject({ kind: "bounce", status: "recorded", bounce_status: "5.7.1" });
  await ledger.run(W, next);
  expect(await stateOf(next)).toMatchObject({ state: "blocked", blockReason: "hard_bounced" });
});

test("a bounce with only X-Failed-Recipients counts, and the code in its text decides whether the address is gone", async () => {
  const gone = await addPerson();
  const two = [await addPerson(), await addPerson()];
  for (const p of [gone, ...two]) await ledger.run(W, await approved(p.personId));
  const exim = { from: "Mail Delivery System <Mailer-Daemon@mx.example.com>", subject: "Mail delivery failed: returning message to sender" };
  fake.deliver({ ...exim, text: "SMTP error from remote mail server after RCPT TO: 550 5.1.1 User unknown", headers: { "X-Failed-Recipients": gone.to } });
  fake.deliver({ ...exim, text: "550 5.1.1 User unknown", headers: { "X-Failed-Recipients": two.map((p) => p.to).join(", ") } });
  await poll();
  expect(await suppressed(gone.to)).toBe("hard_bounce");
  expect((await signals(gone.to))[0]).toMatchObject({ kind: "bounce", bounce_status: "5.1.1" });
  // Two addresses and one code: which one it means is unknown, so both are recorded and neither is stopped.
  for (const p of two) {
    expect(await suppressed(p.to)).toBeUndefined();
    expect((await signals(p.to))[0]).toMatchObject({ kind: "bounce", status: "recorded", bounce_status: "5.0.0" });
  }
});

// The two tests above bounced five emails from this Mailbox: the third paused it.
test("bounces pause their Mailbox until someone who approves resumes it; what it held then goes, and older bounces stop counting", async () => {
  const pauses = async () => (await post<{ pauses: { credentialId: string; reason: string }[] }>("/outreach/mailbox-pauses", undefined, "GET")).body.pauses;
  expect(await pauses()).toEqual([expect.objectContaining({ credentialId, reason: "bounces" })]);
  clock.at = new Date(clock.at.getTime() + 4 * 24 * 60 * 60 * 1000);
  const { personId } = await addPerson();
  const held = await approved(personId);
  await ledger.run(W, held);
  expect(await stateOf(held)).toMatchObject({ state: "held", holdReason: "mailbox_paused" });

  // A placement effect has no Touch, but the same Mailbox pause holds and releases it.
  const { action: placement } = await ledger.createAction(W, { idempotencyKey: crypto.randomUUID(), capability: "com.trydirex.gmail/placement.send", credentialId, dedupe: "queryable", spec: { to: [newEmail()] }, actor: { userId: owner } });
  expect(await inWorkspace(W, (tx) => outreachFloors(async () => true)(tx, placement, { approverId: owner, standingRuleId: null, producerDigest: null }))).toMatchObject({ kind: "hold", reason: "mailbox_paused" });
  await q("update actions set state = 'held', hold_reason = 'mailbox_paused' where id = $1", [placement.id]);

  const contributor = (await addMember(cookie, W, "contributor")).cookie;
  const resumeAs = (who: string) => call(`/api/w/${W}/outreach/mailboxes/${credentialId}/pause`, who, { method: "PUT", body: { paused: false } });
  expect((await resumeAs(contributor)).status).toBe(403);
  expect(await pauses()).toHaveLength(1);
  expect((await resumeAs(cookie)).status).toBe(200);
  expect(await pauses()).toEqual([]);
  expect(await stateOf(held)).toMatchObject({ state: "scheduled" });
  expect(await stateOf(placement.id)).toMatchObject({ state: "scheduled" });
  await ledger.run(W, held);
  expect(await stateOf(held)).toMatchObject({ state: "sent" });

  // One new bounce after the resume, with the five before it no longer counted, doesn't pause it again.
  const { to } = await stateOf(held).then((a) => ({ to: (a.spec as { to: string[] }).to[0]! }));
  fake.deliver(notice(to, "5.1.1"));
  await poll();
  expect(await pauses()).toEqual([]);

  // A contributor may pause by hand; it records them, and the next email waits.
  expect((await call(`/api/w/${W}/outreach/mailboxes/${credentialId}/pause`, contributor, { method: "PUT", body: { paused: true } })).status).toBe(200);
  expect(await pauses()).toEqual([expect.objectContaining({ reason: "person" })]);
  const next = await approved((await addPerson()).personId);
  await ledger.run(W, next);
  expect(await stateOf(next)).toMatchObject({ state: "held", holdReason: "mailbox_paused" });
  expect((await call(`/api/w/${W}/outreach/mailboxes/${crypto.randomUUID()}/pause`, cookie, { method: "PUT", body: { paused: true } })).status).toBe(404);
  expect((await resumeAs(cookie)).status).toBe(200);
  await ledger.run(W, next);
  expect(await stateOf(next)).toMatchObject({ state: "sent" });
});

test("a pending reply holds a sales follow-up too", async () => {
  const { personId, to } = await addPerson();
  fake.deliver({ from: to, subject: "Re: Hello", text: "Who gave you my address?" });
  await poll();
  const { action } = await ledger.createAction(W, { idempotencyKey: crypto.randomUUID(), capability: SEND, dedupe: "queryable", spec: { to, touch: { personId, touchClass: "sales_follow_up" } }, actor: { userId: owner } });
  await ledger.submitForApproval(W, action.id, { userId: owner });
  expect((await ledger.approve(W, action.id, { approverId: approverIdFromSession(owner), draftVersion: 1, snapshot: [], dueAt: clock.at })).ok).toBe(true);
  await ledger.run(W, action.id);
  expect(await stateOf(action.id)).toMatchObject({ state: "held", holdReason: "reply_unread" });
});

test("what a pause held goes again once sending is unpaused", async () => {
  const { personId } = await addPerson();
  clock.at = new Date(clock.at.getTime() + 4 * 24 * 60 * 60 * 1000);
  const actionId = await approved(personId);
  expect((await post("/outreach/pause", { paused: true }, "PUT")).status).toBe(200);
  await ledger.run(W, actionId);
  expect(await stateOf(actionId)).toMatchObject({ state: "held", holdReason: "workspace_paused" });
  const unpaused = async (tx: Parameters<typeof sendingPaused>[0]) => !(await sendingPaused(tx));
  expect(await ledger.resumeHeldBy(W, "workspace_paused", { system: "outreach" }, unpaused)).toBe(0);
  expect((await post("/outreach/pause", { paused: false }, "PUT")).status).toBe(200);
  expect(await ledger.resumeHeldBy(W, "workspace_paused", { system: "outreach" }, unpaused)).toBe(1);
  await ledger.run(W, actionId);
  expect(await stateOf(actionId)).toMatchObject({ state: "sent" });
});

test("a person's reply titled like a bounce goes the reply route and suppresses nothing", async () => {
  const { to } = await addPerson();
  fake.deliver({ from: to, subject: "Returned mail", text: "Here's what I found" });
  await poll();
  expect(await suppressed(to)).toBeUndefined();
  expect((await signals(to))[0]).toMatchObject({ kind: "reply", status: "pending" });
});

test("while a mailbox's replies aren't being read its cold sends are held, and resuming sends them", async () => {
  const { personId } = await addPerson();
  clock.at = new Date(clock.at.getTime() + 4 * 24 * 60 * 60 * 1000);
  const actionId = await approved(personId);
  repliesBeingRead = false;
  await ledger.run(W, actionId);
  expect(await stateOf(actionId)).toMatchObject({ state: "held", holdReason: "replies_not_read" });
  repliesBeingRead = true;
  await ledger.resumeHeldBy(W, "replies_not_read", { system: "outreach" }, async (_tx, held) => held.credentialId === credentialId);
  await ledger.run(W, actionId);
  expect(await stateOf(actionId)).toMatchObject({ state: "sent" });
});

test("undecided reply text is cleared after 30 days, and the hold stays", async () => {
  const { personId, to } = await addPerson();
  fake.deliver({ from: to, subject: "Re: Hello", text: "Why me?" });
  await poll();
  const [signal] = await signals(to);
  await q("update reply_signals set received_at = now() - interval '31 days' where id = $1", [signal.id]);
  expect(await clearOldReplyText()).toBeGreaterThanOrEqual(1);
  expect((await signals(to))[0]).toMatchObject({ status: "pending", text: null });
  clock.at = new Date(clock.at.getTime() + 4 * 24 * 60 * 60 * 1000);
  const actionId = await approved(personId);
  await ledger.run(W, actionId);
  expect(await stateOf(actionId)).toMatchObject({ state: "held", holdReason: "reply_unread" });
});

test("the mailbox list runs across Workspaces and holds only connected Google mailboxes", async () => {
  expect((await connectedMailboxes(["google"])).map((m) => m.credentialId)).not.toContain(credentialId);
});

test("the reply to judge can be read over HTTP until it's decided, and the list says why someone stopped", async () => {
  const { to } = await addPerson();
  fake.deliver({ from: to, subject: "Re: Hello", text: "Enough now, truly" });
  await poll();
  const [signal] = await signals(to);
  await replies.decide(W, signal.id);
  const read = await post<{ text: string | null }>(`/outreach/replies/${signal.id}`, undefined, "GET");
  expect(read).toMatchObject({ status: 200, body: { text: "Enough now, truly", senderEmail: to } });
  expect((await post(`/outreach/replies/${crypto.randomUUID()}`, undefined, "GET")).status).toBe(404);
  expect((await choose(await reviewOf(signal.id), "opted_out")).status).toBe(200);
  expect((await post<{ text: string | null }>(`/outreach/replies/${signal.id}`, undefined, "GET")).body.text).toBeNull();
  const list = await post<{ people: { email: string; suppressedBecause: string; quote: string }[] }>("/outreach", undefined, "GET");
  expect(list.body.people.find((p) => p.email === to)).toMatchObject({ suppressedBecause: "reply", quote: "Enough now, truly" });
});

test("a reply to judge is never clean, so approving everything clean can't touch it", async () => {
  const { to } = await addPerson();
  fake.deliver({ from: to, subject: "Re: Hello", text: "Is this about the invoice?" });
  await poll();
  const [signal] = await signals(to);
  await replies.decide(W, signal.id);
  const id = await reviewOf(signal.id);
  const { item } = (await (await call(`/api/w/${W}/items/${id}`, cookie)).json()) as { item: { clean: boolean; revision: number } };
  expect(item.clean).toBe(false);
  const [result] = await items.approveClean(W, [{ id, revision: item.revision }], { userId: owner } as never);
  expect(result).toMatchObject({ result: { ok: false, reason: "not_clean" } });
  expect((await signals(to))[0]).toMatchObject({ status: "needs_person" });
});

const readingBack = () =>
  createOutreach({
    items: () => items,
    send: () => ({ id: SEND, dedupe: "queryable", prepare: (ws, input) => plugins.prepare(ws, SEND, input) }),
    baseUrl: () => "http://direx.test",
    readBack: (ws, email) => replies.markReadBack(ws, email),
    now: () => clock.at,
  });
const add = (email: string) => readingBack().addPerson(W, { email, country: "US", basis: "published_address", evidence: "their site", userId: owner });
const marker = async (email: string) => (await signals(email)).find((s) => s.kind === "read_back");

test("an opt-out read before someone became a Person counts once they are added, once", async () => {
  const to = newEmail();
  fake.deliver({ from: to, subject: "Hello", text: "Please remove me" });
  await poll();
  expect(await signals(to)).toEqual([]);
  expect(await add(to)).toMatchObject({ ok: true });
  expect(await marker(to)).toMatchObject({ status: "pending" });
  await replies.decide(W, (await marker(to)).id);
  expect(await marker(to)).toMatchObject({ status: "recorded" });
  expect(await suppressed(to)).toBe("reply");
  await replies.decide(W, (await marker(to)).id);
  expect((await signals(to)).filter((s) => s.kind === "reply")).toHaveLength(1);
});

test("while the search hasn't worked the new Person's sends are held, and a later run frees them", async () => {
  const to = newEmail();
  const person = await add(to);
  if (!person.ok) throw new Error(person.reason);
  const actionId = await approved(person.id);
  searchFails = true;
  await expect(replies.decide(W, (await marker(to)).id)).rejects.toThrow("the provider is down");
  await ledger.run(W, actionId);
  expect(await stateOf(actionId)).toMatchObject({ state: "held", holdReason: "reply_unread" });
  searchFails = false;
  await replies.decide(W, (await marker(to)).id);
  await ledger.run(W, actionId);
  expect(await stateOf(actionId)).toMatchObject({ state: "sent" });
});

test("a search that couldn't reach every Mailbox records nothing, holds the sends, and never asks a person", async () => {
  const to = newEmail();
  const person = await add(to);
  if (!person.ok) throw new Error(person.reason);
  const actionId = await approved(person.id);
  searchIncomplete = true;
  try {
    await expect(replies.decide(W, (await marker(to)).id)).rejects.toThrow("needs reconnecting");
    await ledger.run(W, actionId);
    expect(await stateOf(actionId)).toMatchObject({ state: "held", holdReason: "reply_unread" });
    clock.at = new Date(clock.at.getTime() + 2 * 86_400_000);
    await expect(replies.decide(W, (await marker(to)).id)).rejects.toThrow("needs reconnecting");
    expect(await marker(to)).toMatchObject({ status: "pending" });
    expect(await reviewOf((await marker(to)).id)).toBeUndefined();
  } finally {
    searchIncomplete = false;
  }
  await replies.decide(W, (await marker(to)).id);
  expect(await marker(to)).toMatchObject({ status: "recorded" });
});

test("a search still failing a day after the Person was added asks a person, and their answer frees the send", async () => {
  const to = newEmail();
  const person = await add(to);
  if (!person.ok) throw new Error(person.reason);
  const actionId = await approved(person.id);
  searchFails = true;
  try {
    await expect(replies.decide(W, (await marker(to)).id)).rejects.toThrow("the provider is down");
    await ledger.run(W, actionId);
    expect(await stateOf(actionId)).toMatchObject({ state: "held", holdReason: "reply_unread" });
    clock.at = new Date(clock.at.getTime() + 25 * 3_600_000);
    await replies.decide(W, (await marker(to)).id);
  } finally {
    searchFails = false;
  }
  const signal = await marker(to);
  expect(signal).toMatchObject({ status: "needs_person" });
  const review = await reviewOf(signal.id);
  expect(review).toBeDefined();
  expect((await choose(review, "not_opt_out")).status).toBe(200);
  expect(await marker(to)).toMatchObject({ status: "not_opt_out", decided_by: "person" });
  await replies.decide(W, signal.id);
  await ledger.run(W, actionId);
  // The read-back no longer holds it; any later hold (a day passed, so a cap may apply) is another check's.
  expect((await stateOf(actionId)).holdReason).not.toBe("reply_unread");
});

test("only a failure that reconnecting fixes counts as the Mailbox's; an outage doesn't", async () => {
  // A credential stored in the wrong shape, as one was on a dev database, fails in the real SDK.
  const malformed = loadPlugins({
    sources: [{ mode: "in_process", plugin: createGmailPlugin({ baseUrl: fake.url, timeoutMs: 1000 }) }],
    credentials: async () => ({ accessToken: undefined, expiresAt: undefined }) as never,
    confinement: "none",
    log: () => {},
    boss,
    onEvent: async () => {},
  });
  const refused = await malformed.query(W, "com.trydirex.gmail/mail.from", { email: "x@example.com" }, credentialId).catch((e: unknown) => e);
  expect(mailboxNeedsReconnect(refused)).toBe(true);
  expect(mailboxNeedsReconnect(new CallFailed("plugin error: mailbox not connected", { reason: "not_connected" }))).toBe(true);
  expect(mailboxNeedsReconnect(new CallFailed("plugin error: mailbox not connected", { reason: "provider_error", status: 503 }))).toBe(false);
  expect(mailboxNeedsReconnect("invalid params for query")).toBe(false);
});

test("adding someone already known starts no second search, and a search can't be widened", async () => {
  const to = newEmail();
  await add(to);
  await add(to);
  expect((await signals(to)).filter((s) => s.kind === "read_back")).toHaveLength(1);
  await expect(plugins.query(W, "com.trydirex.gmail/mail.from", { email: "a@b.com OR from:c@d.com" }, credentialId)).rejects.toThrow();
});

test("a search nobody finished is queued again", async () => {
  const to = newEmail();
  await add(to);
  clock.at = new Date(clock.at.getTime() + 6 * 60 * 1000);
  await replies.retryReadBacks(W);
  const { id } = await marker(to);
  const queued = async () => (await boss.findJobs("outreach.reply", { data: { workspaceId: W, signalId: id } })).filter((j) => j.state === "created").length;
  const after = await queued();
  expect(after).toBeGreaterThanOrEqual(2);
  // Asked again for every mailbox each minute, it still queues one retry per window.
  for (let i = 0; i < 3; i++) await replies.retryReadBacks(W);
  expect(await queued()).toBe(after);
});

test("the model reads what the rules leave: an opt-out it can quote stops them, with its quote kept", async () => {
  const { personId, to } = await addPerson();
  const held = await approved(personId);
  fake.deliver({ from: to, subject: "Re: Hello", text: "Honestly this isn't for us, kindly leave us off your list going forward." });
  await poll();
  const [signal] = await signals(to);
  await ledger.run(W, held);
  modelSays = { answer: "opt_out", quote: "kindly leave us off your list" };
  modelCalls.length = 0;
  await replies.decide(W, signal.id);
  expect(modelCalls).toEqual(["optout_detect:definition,reply_text"]);
  expect((await signals(to))[0]).toMatchObject({ status: "opted_out", decided_by: "model", quote: "kindly leave us off your list", text: null });
  expect(await suppressed(to)).toBe("reply");
  expect(await reviewOf(signal.id)).toBeUndefined();
  await ledger.run(W, held);
  expect(await stateOf(held)).toMatchObject({ state: "blocked", blockReason: "suppressed" });
  modelSays = "refuse";
});

test("an opt-out whose quote isn't in the reply, or an unsure answer, goes to a person", async () => {
  for (const said of [{ answer: "opt_out", quote: "remove me now" }, { answer: "unsure", quote: null }]) {
    const { to } = await addPerson();
    fake.deliver({ from: to, subject: "Re: Hello", text: "Who gave you my address?" });
    await poll();
    const [signal] = await signals(to);
    modelSays = said;
    await replies.decide(W, signal.id);
    expect((await signals(to))[0]).toMatchObject({ status: "needs_person" });
    expect(await reviewOf(signal.id)).toBeDefined();
    expect(await suppressed(to)).toBeUndefined();
  }
  modelSays = "refuse";
});

test("a reply the model says isn't an opt-out lets that Person's held send go", async () => {
  const { personId, to } = await addPerson();
  const held = await approved(personId);
  fake.deliver({ from: to, subject: "Re: Hello", text: "Who gave you my address? Anyway, send me pricing." });
  await poll();
  const [signal] = await signals(to);
  await ledger.run(W, held);
  modelSays = { answer: "not_opt_out", quote: null };
  await replies.decide(W, signal.id);
  expect((await signals(to))[0]).toMatchObject({ status: "not_opt_out", decided_by: "model", text: "Who gave you my address? Anyway, send me pricing." });
  await ledger.run(W, held);
  expect(await stateOf(held)).toMatchObject({ state: "sent" });
  modelSays = "refuse";
});

test("a reply a rule settles never reaches the model", async () => {
  const { to } = await addPerson();
  modelCalls.length = 0;
  modelSays = { answer: "not_opt_out", quote: null };
  fake.deliver({ from: to, subject: "Re: Hello", text: "Please unsubscribe me." });
  await poll();
  const [signal] = await signals(to);
  expect(signal).toMatchObject({ status: "opted_out", decided_by: "rule" });
  await replies.decide(W, signal.id);
  expect(modelCalls).toEqual([]);
  modelSays = "refuse";
});

test("a Mailbox check's bounce suppresses no one, the check itself isn't read as a reply, and a real reply to it still counts", async () => {
  const PROBE = "com.trydirex.gmail/mailbox.probe";
  const { to } = await addPerson();
  const subject = `Direx Mailbox check ${crypto.randomUUID().slice(0, 8)}`;
  const { spec } = await plugins.prepare(W, PROBE, { to: [to], subject, text: "This is an automatic check from Direx." });
  const { action } = await ledger.createAction(W, { idempotencyKey: crypto.randomUUID(), capability: PROBE, dedupe: "queryable", spec, actor: { userId: owner }, credentialId });
  await ledger.submitForApproval(W, action.id, { userId: owner });
  await ledger.approve(W, action.id, { approverId: approverIdFromSession(owner), draftVersion: action.draftVersion, snapshot: [{ kind: "credential", id: credentialId, version: "me@acme.test" }] });
  await ledger.run(W, action.id);
  expect((await ledger.getAction(W, action.id))!.state).toBe("sent");

  fake.deliver(notice(to, "5.1.1"));
  fake.deliver({ from: to, subject, text: "Please remove me" });
  await poll();
  expect(await suppressed(to)).toBeUndefined();
  expect(await signals(to)).toEqual([]);

  // Near miss: the same words in a reply are the Person's own, and stop mail to them.
  fake.deliver({ from: to, subject: `Re: ${subject}`, text: "Please remove me" });
  await poll();
  expect(await suppressed(to)).toBe("reply");
});

const undoOptOut = (personId: string, reason: string, as = cookie) =>
  call(`/api/w/${W}/outreach/people/${personId}/undo-opt-out`, as, { method: "POST", body: { reason } });

test("an Owner undoes a misread opt-out with a reason: the group is cleared, the record kept, and the blocked send stays blocked", async () => {
  const { personId, to } = await addPerson();
  const [other, bounced] = [newEmail(), newEmail()];
  expect((await addKey(W, personId, "email", other)).ok).toBe(true);
  expect((await addKey(W, personId, "email", bounced)).ok).toBe(true);
  await q("insert into suppressions (workspace_id, email, reason, created_at) values ($1, $2, 'hard_bounce', now())", [W, bounced]);
  const actionId = await approved(personId);
  fake.deliver({ from: `Kim <${to}>`, subject: "Re: Hello", text: "Please remove me" });
  await poll();
  await ledger.run(W, actionId);
  expect(await suppressed(other)).toBe("reply");

  const r = await undoOptOut(personId, "She asked to be removed from the newsletter, not this thread");
  expect(r.status).toBe(200);
  expect(await r.json()).toEqual({ ok: true, undone: 2 });
  expect([await suppressed(to), await suppressed(other)]).toEqual([undefined, undefined]);
  expect(await suppressed(bounced)).toBe("hard_bounce");
  expect(await q("select email, undone_by, reason, quote from suppression_reversals where email = $1", [to])).toEqual([
    { email: to, undone_by: owner, reason: "She asked to be removed from the newsletter, not this thread", quote: "Please remove me" },
  ]);
  expect(await stateOf(actionId)).toMatchObject({ state: "blocked", blockReason: "suppressed" });

  // A later opt-out stops them again.
  fake.deliver({ from: to, subject: "Re: Hello", text: "Please remove me" });
  await poll();
  expect(await suppressed(to)).toBe("reply");
});

test("only an Owner may undo, only with a reason, and only an opt-out read from a reply", async () => {
  const { personId, to } = await addPerson();
  fake.deliver({ from: to, subject: "Re: Hello", text: "Please remove me" });
  await poll();
  const admin = await addMember(cookie, W, "admin");
  expect((await undoOptOut(personId, "a reason", admin.cookie)).status).toBe(403);
  expect((await undoOptOut(personId, "   ")).status).toBe(400);
  expect(await suppressed(to)).toBe("reply");

  const clicked = await addPerson();
  await q("insert into suppressions (workspace_id, email, reason, created_at) values ($1, $2, 'unsubscribe', now())", [W, clicked.to]);
  const refused = await undoOptOut(clicked.personId, "a reason");
  expect(refused.status).toBe(409);
  expect(await refused.json()).toEqual({ error: "nothing_to_undo" });
  expect(await suppressed(clicked.to)).toBe("unsubscribe");
});

test("the reply count says how many replies came in between two times, and how many asked to stop", async () => {
  const count = async (from: string, to: string) => {
    const r = await call(`/api/w/${W}/outreach/reply-count?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`, cookie);
    expect(r.status).toBe(200);
    return (await r.json()) as { replies: number; optedOut: number };
  };
  const always = ["2000-01-01T00:00:00.000Z", "2100-01-01T00:00:00.000Z"] as const;
  const before = await count(...always);
  const friendly = await addPerson();
  const leaving = await addPerson();
  fake.deliver({ from: friendly.to, subject: "Re: Hello", text: "Thanks, this looks useful.\n\n" + FOOTER });
  fake.deliver({ from: leaving.to, subject: "Re: Hello", text: "Please remove me from your list." });
  await poll();
  expect(await count(...always)).toEqual({ replies: before.replies + 2, optedOut: before.optedOut + 1 });
  expect(await count("2000-01-01T00:00:00.000Z", "2000-01-02T00:00:00.000Z")).toEqual({ replies: 0, optedOut: 0 });
  expect((await call(`/api/w/${W}/outreach/reply-count?from=yesterday&to=today`, cookie)).status).toBe(400);
});

test("Home's results compare the last 7 days with the 7 before, keep a sentence Home can show and drop one it can't, once a day", async () => {
  type Line = { key: string; now: number; before: number; why: string | null };
  const results = async () => {
    const r = await call(`/api/w/${W}/outreach/results`, cookie);
    expect(r.status).toBe(200);
    return ((await r.json()) as { results: Line[] }).results;
  };
  const counted = async (fromDays: number, toDays: number) => {
    const at = (d: number) => encodeURIComponent(new Date(clock.at.getTime() - d * 86_400_000).toISOString());
    return (await (await call(`/api/w/${W}/outreach/reply-count?from=${at(fromDays)}&to=${at(toDays)}`, cookie)).json()) as { replies: number; optedOut: number };
  };
  const leaving = await addPerson();
  fake.deliver({ from: leaving.to, subject: "Re: Hello", text: "Please remove me from your list." });
  await poll();
  clock.at = new Date(clock.at.getTime() + 60_000);
  const [now, before] = [await counted(7, 0), await counted(14, 7)];
  modelSays = { schemaVersion: 1, lines: [{ key: "replies", why: "Most replies answered the Hello email." }, { key: "opt_outs", why: "People left — fast!" }] } as never;
  const first = await results();
  expect(first.find((l) => l.key === "replies")).toEqual({ key: "replies", label: "Replies to outreach, last 7 days", now: now.replies, before: before.replies, why: "Most replies answered the Hello email." });
  expect(first.find((l) => l.key === "opt_outs")).toMatchObject({ now: now.optedOut, why: null });
  expect(modelCalls.at(-1)).toBe("result_why:definition,home_results");

  // Later the same day: the same answer, without asking again.
  modelSays = "refuse";
  const asked = modelCalls.length;
  expect(await results()).toEqual(first);
  expect(modelCalls.length).toBe(asked);

  // After a restart the same facts are a repeat the model layer refuses; Home asks again with a trailing space and keeps its sentence.
  const keys: string[] = [];
  const answer = { schemaVersion: 1, lines: [{ key: "replies", why: "Most replies answered the Hello email." }] };
  const once = (async (req: { idempotencyKey: string }) => {
    if (keys.includes(req.idempotencyKey)) return { ok: false, callId: "c", refusal: "duplicate" };
    keys.push(req.idempotencyKey);
    return { ok: true, callId: "c", trust: "trusted", output: answer, toolCalls: [], routeHash: "r" };
  }) as never;
  await resultLines({ now: () => clock.at, generate: () => once })(W, owner);
  const restarted = await resultLines({ now: () => clock.at, generate: () => once })(W, owner);
  expect(keys).toHaveLength(2);
  expect(restarted.find((l) => l.key === "replies")?.why).toBe("Most replies answered the Hello email.");

  // A model that declines is asked once more, and no more than that.
  let declines = 1;
  let asks = 0;
  const shy = (async () => {
    asks++;
    return declines-- > 0 ? { ok: false, callId: "c", errorFamily: "model_refusal", reason: "tool: no tool" } : { ok: true, callId: "c", trust: "trusted", output: answer, toolCalls: [], routeHash: "r" };
  }) as never;
  expect((await resultLines({ now: () => clock.at, generate: () => shy })(W, owner)).find((l) => l.key === "replies")?.why).toBe("Most replies answered the Hello email.");
  expect(asks).toBe(2);
  [declines, asks] = [9, 0];
  expect((await resultLines({ now: () => clock.at, generate: () => shy })(W, owner)).every((l) => l.why === null)).toBe(true);
  expect(asks).toBe(2);

  // The next day asks again; a refusal leaves the numbers without a sentence.
  clock.at = new Date(clock.at.getTime() + 86_400_000);
  expect((await results()).every((l) => l.why === null)).toBe(true);
});


test("a stale bounce pause cannot undo a resume; person pauses still work", async () => {
  await inWorkspace(W, async (tx) => {
    const before = (await pauseOf(tx, credentialId))!;
    await clearPause(tx, credentialId, new Date(clock.at.getTime() + 1000));
    await setPause(tx, credentialId, { reason: "bounces", by: null, at: clock.at, resumedAt: before.resumedAt });
    expect((await pauseOf(tx, credentialId))!.pausedAt).toBeNull();
    await setPause(tx, credentialId, { reason: "bounces", by: null, at: clock.at, resumedAt: null });
    expect((await pauseOf(tx, credentialId))!.pausedAt).toBeNull();
    await setPause(tx, credentialId, { reason: "person", by: owner, at: clock.at });
    expect((await pauseOf(tx, credentialId))!.pauseReason).toBe("person");
    await clearPause(tx, credentialId, clock.at);
  });
});

test("a bounce received by another Mailbox cannot match this Mailbox's send", async () => {
  const { personId, to } = await addPerson();
  await ledger.run(W, await approved(personId));
  await inWorkspace(W, (tx) => replies.intake(tx, { workspaceId: W, credentialId: crypto.randomUUID(), eventId: crypto.randomUUID(), data: { headers: { from: "mailer-daemon@example.com", date: clock.at.toISOString(), to: "", subject: "Delivery failure", inReplyTo: "", references: "" }, text: "failed", dsn: { recipients: [{ email: to, status: "5.1.1" }] } } }));
  expect(await signals(to)).toEqual([]);
  expect(await suppressed(to)).toBeUndefined();
});

const replyItems = (personId: string) => q("select id, state, title, payload from items where kind = 'reply' and payload->>'personId' = $1 order by created_at", [personId]);
const inThread = (to: string, messageId: string, text: string) =>
  inWorkspace(W, (tx) => replies.intake(tx, { workspaceId: W, credentialId, eventId: crypto.randomUUID(), data: { headers: { from: to, date: clock.at.toISOString(), to: "me@acme.test", subject: "Re: Hello", inReplyTo: messageId, references: messageId }, text } }));

test("a reply that isn't an opt-out opens one reply Item, labelled and owned by the email's approver; a second reply in the thread replaces it", async () => {
  const { personId, to } = await addPerson();
  const sent = await approved(personId);
  await ledger.run(W, sent);
  const messageId = (await q("select correlation_key from actions where id = $1", [sent]))[0].correlation_key as string;
  modelSays = { answer: "not_opt_out", quote: null };
  labelSays = { label: "interested", quote: "can we talk Friday" };
  await inThread(to, messageId, "Sounds good, can we talk Friday?");
  const [first] = await signals(to);
  expect(first).toMatchObject({ action_id: sent });
  await replies.decide(W, first.id);
  expect(await replyItems(personId)).toMatchObject([
    { state: "needs_approval", title: `${to} wants to talk`, payload: { signalId: first.id, actionId: sent, label: "interested", quote: "can we talk Friday", owner: { userIds: [owner], rule: "approver" } } },
  ]);

  labelSays = { label: "question", quote: "does it work with HubSpot" };
  await inThread(to, messageId, "Also, does it work with HubSpot?");
  const second = (await signals(to)).find((x) => x.id !== first.id)!;
  await replies.decide(W, second.id);
  const both = await replyItems(personId);
  expect(both.map((i) => i.state)).toEqual(["cancelled", "needs_approval"]);
  expect(both[1]).toMatchObject({ title: `${to} asked a question`, payload: { signalId: second.id, label: "question" } });

  // Its owner was told once, by name and our own subject, never with the reply's words.
  const subject = (await q("select spec->>'subject' as s from actions where id = $1", [sent]))[0].s as string;
  const told = alerts.filter((a) => a.subject === `${to} wants to talk`);
  expect(told).toEqual([{ userIds: [owner], subject: `${to} wants to talk`, text: expect.stringContaining(`"${subject}"`) }]);
  expect(told[0]!.text).not.toContain("Friday");
  // A later reply in the same thread sorted as wanting to talk again tells no one twice.
  labelSays = { label: "interested", quote: "Friday at 10" };
  await inThread(to, messageId, "Friday at 10 then.");
  const third = (await signals(to)).find((x) => x.id !== first.id && x.id !== second.id)!;
  await replies.decide(W, third.id);
  expect(alerts.filter((a) => a.subject === `${to} wants to talk`)).toHaveLength(1);
  modelSays = "refuse";
  labelSays = "refuse";
});

test("an unlabelled reply still opens its Item, owned by the Owners when nobody approved an email; settling it drops the thread's words for good", async () => {
  const { personId, to } = await addPerson();
  modelSays = { answer: "not_opt_out", quote: null };
  fake.deliver({ from: to, subject: "Re: Hello", text: "Who is this?" });
  await poll();
  const [signal] = await signals(to);
  await replies.decide(W, signal.id);
  const [item] = await replyItems(personId);
  expect(item).toMatchObject({ title: `${to} replied`, payload: { label: "unlabelled", quote: null, actionId: null, owner: { userIds: [owner], rule: "workspace_owners" } } });
  expect((await signals(to))[0].text).toBe("Who is this?");

  expect((await choose(item.id, "sure")).status).not.toBe(200);
  expect((await choose(item.id, "no_answer")).status).toBe(200);
  expect((await signals(to))[0].text).toBeNull();
  // A retried job finds no words left, so nothing opens again.
  await replies.decide(W, signal.id);
  expect(await replyItems(personId)).toHaveLength(1);
  modelSays = "refuse";
});

test("an alert that can't be sent leaves the reply Item open and the job done", async () => {
  const { personId, to } = await addPerson();
  modelSays = { answer: "not_opt_out", quote: null };
  labelSays = { label: "interested", quote: "Let's talk" };
  alertFails = true;
  fake.deliver({ from: to, subject: "Re: Hello", text: "Let's talk." });
  await poll();
  const [signal] = await signals(to);
  await replies.decide(W, signal.id);
  expect(await replyItems(personId)).toMatchObject([{ state: "needs_approval", payload: { label: "interested" } }]);
  alertFails = false;
  modelSays = "refuse";
  labelSays = "refuse";
});

test("a reply's owner is the email's approver, else the Mailbox's person, else the Workspace's Owners", () => {
  expect(replyOwner("a", "m", ["o"])).toEqual({ userIds: ["a"], rule: "approver" });
  expect(replyOwner(null, "m", ["o"])).toEqual({ userIds: ["m"], rule: "mailbox" });
  expect(replyOwner(null, null, ["o", "p"])).toEqual({ userIds: ["o", "p"], rule: "workspace_owners" });
});

test("an alert goes to each owner still a member, and to nobody when no mailer is set up", async () => {
  const sent: { to: string }[] = [];
  const emailOf = async (_w: string, id: string) => (id === "gone" ? undefined : `${id}@acme.test`);
  await mailMembers(async (m) => void sent.push(m), emailOf)(W, ["a", "gone", "b"], { subject: "s", text: "t" });
  expect(sent).toEqual([{ to: "a@acme.test", subject: "s", text: "t" }, { to: "b@acme.test", subject: "s", text: "t" }]);
  await mailMembers(undefined, emailOf)(W, ["a"], { subject: "s", text: "t" });
  expect(sent).toHaveLength(2);
});
