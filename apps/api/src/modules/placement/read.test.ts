// SPDX-License-Identifier: AGPL-3.0-only
// Reading the Placement checks other Circle members send, through the read job, the Dispatcher and the
// Gmail plugin against the fake Gmail, which fails any get of a check that could carry its body,
// snippet or subject. A Mailbox expects each paired member's checks, reads them two hours after their
// time by labels and Message-ID only, and archives a content check found in the inbox, once. Content
// checks over the receiver's caps are never read and stay ordinary mail. The reply poll never fetches
// an expected check, and inbound routing claims one that reaches it.
import { createGmailPlugin } from "@direx/extensions";
import { startFakeGmail } from "@direx/extensions/gmail/fake";
import { afterAll, expect, test } from "vitest";
import { ownerClient } from "../../../../../test/db";
import { createVault, credentialLabel, credentialReady, rootKeyFromEnv } from "../credentials/index";
import { approverMayApprove, workspaceLive } from "../identity/index";
import { testIdentity } from "../identity/test-auth";
import { testLedger } from "../ledger/test-effects";
import type { Deployment } from "../models/index";
import { outreachFloors } from "../outreach/index";
import { EMAIL_RECEIVED, loadPlugins, type CatalogueEvent, type TriggerEvent } from "../plugins/index";
import { mailboxDayCheck, touchCheck } from "../schedule/index";
import { inWorkspace, insertGrant } from "./adapters/repo";
import type { Member } from "./domain/list";
import {
  contentSubject,
  createPlacement,
  createReading,
  isPlacementCapability,
  matchExpected,
  PLACEMENT_WORDING_VERSION,
  placementGranted,
  placementGrantVersion,
  placementSendCheck,
  probeIdentity,
  routePlacement,
  seed,
  skipFor,
  type TrustedList,
} from "./index";

const GMAIL = "com.trydirex.gmail";
const ARCHIVE = `${GMAIL}/placement.archive`;
const READ = `${GMAIL}/placement.read`;
const HASH = "c".repeat(64);
const STEP = "Quick idea for Example Ltd";

const fake = startFakeGmail();
afterAll(() => fake.stop());
const plugins = loadPlugins({
  sources: [{ mode: "in_process", plugin: createGmailPlugin({ baseUrl: fake.url, timeoutMs: 1000 }) }],
  credentials: async () => ({ accessToken: fake.token, expiresAt: "" }),
  confinement: "none",
  log: () => {},
});
const deployment: { value: Deployment } = { value: "self_host" };
const { ledger, clock } = await testLedger({
  effects: plugins.effects,
  resolvers: { credential: credentialLabel, placement_grant: placementGrantVersion },
  checks: [
    workspaceLive(),
    outreachFloors(async () => true),
    approverMayApprove((c) => (isPlacementCapability(c) ? "rule.grant" : undefined)),
    placementGranted(() => deployment.value),
    placementSendCheck(() => clock.at),
    touchCheck({ effects: plugins.effects, now: () => clock.at }),
    mailboxDayCheck({ now: () => clock.at }),
    credentialReady,
  ],
});
const placement = createPlacement({ ledger: () => ledger, deployment: () => deployment.value, now: () => clock.at });
const vault = createVault({ rootKey: rootKeyFromEnv({ DIREX_MASTER_KEY: "11".repeat(32) })!, now: () => clock.at });
const { call, signIn, createOrg } = testIdentity();

const member = (address: string, extra: Partial<Member> = {}): Member => ({
  address,
  provider: "google",
  key: "k".repeat(43),
  invited_by: "signer",
  criteria_checked_by: "signer",
  criteria: { named_person: true, business_website: true, domain_six_months: true },
  listed_at: "2026-10-01",
  may_invite: true,
  founder_controlled: true,
  ...extra,
});
const listOf = (members: Member[]): TrustedList => ({
  version: 3,
  contentHash: HASH,
  list: { version: 3, expires: "2027-01-01T00:00:00Z", bootstrap: true, members, removed: [] },
  rootChainLength: 0,
  rootChainHash: "",
  pinnedRootHash: "",
});
const at = (iso: string) => (clock.at = new Date(iso));
const readingWith = (members: Member[], opts: { canRead?: boolean } = {}) =>
  createReading({
    placement,
    ledger: () => ledger,
    readFor: async () => (opts.canRead === false ? undefined : READ),
    archiveFor: async () => ({ id: ARCHIVE, dedupe: "blind", prepare: (ws, input) => plugins.prepare(ws, ARCHIVE, input) }),
    query: (ws, capability, input, credentialId) => plugins.query(ws, capability, input, credentialId),
    deployment: () => deployment.value,
    trust: async () => ({ ok: true, trusted: listOf(members) }),
    now: () => clock.at,
  });

