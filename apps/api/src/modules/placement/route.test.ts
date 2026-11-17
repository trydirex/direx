// SPDX-License-Identifier: AGPL-3.0-only
// Placement mail is routed before reply and bounce handling, as the worker wires it: a Placement
// check in the inbox or in Sent, a bounce, an auto-reply, a human reply and a report touch nothing in
// outreach, even when the Circle member's address is also a Person the Workspace has written to.
// Ordinary mail still settles as before.
import { afterAll, expect, test } from "vitest";
import { appClient } from "../../../../../test/db";
import { createBoss } from "../../jobs/boss";
import { campaignReplies } from "../campaigns/index";
import { createVault, rootKeyFromEnv } from "../credentials/index";
import { seedMember } from "../identity/fixtures/member";
import { createReplies, humanReply, recordSentMail, type InboundEvent } from "../outreach/index";
import { addKey, createPerson } from "../people/index";
import type { TriggerData } from "@direx/plugin-sdk";
import { EMAIL_RECEIVED, MAIL_SENT, type CatalogueEvent } from "../plugins/index";
import { inWorkspace, type PlacementTx } from "./adapters/repo";
import { routePlacement, type MatchInbound } from "./index";

const W = crypto.randomUUID();
const owner = crypto.randomUUID();
await seedMember(W, owner);
const db = await appClient();
const boss = createBoss();
await boss.start();
afterAll(async () => {
  await boss.stop({ graceful: false, close: true });
  await db.end();
});
const q = async (text: string, params: unknown[] = []) => {
  await db.query("begin");
  await db.query("select set_config('app.workspace_id', $1, true)", [W]);
  const r = await db.query(text, params);
  await db.query("commit");
  return r.rows;
};

const vault = createVault({ rootKey: rootKeyFromEnv({ DIREX_MASTER_KEY: "11".repeat(32) })!, now: () => new Date() });
const made = await vault.create({ workspaceId: W, actorUserId: owner, scope: "workspace", kind: "api_key", key: "me@acme.test", name: "Mailbox", meta: {}, value: { key: "x" } });
if (!made.ok) throw new Error(made.reason);
const mailbox = made.credential.id;

const person = async (email: string) => {
  const id = await createPerson(W);
  expect((await addKey(W, id, "email", email)).ok).toBe(true);
  return id;
};
// The worst case: a Circle member's address is also a Person this Workspace has sent cold mail to.
const MEMBER = "member@circle.test";
const memberId = await person(MEMBER);
const KIM = "kim@example.com";
const kimId = await person(KIM);

const sentAction = (capability: string, to: string, correlationKey: string, personId: string | null) =>
  q(
    `insert into actions (workspace_id, idempotency_key, capability, dedupe_class, state, spec, spec_hash, credential_id, correlation_key, created_at, updated_at)
     values ($1, gen_random_uuid(), $2, 'queryable', 'sent', $3::jsonb, 'h', $4, $5, now(), now()) returning id`,
    [W, capability, JSON.stringify({ to: [to], ...(personId && { touch: { personId } }) }), mailbox, correlationKey],
  ).then((rows) => rows[0].id as string);
const PROBE = "<probe-1@mail.gmail.com>";
await sentAction("com.trydirex.gmail/placement.send", MEMBER, PROBE, null);
await sentAction("com.trydirex.gmail/email.send", MEMBER, "<cold-member@mail.gmail.com>", memberId);
const kimCold = await sentAction("com.trydirex.gmail/email.send", KIM, "<cold-kim@mail.gmail.com>", kimId);

// The opt-out model, which must never be asked about placement mail.
const modelCalls: string[] = [];
const generate = (async () => {
  modelCalls.push("optout_detect");
  return { ok: false, callId: null, refusal: "no_route" };
}) as never;
const unused = () => {
  throw new Error("not reached in these tests");
};
const replies = createReplies({ boss, items: unused, ledger: unused, generate: () => generate });
await replies.ensureQueue();
const replied: string[] = [];
const consumers = [
  replies.intake,
  campaignReplies({
    items: unused,
    humanReply: async (tx, e) => {
      const p = await humanReply(tx, e);
      if (p) replied.push(p);
      return p;
    },
  }),
];
// The stand-in for matching by sender, seed-derived subject and send window.
const expected = new Set(["Placement check 7f3a", "Placement report 2026-11-10"]);
const matchInbound: MatchInbound = async (_tx, e) => expected.has(e.data.headers.subject);