/** A Workspace of its own with one receiving Mailbox that has a live yes. */
async function receiver() {
  const cookie = await signIn();
  const W = (await createOrg(cookie)).workspace.id;
  const ownerId = ((await (await call("/api/me", cookie)).json()) as { user: { id: string } }).user.id;
  const address = `${crypto.randomUUID().slice(0, 8)}@acme.google.test`;
  const r = await vault.create({ workspaceId: W, actorUserId: ownerId, scope: "workspace", kind: "api_key", key: address, connection: "google", name: "Mailbox", meta: {}, value: { key: "x" } });
  if (!r.ok) throw new Error(r.reason);
  await inWorkspace(W, (tx) => insertGrant(tx, { workspaceId: W, credentialId: r.credential.id, answer: "yes", wordingVersion: PLACEMENT_WORDING_VERSION, answeredBy: ownerId, answeredAt: clock.at }));
  return { W, ownerId, id: r.credential.id, address, me: member(address) };
}

const db = await ownerClient();
afterAll(() => db.end());
type Row = { id: string; peer: string; kind: string; day: string; subject: string | null; expected_at: Date; skip_reason: string | null; verdict: string | null; message_id: string | null; archive_action_id: string | null };
/** This Mailbox's expected checks, by sender then kind. */
const rowsOf = async (credentialId: string) =>
  (await db.query("select id, peer, kind, day::text, subject, expected_at, skip_reason, verdict, message_id, archive_action_id from placement_probes where credential_id = $1 and direction = 'receive' order by day, peer, kind", [credentialId])).rows as Row[];

/** Delivers the check `sender` sends `me` that day, a minute after its time, and guards it against any body read. */
function deliverCheck(day: string, sender: Member, me: Member, kind: "plain" | "content", labelIds: string[], f = fake) {
  const id = probeIdentity(seed(new Date(`${day}T00:00:00Z`), HASH), sender, me, kind);
  const gmailId = f.deliver({ from: `Kim <${sender.address}>`, subject: kind === "plain" ? id.subject : contentSubject(STEP, id), text: "a check", labelIds, at: id.expectedAt.getTime() + 60_000 });
  f.guard(gmailId);
  return { gmailId, id };
}
/** Placement searches Gmail was asked for, by the subject text each looked for. */
const searchedFor = (text: string) => fake.urls.some((u) => u.startsWith("GET /messages?") && decodeURIComponent(u.replaceAll("+", " ")).includes(` subject:"${text}"`));

const KIM = member("kim@circle.google.test");
const LEE = member("lee@circle.google.test");
const SAM = member("sam@circle.google.test");
const ROB = member("rob@circle.google.test");

// Block.

test("nothing is expected on the cloud, off the list, or where the provider can't read checks; on the cloud nothing is read", async () => {
  at("2026-11-16T06:00:00Z");
  const r = await receiver();
  deployment.value = "cloud";
  expect(await readingWith([r.me, KIM]).plan(r.W, r.id)).toEqual({ ok: false, reason: "not_available" });
  expect(await readingWith([r.me, KIM]).readDue(r.W)).toBe(0);
  deployment.value = "self_host";
  expect(await readingWith([KIM, LEE]).plan(r.W, r.id)).toEqual({ ok: false, reason: "not_listed" });
  // A provider that can't read checks by their labels expects none.
  expect(await readingWith([r.me, KIM], { canRead: false }).plan(r.W, r.id)).toEqual({ ok: false, reason: "provider_cannot_send" });
  expect(await rowsOf(r.id)).toEqual([]);
});

test("a content check from a member listed 27 days ago is never read, never kept from the poll, and is ordinary mail", async () => {
  at("2026-11-16T06:00:00Z");
  const r = await receiver();
  const newbie = member("new@circle.google.test", { listed_at: "2026-10-20", founder_controlled: false });
  const reading = readingWith([r.me, newbie]);
  expect(await reading.plan(r.W, r.id)).toEqual({ ok: true, planned: 2 });
  const rows = await rowsOf(r.id);
  expect(rows.map((x) => [x.kind, x.skip_reason])).toEqual([
    ["content", "new_member"],
    ["plain", null],
  ]);
  const { id } = deliverCheck("2026-11-16", newbie, r.me, "content", ["INBOX"]);
  at("2026-11-16T19:30:00Z");
  await reading.readDue(r.W);
  expect((await rowsOf(r.id)).find((x) => x.kind === "content")).toMatchObject({ verdict: null, skip_reason: "new_member" });
  expect(searchedFor(id.subject)).toBe(false);
  expect((await skipFor(r.W, r.id, clock.at)).map((s) => s.subject)).toEqual([rows.find((x) => x.kind === "plain")!.subject]);
  const e = inbound(r, newbie.address, contentSubject(STEP, id), id.expectedAt);
  expect(await inWorkspace(r.W, (tx) => matchExpected(tx, e))).toBe(false);
});

test("a third content check from one sender in a week is never read, and stays ordinary mail", async () => {
  const r = await receiver();
  const reading = readingWith([r.me, KIM]);
  const days = ["2026-11-23", "2026-11-24", "2026-11-25"];
  for (const day of days) {
    at(`${day}T06:00:00Z`);
    await reading.plan(r.W, r.id);
    deliverCheck(day, KIM, r.me, "content", ["SPAM"]);
    at(`${day}T19:30:00Z`);
    await reading.readDue(r.W);
  }
  const content = (await rowsOf(r.id)).filter((x) => x.kind === "content");
  expect(content.map((x) => [x.day, x.verdict, x.skip_reason])).toEqual([
    ["2026-11-23", "spam", null],
    ["2026-11-24", "spam", null],
    ["2026-11-25", null, "content_week_cap"],
  ]);
  expect(searchedFor(content[2]!.subject!)).toBe(false);
  // The next week starts a new count.
  at("2026-11-30T06:00:00Z");
  await reading.plan(r.W, r.id);
  expect((await skipFor(r.W, r.id, new Date("2026-11-30T18:00:00Z"))).some((s) => s.subject === (content[2]!.subject as string))).toBe(false);
  expect((await rowsOf(r.id)).filter((x) => x.day === "2026-11-30" && x.kind === "content")).toMatchObject([{ skip_reason: null }]);
  expect(fake.bodyReads).toEqual([]);
});

test("archiving is refused for a plain check, before a verdict, and for a check in spam; an archive Action no read made is blocked", async () => {
  at("2026-12-01T06:00:00Z");
  const r = await receiver();
  const reading = readingWith([r.me, KIM, SAM]);
  await reading.plan(r.W, r.id);
  const before = await rowsOf(r.id);
  const kimContent = before.find((x) => x.peer === KIM.address && x.kind === "content")!;
  expect(await reading.archive(r.W, kimContent.id)).toEqual({ ok: false, reason: "no_verdict" });
  deliverCheck("2026-12-01", KIM, r.me, "plain", ["INBOX"]);
  deliverCheck("2026-12-01", SAM, r.me, "content", ["SPAM"]);
  at("2026-12-01T19:30:00Z");
  await reading.readDue(r.W);
  const rows = await rowsOf(r.id);
  const kimPlain = rows.find((x) => x.peer === KIM.address && x.kind === "plain")!;
  const samContent = rows.find((x) => x.peer === SAM.address && x.kind === "content")!;
  expect(kimPlain.verdict).toBe("primary");
  expect(await reading.archive(r.W, kimPlain.id)).toEqual({ ok: false, reason: "not_content" });
  expect(samContent).toMatchObject({ verdict: "spam", archive_action_id: null });
  expect(await reading.archive(r.W, samContent.id)).toEqual({ ok: false, reason: "in_spam" });
  // A missing content check has nothing to archive.
  expect(await reading.archive(r.W, rows.find((x) => x.peer === KIM.address && x.kind === "content")!.id)).toEqual({ ok: false, reason: "not_in_inbox" });

  // An archive Action made outside the read, for the plain check, is blocked at claim.
  const b = (await placement.binding(r.W, r.id))!;
  const { spec } = await plugins.prepare(r.W, ARCHIVE, { messageId: kimPlain.message_id });
  const { action } = await ledger.createAction(r.W, { idempotencyKey: crypto.randomUUID(), capability: ARCHIVE, dedupe: "blind", spec, credentialId: r.id, actor: { system: "placement" } });
  await ledger.submitForApproval(r.W, action.id, { system: "placement" });
  expect((await ledger.approve(r.W, action.id, { approverId: b.approverId, draftVersion: 1, snapshot: b.snapshot })).ok).toBe(true);
  const modifies = fake.modifies.length;
  await ledger.run(r.W, action.id);
  expect(await ledger.getAction(r.W, action.id)).toMatchObject({ state: "blocked", blockReason: "placement_not_archivable" });
  expect(fake.modifies.length).toBe(modifies);
});