/** The worker's onEvent, with the router first. Whether placement claimed the event. */
const deliver = (e: CatalogueEvent) =>
  inWorkspace(W, async (tx: PlacementTx) => {
    if (await routePlacement(tx, e, matchInbound)) return true;
    if (e.trigger === EMAIL_RECEIVED) for (const consume of consumers) await consume(tx, e);
    if (e.trigger === MAIL_SENT) await recordSentMail(tx, e, new Date());
    return false;
  });
// Events as the plugin host hands them on, their data parsed through the catalogue's entries.
const key = () => ({ workspaceId: W, pluginId: "com.trydirex.gmail", credentialId: mailbox, eventId: crypto.randomUUID() });
const sentMail = (data: TriggerData<"mail.sent">): CatalogueEvent => ({ ...key(), trigger: MAIL_SENT, data });
const received = (m: { from: string; subject: string; text?: string; inReplyTo?: string; references?: string; autoSubmitted?: string; dsn?: TriggerData<"email.received">["dsn"] }): CatalogueEvent<"email.received"> => ({
  ...key(),
  trigger: EMAIL_RECEIVED,
  data: { headers: { from: m.from, subject: m.subject, date: "", inReplyTo: m.inReplyTo ?? "", references: m.references ?? "" }, text: m.text ?? "", autoSubmitted: m.autoSubmitted ?? null, dsn: m.dsn ?? null },
});

/** Everything placement mail must leave alone. */
const outreachState = async () => ({
  people: (await q("select count(*)::int as n from people"))[0].n as number,
  signals: await q("select event_id, status from reply_signals order by event_id"),
  suppressions: await q("select email, reason from suppressions order by email"),
  correspondents: (await q("select count(*)::int as n from correspondents"))[0].n as number,
  reservations: (await q("select count(*)::int as n from mailbox_reservations"))[0].n as number,
  replied: [...replied],
  modelCalls: modelCalls.length,
});

test.each([
  ["a Placement check in the inbox", received({ from: MEMBER, subject: "Placement check 7f3a", text: "Please remove me" })],
  ["a hard bounce of one", received({ from: "Mail Delivery Subsystem <mailer-daemon@googlemail.com>", subject: "Delivery Status Notification (Failure)", inReplyTo: PROBE, references: PROBE, dsn: { recipients: [{ email: MEMBER, status: "5.1.1" }] } })],
  ["an auto-reply to one", received({ from: MEMBER, subject: "Out of office", references: PROBE, autoSubmitted: "auto-replied", text: "I'm away" })],
  ["a human reply to one", received({ from: `Member <${MEMBER}>`, subject: "Re: Placement check 7f3a", inReplyTo: PROBE, references: PROBE, text: "Please remove me" })],
  ["a report", received({ from: MEMBER, subject: "Placement report 2026-11-10", text: '{"verdict":"primary"}' })],
  ["a Placement check in Sent", sentMail({ messageId: PROBE, recipients: [MEMBER], sentAt: Date.now(), xDirexAction: null, listUnsubscribe: null, precedence: null })],
])("%s is claimed and touches no Person, reply, suppression, model, correspondent, Campaign or Mailbox day", async (_name, e) => {
  const before = await outreachState();
  expect(await deliver(e)).toBe(true);
  expect(await outreachState()).toEqual(before);
});

test("a Placement check in Sent records no correspondent even if it reaches the Sent handler", async () => {
  const sent = { messageId: PROBE, recipients: [MEMBER], sentAt: Date.now(), xDirexAction: null, listUnsubscribe: null, precedence: null };
  await inWorkspace(W, (tx) => recordSentMail(tx, { workspaceId: W, credentialId: mailbox, data: sent }, new Date()));
  expect((await q("select count(*)::int as n from correspondents"))[0].n).toBe(0);
  // Hand-written mail still does.
  await inWorkspace(W, (tx) => recordSentMail(tx, { workspaceId: W, credentialId: mailbox, data: { ...sent, messageId: "<by-hand@mail.gmail.com>" } }, new Date()));
  expect((await q("select count(*)::int as n from correspondents"))[0].n).toBe(1);
});