// Allow.

test("each label set maps to its verdict, read two hours after its time by labels and Message-ID only", async () => {
  at("2026-12-02T06:00:00Z");
  const r = await receiver();
  const reading = readingWith([r.me, KIM, LEE, SAM, ROB]);
  expect(await reading.plan(r.W, r.id)).toEqual({ ok: true, planned: 8 });
  // Planned rows carry the subject and time each sender computes for its check.
  const s = seed(new Date("2026-12-02T00:00:00Z"), HASH);
  for (const x of await rowsOf(r.id)) {
    const id = probeIdentity(s, [KIM, LEE, SAM, ROB].find((m) => m.address === x.peer)!, r.me, x.kind as "plain" | "content");
    expect([x.subject, new Date(x.expected_at)]).toEqual([id.subject, id.expectedAt]);
  }
  deliverCheck("2026-12-02", KIM, r.me, "plain", ["INBOX", "UNREAD", "CATEGORY_PERSONAL"]);
  deliverCheck("2026-12-02", LEE, r.me, "plain", ["INBOX", "UNREAD", "CATEGORY_PROMOTIONS"]);
  deliverCheck("2026-12-02", SAM, r.me, "plain", ["SPAM", "UNREAD"]);
  // In neither the inbox nor spam: missing, though Gmail still has it.
  deliverCheck("2026-12-02", ROB, r.me, "plain", ["TRASH"]);
  // Not yet two hours after any of them.
  at("2026-12-02T09:00:00Z");
  expect(await reading.readDue(r.W)).toBe(0);
  at("2026-12-02T19:30:00Z");
  expect(await reading.readDue(r.W)).toBe(8);
  const verdicts = Object.fromEntries((await rowsOf(r.id)).filter((x) => x.kind === "plain").map((x) => [x.peer, [x.verdict, x.message_id !== null]]));
  expect(verdicts).toEqual({ [KIM.address]: ["primary", true], [LEE.address]: ["other_tab", true], [SAM.address]: ["spam", true], [ROB.address]: ["missing", true] });
  expect((await rowsOf(r.id)).filter((x) => x.kind === "content").map((x) => x.verdict)).toEqual(["missing", "missing", "missing", "missing"]);
  expect(fake.bodyReads).toEqual([]);
  // A second pass reads nothing again.
  expect(await reading.readDue(r.W)).toBe(0);
});

test("a query error is recorded as query_failure, not missing", async () => {
  at("2026-12-03T06:00:00Z");
  const r = await receiver();
  const reading = readingWith([r.me, KIM]);
  await reading.plan(r.W, r.id);
  const first = (await rowsOf(r.id)).sort((a, b) => a.expected_at.getTime() - b.expected_at.getTime())[0]!;
  at("2026-12-03T19:30:00Z");
  fake.failNext("list", 500);
  await reading.readDue(r.W);
  expect((await rowsOf(r.id)).find((x) => x.id === first.id)).toMatchObject({ verdict: "query_failure" });
  expect((await rowsOf(r.id)).find((x) => x.id !== first.id)).toMatchObject({ verdict: "missing" });
});

test("a content check in the inbox is archived once: INBOX off, nothing added, through its own Action", async () => {
  at("2026-12-04T06:00:00Z");
  const r = await receiver();
  const reading = readingWith([r.me, KIM]);
  await reading.plan(r.W, r.id);
  const { gmailId } = deliverCheck("2026-12-04", KIM, r.me, "content", ["INBOX", "UNREAD", "CATEGORY_PROMOTIONS"]);
  at("2026-12-04T19:30:00Z");
  await reading.readDue(r.W);
  const row = (await rowsOf(r.id)).find((x) => x.kind === "content")!;
  expect(row).toMatchObject({ verdict: "other_tab", archive_action_id: expect.any(String) });
  expect(await ledger.getAction(r.W, row.archive_action_id!)).toMatchObject({ state: "scheduled", capability: ARCHIVE });
  await ledger.run(r.W, row.archive_action_id!);
  expect(await ledger.getAction(r.W, row.archive_action_id!)).toMatchObject({ state: "sent" });
  expect(fake.labelsOf(gmailId)).toEqual(["UNREAD", "CATEGORY_PROMOTIONS"]);
  expect(await reading.archive(r.W, row.id)).toEqual({ ok: true, actionId: row.archive_action_id });
  await ledger.run(r.W, row.archive_action_id!);
  expect(fake.modifies.filter((m) => m.id === gmailId)).toEqual([{ id: gmailId, add: [], remove: ["INBOX"], before: ["INBOX", "UNREAD", "CATEGORY_PROMOTIONS"] }]);
  expect(fake.modifies.every((m) => !m.add.includes("INBOX") && !m.before.includes("SPAM"))).toBe(true);
  expect(fake.bodyReads).toEqual([]);
});

/** An inbound mail event as the reply poll hands it over. */
function inbound(r: { W: string; id: string }, from: string, subject: string, sent: Date): CatalogueEvent<"email.received"> {
  return {
    workspaceId: r.W,
    pluginId: GMAIL,
    trigger: EMAIL_RECEIVED,
    credentialId: r.id,
    eventId: crypto.randomUUID(),
    data: { kind: "message", headers: { from: `Kim <${from}>`, to: "", cc: "", subject, date: sent.toUTCString(), messageId: "<x@y>", inReplyTo: "", references: "" }, text: "a check", dsn: null, autoSubmitted: "" },
  };
}

test("the reply poll never fetches an expected check, and routing claims one that reaches it anyway", async () => {
  at("2026-12-07T06:00:00Z");
  const r = await receiver();
  const reading = readingWith([r.me, KIM]);
  await reading.plan(r.W, r.id);
  const own = startFakeGmail();
  afterAll(() => own.stop());
  const handed: TriggerEvent[] = [];
  const host = loadPlugins({
    sources: [{ mode: "in_process", plugin: createGmailPlugin({ baseUrl: own.url, timeoutMs: 1000, now: () => clock.at.getTime() }) }],
    credentials: async () => ({ accessToken: own.token, expiresAt: "" }),
    confinement: "none",
    log: () => {},
    // As the worker wires it.
    skipMail: async (ws, credentialId, trigger) => (trigger === EMAIL_RECEIVED ? skipFor(ws, credentialId, clock.at) : []),
    onEvent: async (tx, e) => {
      if (e.custom || !(await routePlacement(tx, e, matchExpected))) handed.push(e);
    },
  });
  const { gmailId, id } = deliverCheck("2026-12-07", KIM, r.me, "plain", ["INBOX", "UNREAD"], own);
  const reply = own.deliver({ from: KIM.address, subject: "Re: invoice", text: "A real reply", labelIds: ["INBOX"], at: id.expectedAt.getTime() });
  clock.at = new Date(id.expectedAt.getTime() + 5 * 60_000);
  expect(await host.runPoll({ workspaceId: r.W, pluginId: GMAIL, trigger: EMAIL_RECEIVED, credentialId: r.id })).toBe("handed_off");
  expect(handed.map((e) => e.eventId)).toEqual([reply]);
  expect(own.bodyReads).toEqual([]);
  expect(own.urls.some((u) => u.startsWith(`GET /messages/${gmailId}`))).toBe(false);

  // Seen anyway, say before the day was planned: claimed by its sender, subject and window.
  const yes = (e: CatalogueEvent<"email.received">) => inWorkspace(r.W, (tx) => matchExpected(tx, e));
  expect(await yes(inbound(r, KIM.address, `Re: ${id.subject}`, id.expectedAt))).toBe(true);
  expect(await yes(inbound(r, KIM.address, id.subject, new Date(id.expectedAt.getTime() + 2 * 3_600_000)))).toBe(false);
  expect(await yes(inbound(r, LEE.address, id.subject, id.expectedAt))).toBe(false);
  // The planner picks each check's time, and mail carrying the content check's tag inside that check's
  // own window rightly matches it. Six hours apart, the plain subject with the tag can only be read
  // against the plain check, whose notSubject refuses it.
  await db.query("update placement_probes set expected_at = $1 where credential_id = $2 and direction = 'receive' and kind = 'content'", [new Date(id.expectedAt.getTime() + 6 * 3_600_000), r.id]);
  const tag = (await rowsOf(r.id)).find((x) => x.kind === "content")!.subject!;
  expect(await yes(inbound(r, KIM.address, `${id.subject} (${tag})`, id.expectedAt))).toBe(false);
  expect(await yes(inbound(r, KIM.address, `${STEP} (${tag})`, (await rowsOf(r.id)).find((x) => x.kind === "content")!.expected_at))).toBe(true);
});