test("an ordinary reply to a cold email settles as before: opted out by rule, suppressed, and the Campaign told", async () => {
  expect(await deliver(received({ from: `Kim <${KIM}>`, subject: "Re: Hello", inReplyTo: "<cold-kim@mail.gmail.com>", text: "Please remove me" }))).toBe(false);
  expect(await q("select kind, status, action_id, person_id from reply_signals where sender_email = $1", [KIM])).toEqual([{ kind: "reply", status: "opted_out", action_id: kimCold, person_id: kimId }]);
  expect(await q("select reason from suppressions where email = $1", [KIM])).toEqual([{ reason: "reply" }]);
  expect(replied).toEqual([kimId]);
});

test("mail the matcher doesn't claim, such as a content probe over the cap, is ordinary mail", async () => {
  expect(await deliver(received({ from: MEMBER, subject: "Our autumn offer", text: "Thanks, sounds good" }))).toBe(false);
  expect(await q("select kind, person_id from reply_signals where sender_email = $1", [MEMBER])).toEqual([{ kind: "reply", person_id: memberId }]);
  expect(replied).toContain(memberId);
});

test("a Placement check seen in Sent before its Message-ID is stored, or with none stored, is claimed by when it went; hand-written mail to the member later is not", async () => {
  const OTHER = "other@circle.test";
  const sentAt = Date.now();
  // Being sent: the dispatch began and the Gmail call hasn't settled, so its correlation key isn't Gmail's yet.
  await q(
    `insert into actions (workspace_id, idempotency_key, capability, dedupe_class, state, spec, spec_hash, credential_id, first_dispatched_at, dispatch_started_at, created_at, updated_at)
     values ($1, gen_random_uuid(), 'com.trydirex.gmail/placement.send', 'blind', 'dispatching', $2::jsonb, 'h', $3, $4, $4, now(), now())`,
    [W, JSON.stringify({ to: [OTHER] }), mailbox, new Date(sentAt - 2_000)],
  );
  const sent = (messageId: string, at: number) => sentMail({ messageId, recipients: [OTHER], sentAt: at, xDirexAction: null, listUnsubscribe: null, precedence: null });
  const correspondents = async () => (await q("select count(*)::int as n from correspondents"))[0].n as number;
  const before = await correspondents();
  expect(await deliver(sent("<gmail-not-yet@mail.gmail.com>", sentAt))).toBe(true);
  expect(await correspondents()).toBe(before);
  expect(await deliver(sent("<by-hand-later@mail.gmail.com>", sentAt + 3 * 3_600_000))).toBe(false);
  expect(await correspondents()).toBe(before + 1);
});

test("a read-back search routes what it finds first, so a Placement check older than the skip list never reaches intake", async () => {
  /** A read-back for a member just added as a Person, whose search finds one old check from them; routed as the worker wires it, or not at all. */
  const readBack = async (email: string, routed: boolean) => {
    await person(email);
    const found = [received({ from: email, subject: "Placement check 7f3a", text: "Please remove me" })];
    const searching = createReplies({
      boss,
      items: unused,
      ledger: () => ({ resumeHeldBy: async () => 0 }),
      generate: () => generate,
      searchMailboxes: async () => ({ events: found, complete: true }),
      ...(routed && { claim: (tx: PlacementTx, e: InboundEvent) => routePlacement(tx, { ...e, pluginId: "", trigger: EMAIL_RECEIVED }, matchInbound) }),
    });
    await searching.markReadBack(W, email);
    const [signal] = await q("select id from reply_signals where kind = 'read_back' and sender_email = $1", [email]);
    await searching.decide(W, signal.id as string);
    return {
      signals: await q("select kind, status from reply_signals where sender_email = $1 order by kind", [email]),
      suppressions: await q("select reason from suppressions where email = $1", [email]),
    };
  };
  const calls = modelCalls.length;
  expect(await readBack("routed@circle.test", true)).toEqual({ signals: [{ kind: "read_back", status: "recorded" }], suppressions: [] });
  expect(modelCalls.length).toBe(calls);
  // Without the router the same check is read as the member asking to stop.
  expect(await readBack("unrouted@circle.test", false)).toEqual({ signals: [{ kind: "read_back", status: "recorded" }, { kind: "reply", status: "opted_out" }], suppressions: [{ reason: "reply" }] });
});
