// SPDX-License-Identifier: AGPL-3.0-only
// Placement reports. A receiving Mailbox sends each sender one report a day through the Dispatcher and
// the Gmail plugin, its entries signed with its member key, and keeps which checks each report carried.
// On the sender's side a report is claimed before reply intake, and an entry counts only on Google's
// DKIM pass for the From domain, from the listed receiver, under that receiver's key, for a check this
// Mailbox sent and read back, not skipped, once. Nothing logs an address.
import { generateKeyPairSync, sign, type KeyObject } from "node:crypto";
import { createGmailPlugin } from "@direx/extensions";
import { startFakeGmail } from "@direx/extensions/gmail/fake";
import { afterAll, expect, test, vi } from "vitest";
import { ownerClient } from "../../../../../test/db";
import { createVault, credentialLabel, credentialReady, rootKeyFromEnv } from "../credentials/index";
import { approverMayApprove, workspaceLive } from "../identity/index";
import { testIdentity } from "../identity/test-auth";
import { testLedger } from "../ledger/test-effects";
import type { Deployment } from "../models/index";
import { outreachFloors } from "../outreach/index";
import { EMAIL_RECEIVED, loadPlugins, type CatalogueEvent, type TriggerEvent } from "../plugins/index";
import { mailboxDayCheck, touchCheck } from "../schedule/index";
import { inWorkspace, insertGrant, insertProbe, saveListState } from "./adapters/repo";
import type { Member } from "./domain/list";
import {
  createPlacement,
  createReading,
  createReporting,
  dkimPasses,
  isPlacementCapability,
  matchExpected,
  parseReport,
  PLACEMENT_WORDING_VERSION,
  placementGranted,
  placementGrantVersion,
  placementSendCheck,
  probeIdentity,
  REPORT_SUBJECT,
  reportSigned,
  reportText,
  routePlacement,
  seed,
  type ReportEntry,
  type TrustedList,
} from "./index";
import { verifySignature } from "./application/list";

const GMAIL = "com.trydirex.gmail";
const REPORT = `${GMAIL}/placement.report`;
const SEND = `${GMAIL}/placement.send`;
const READ = `${GMAIL}/placement.read`;
const HASH = "c".repeat(64);

const fake = startFakeGmail();
afterAll(() => fake.stop());
const hostLog: unknown[][] = [];
const plugins = loadPlugins({
  sources: [{ mode: "in_process", plugin: createGmailPlugin({ baseUrl: fake.url, timeoutMs: 1000 }) }],
  credentials: async () => ({ accessToken: fake.token, expiresAt: "" }),
  confinement: "none",
  log: (...a: unknown[]) => void hostLog.push(a),
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
const db = await ownerClient();
afterAll(() => db.end());
const q = async (text: string, params: unknown[] = []) => (await db.query(text, params)).rows;

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
const keyPair = () => {
  const p = generateKeyPairSync("ed25519");
  return { key: p.publicKey.export({ format: "jwk" }).x!, priv: p.privateKey };
};
const ar = (domain: string, result = "pass") => `mx.google.com; dkim=${result} header.i=@${domain} header.s=google header.b=abc; spf=pass (google.com: domain of x) smtp.mailfrom=x@${domain}`;

/** A Workspace with one Mailbox that has a live yes, its address as given or a fresh one. */
async function mailbox(address = `${crypto.randomUUID().slice(0, 8)}@acme.google.test`) {
  const cookie = await signIn();
  const W = (await createOrg(cookie)).workspace.id;
  const ownerId = ((await (await call("/api/me", cookie)).json()) as { user: { id: string } }).user.id;
  const r = await vault.create({ workspaceId: W, actorUserId: ownerId, scope: "workspace", kind: "api_key", key: address, connection: "google", name: "Mailbox", meta: {}, value: { key: "x" } });
  if (!r.ok) throw new Error(r.reason);
  await inWorkspace(W, (tx) => insertGrant(tx, { workspaceId: W, credentialId: r.credential.id, answer: "yes", wordingVersion: PLACEMENT_WORDING_VERSION, answeredBy: ownerId, answeredAt: clock.at }));
  return { W, id: r.credential.id, address };
}

// The sender's side.

const REX = "rex@circle.google.test";
const LEE = "lee@circle.google.test";
const rex = keyPair();
const lee = keyPair();
const DAY = "2026-12-08";

/** A sending Mailbox whose Workspace trusts a list naming it, REX and LEE with their keys. */
async function senderWorld() {
  const s = await mailbox();
  const list = listOf([member(s.address), member(REX, { key: rex.key }), member(LEE, { key: lee.key })]);
  await inWorkspace(s.W, (tx) => saveListState(tx, { workspaceId: s.W, ...list, trustedAt: clock.at }));
  /** A check this Mailbox sent `peer`, read back under `messageId`, or skipped. */
  const sent = async (peer: string, kind: "plain" | "content", messageId: string, skipReason: string | null = null, state = "sent") => {
    const { action } = await ledger.createAction(s.W, { idempotencyKey: crypto.randomUUID(), capability: SEND, dedupe: "blind", spec: { to: [peer] }, credentialId: s.id, actor: { system: "placement" } });
    await q("update actions set correlation_key = $1, state = $2 where id = $3", [messageId, state, action.id]);
    return inWorkspace(s.W, (tx) =>
      insertProbe(tx, { workspaceId: s.W, credentialId: s.id, direction: "send", day: DAY, listVersion: 3, kind, seq: kind === "plain" ? 0 : 1, peer, expectedAt: new Date(`${DAY}T10:00:00Z`), actionId: action.id, skipReason, createdAt: clock.at }),
    );
  };
  const reported = async (rowId: string) => (await q("select reported_verdict, reported_at, message_id from placement_probes where id = $1", [rowId]))[0] as { reported_verdict: string | null; reported_at: Date | null; message_id: string | null };
  return { ...s, sent, reported };
}

/** One signed entry, as `signer` signs it, from `receiver` to `sender`. */
function entry(signer: KeyObject, sender: string, receiver: string, e: { message_id: string | null; verdict?: string; day?: string; kind?: string }): ReportEntry {
  const fields = { list_version: 3, day: e.day ?? DAY, sender, receiver, kind: e.kind ?? "plain", message_id: e.message_id, verdict: e.verdict ?? "primary" };
  return { list_version: fields.list_version, day: fields.day, kind: fields.kind, message_id: fields.message_id, verdict: fields.verdict, sig: sign(null, Buffer.from(reportSigned(fields)), signer).toString("base64url") };
}

/** The report mail as the reply poll hands it over. */
function reportMail(w: { W: string; id: string }, from: string, text: string, authenticationResults = ar(from.slice(from.indexOf("@") + 1))): CatalogueEvent<"email.received"> {
  return {
    workspaceId: w.W,
    pluginId: GMAIL,
    trigger: EMAIL_RECEIVED,
    credentialId: w.id,
    eventId: crypto.randomUUID(),
    data: { kind: "message", headers: { from: `Rex <${from}>`, to: "", cc: "", subject: REPORT_SUBJECT, date: clock.at.toUTCString(), messageId: "<r@x>", inReplyTo: "", references: "", authenticationResults }, text, dsn: null, autoSubmitted: "" },
  };
}
const route = (w: { W: string }, e: CatalogueEvent) => inWorkspace(w.W, (tx) => routePlacement(tx, e, matchExpected, clock.at));

// Block.

test("a bad signature, another member's key, an unknown check, a skipped check or a check never found counts nothing", async () => {
  at("2026-12-09T07:00:00Z");
  const w = await senderWorld();
  const plain = await w.sent(REX, "plain", "<p1@mail.gmail.com>");
  const skipped = await w.sent(REX, "content", "<c1@mail.gmail.com>", "unknown_outcome");
  const good = entry(rex.priv, w.address, REX, { message_id: "<p1@mail.gmail.com>" });
  const entries = [
    // Signed, then the verdict changed.
    { ...good, verdict: "spam" },
    // Signed by LEE, sent as REX.
    entry(lee.priv, w.address, REX, { message_id: "<p1@mail.gmail.com>" }),
    // No check of this Mailbox has this Message-ID.
    entry(rex.priv, w.address, REX, { message_id: "<nobody@mail.gmail.com>" }),
    // A check this Mailbox recorded as unknown, so never counted.
    entry(rex.priv, w.address, REX, { message_id: "<c1@mail.gmail.com>" }),
    // A content check REX expected but this Mailbox never sent: not found, no Message-ID.
    entry(rex.priv, w.address, REX, { message_id: null, verdict: "missing", kind: "content" }),
    // The plain check's Message-ID, signed as a content check.
    entry(rex.priv, w.address, REX, { message_id: "<p1@mail.gmail.com>", kind: "content" }),
  ];
  // Still placement mail, claimed before reply intake.
  expect(await route(w, reportMail(w, REX, reportText(w.address, REX, entries)))).toBe(true);
  expect(await w.reported(plain.id)).toMatchObject({ reported_verdict: null, reported_at: null });
  expect(await w.reported(skipped.id)).toMatchObject({ reported_verdict: null, reported_at: null });
});

test("a missing entry counts nothing for a check skipped, not yet sent, or of another day", async () => {
  at("2026-12-09T07:00:00Z");
  const w = await senderWorld();
  const skipped = await w.sent(REX, "plain", "<s1@mail.gmail.com>", "unknown_outcome");
  const unsent = await w.sent(LEE, "plain", "<s2@mail.gmail.com>", null, "scheduled");
  const missing = (receiver: string, signer: KeyObject, e: { day?: string } = {}) => entry(signer, w.address, receiver, { message_id: null, verdict: "missing", ...e });
  await route(w, reportMail(w, REX, reportText(w.address, REX, [missing(REX, rex.priv), missing(REX, rex.priv, { day: "2026-12-07" })])));
  await route(w, reportMail(w, LEE, reportText(w.address, LEE, [missing(LEE, lee.priv)])));
  expect(await w.reported(skipped.id)).toMatchObject({ reported_verdict: null });
  expect(await w.reported(unsent.id)).toMatchObject({ reported_verdict: null });
});

test("an entry other than missing without a Message-ID, or missing with one, is not a report", () => {
  for (const e of [{ message_id: null }, { message_id: null, verdict: "spam" }, { message_id: null, verdict: "query_failure" }, { message_id: "<m@x>", verdict: "missing" }]) {
    const one = entry(rex.priv, "a@b.test", "c@d.test", e);
    expect(() => reportText("a@b.test", "c@d.test", [one])).toThrow();
    expect(parseReport(JSON.stringify({ format: "direx-placement-report-1", sender: "a@b.test", receiver: "c@d.test", entries: [one] }))).toBeNull();
  }
  // An entry with no kind, or another one, is not either.
  const plain = entry(rex.priv, "a@b.test", "c@d.test", { message_id: "<m@x>" });
  expect(() => reportText("a@b.test", "c@d.test", [{ ...plain, kind: "bulk" }])).toThrow();
});

test("From not the listed receiver, a DKIM fail, a DKIM pass for another domain or a header not Google's counts nothing", async () => {
  at("2026-12-09T07:00:00Z");
  const w = await senderWorld();
  const row = await w.sent(REX, "plain", "<p2@mail.gmail.com>");
  const text = reportText(w.address, REX, [entry(rex.priv, w.address, REX, { message_id: "<p2@mail.gmail.com>" })]);
  // From another listed member, or from no member at all.
  expect(await route(w, reportMail(w, LEE, text))).toBe(true);
  expect(await route(w, reportMail(w, "rex@elsewhere.test", text, ar("elsewhere.test")))).toBe(true);
  // A report naming LEE as receiver, signed and sent by LEE, about a check this Mailbox sent REX.
  expect(await route(w, reportMail(w, LEE, reportText(w.address, LEE, [entry(lee.priv, w.address, LEE, { message_id: "<p2@mail.gmail.com>" })])))).toBe(true);
  expect(await route(w, reportMail(w, REX, text, ar("circle.google.test", "fail")))).toBe(true);
  expect(await route(w, reportMail(w, REX, text, ar("gappssmtp.com")))).toBe(true);
  expect(await route(w, reportMail(w, REX, text, `spoof.example; dkim=pass header.i=@circle.google.test`))).toBe(true);
  expect(await route(w, reportMail(w, REX, text, ""))).toBe(true);
  // To another Mailbox than the one it names as sender.
  expect(await route(w, reportMail(w, REX, reportText(LEE, REX, [entry(rex.priv, LEE, REX, { message_id: "<p2@mail.gmail.com>" })])))).toBe(true);
  expect(await w.reported(row.id)).toMatchObject({ reported_verdict: null, reported_at: null });
});

test("Google's DKIM verdict is read for exactly the From domain", () => {
  expect(dkimPasses("mx.google.com;\r\n       dkim=pass header.i=@acme.test header.s=g header.b=x;\r\n       spf=pass", "acme.test")).toBe(true);
  expect(dkimPasses("mx.google.com; dkim=pass header.d=acme.test", "acme.test")).toBe(true);
  expect(dkimPasses("mx.google.com; dkim=pass header.i=@sub.acme.test", "acme.test")).toBe(false);
  expect(dkimPasses("mx.google.com; dkim=neutral (body hash did not verify) header.i=@acme.test", "acme.test")).toBe(false);
  expect(dkimPasses("mx.google.com; spf=pass smtp.mailfrom=acme.test", "acme.test")).toBe(false);
  expect(dkimPasses(undefined, "acme.test")).toBe(false);
});

test("a body that is not exactly a report is not one", () => {
  const text = reportText("a@b.test", "c@d.test", [entry(rex.priv, "a@b.test", "c@d.test", { message_id: "<m@x>" })]);
  expect(parseReport(text)).not.toBeNull();
  expect(parseReport(`${text} `)).not.toBeNull();
  expect(parseReport(text.replace("}]", ',"note":"hi"}]'))).toBeNull();
  expect(parseReport(text.replace('"<m@x>"', '["<m@x>"]'))).toBeNull();
  expect(parseReport(`Thanks!\n${text}`)).toBeNull();
  expect(parseReport("{}")).toBeNull();
});

// Allow.

test("a good report sets the reported verdict once, however often it arrives", async () => {
  at("2026-12-09T07:00:00Z");
  const w = await senderWorld();
  const plain = await w.sent(REX, "plain", "<p3@mail.gmail.com>");
  const content = await w.sent(REX, "content", "<c3@mail.gmail.com>");
  const first = entry(rex.priv, w.address, REX, { message_id: "<p3@mail.gmail.com>", verdict: "other_tab" });
  const text = reportText(w.address, REX, [first, first, entry(rex.priv, w.address, REX, { message_id: "<c3@mail.gmail.com>", verdict: "spam", kind: "content" })]);
  expect(await route(w, reportMail(w, REX, text))).toBe(true);
  expect(await w.reported(plain.id)).toEqual({ reported_verdict: "other_tab", reported_at: clock.at, message_id: "<p3@mail.gmail.com>" });
  expect(await w.reported(content.id)).toMatchObject({ reported_verdict: "spam" });
  // The same report again, later, and a different verdict for the same check: neither changes it.
  const firstAt = clock.at;
  at("2026-12-09T08:00:00Z");
  await route(w, reportMail(w, REX, text));
  await route(w, reportMail(w, REX, reportText(w.address, REX, [entry(rex.priv, w.address, REX, { message_id: "<p3@mail.gmail.com>", verdict: "spam" })])));
  expect(await w.reported(plain.id)).toEqual({ reported_verdict: "other_tab", reported_at: firstAt, message_id: "<p3@mail.gmail.com>" });
});

test("a missing entry counts once on the plain check this Mailbox sent that receiver that day", async () => {
  at("2026-12-09T07:00:00Z");
  const w = await senderWorld();
  const plain = await w.sent(REX, "plain", "<p4@mail.gmail.com>");
  const content = await w.sent(REX, "content", "<c4@mail.gmail.com>");
  const missing = entry(rex.priv, w.address, REX, { message_id: null, verdict: "missing" });
  expect(await route(w, reportMail(w, REX, reportText(w.address, REX, [missing, missing])))).toBe(true);
  // The Message-ID stays unknown: nothing was seen to read it from.
  expect(await w.reported(plain.id)).toEqual({ reported_verdict: "missing", reported_at: clock.at, message_id: null });
  expect(await w.reported(content.id)).toMatchObject({ reported_verdict: null });
  const firstAt = clock.at;
  at("2026-12-09T08:00:00Z");
  await route(w, reportMail(w, REX, reportText(w.address, REX, [missing, entry(rex.priv, w.address, REX, { message_id: "<p4@mail.gmail.com>", verdict: "primary" })])));
  expect(await w.reported(plain.id)).toEqual({ reported_verdict: "missing", reported_at: firstAt, message_id: null });
});

// Both sides, through Gmail.

test("a receiver reports what it read once a day, keeps what it sent, and the sender counts it without reply intake or a logged address", async () => {
  const logged = (["log", "info", "warn", "error", "debug"] as const).map((m) => vi.spyOn(console, m));
  at("2026-12-10T06:00:00Z");
  const r = await mailbox();
  const KIM = await mailbox(`${crypto.randomUUID().slice(0, 8)}@circle.google.test`);
  const members = [member(r.address), member(KIM.address)];
  const reading = createReading({
    placement,
    ledger: () => ledger,
    readFor: async () => READ,
    archiveFor: async () => undefined,
    query: (ws, capability, input, credentialId) => plugins.query(ws, capability, input, credentialId),
    deployment: () => deployment.value,
    trust: async () => ({ ok: true, trusted: listOf(members) }),
    now: () => clock.at,
  });
  const reporting = createReporting({
    placement,
    ledger: () => ledger,
    reportFor: async () => ({ id: REPORT, dedupe: "blind", prepare: (ws, input) => plugins.prepare(ws, REPORT, input) }),
    memberKeys: () => vault.memberKeys,
    deployment: () => deployment.value,
    trust: async () => ({ ok: true, trusted: listOf(members) }),
    now: () => clock.at,
  });

  // The receiver expects KIM's plain and content checks; only the plain one ever arrives.
  expect(await reading.plan(r.W, r.id)).toEqual({ ok: true, planned: 2 });
  const id = probeIdentity(seed(clock.at, HASH), members[1]!, members[0]!, "plain");
  fake.deliver({ from: `Kim <${KIM.address}>`, subject: id.subject, text: "a check", labelIds: ["INBOX", "CATEGORY_PERSONAL"], at: id.expectedAt.getTime() + 60_000 });
  at("2026-12-10T19:30:00Z");
  expect(await reading.readDue(r.W)).toBe(2);
  const read = await q("select id, kind, verdict, message_id from placement_probes where credential_id = $1 order by kind", [r.id]);
  expect(read.map((x) => [x.kind, x.verdict])).toEqual([
    ["content", "missing"],
    ["plain", "primary"],
  ]);

  // Nothing before a yes; then one report the next morning, and none again that day.
  at("2026-12-11T06:00:00Z");
  deployment.value = "cloud";
  expect(await reporting.daily(r.W, r.id)).toEqual({ ok: false, reason: "not_available" });
  deployment.value = "self_host";
  expect(await reporting.daily(r.W, r.id)).toEqual({ ok: true, made: 1 });
  expect(await reporting.daily(r.W, r.id)).toEqual({ ok: true, made: 0 });
  // What the receiver sent stays visible: each read check names its report, which says to whom and when.
  const sentReports = await q("select p.peer, p.day::text, p.verdict, a.capability, a.spec from placement_probes p join actions a on a.id = p.report_action_id where p.credential_id = $1 order by p.kind", [r.id]);
  expect(sentReports.map((x) => [x.peer, x.day, x.verdict, x.capability])).toEqual([
    [KIM.address, "2026-12-10", "missing", REPORT],
    [KIM.address, "2026-12-10", "primary", REPORT],
  ]);
  const spec = sentReports[0]!.spec as { to: string[]; subject: string; text: string };
  expect([spec.to, spec.subject]).toEqual([[KIM.address], REPORT_SUBJECT]);
  const report = parseReport(spec.text)!;
  // Nothing from the mailbox but each check's verdict and the Message-ID it saw.
  expect(Object.keys(report).sort()).toEqual(["entries", "format", "receiver", "sender"]);
  expect(report.entries.map((e) => Object.keys(e).sort())).toEqual([0, 1].map(() => ["day", "kind", "list_version", "message_id", "sig", "verdict"]));
  const publicKey = await vault.memberKeys.publicKey(r.W, r.id);
  for (const e of report.entries) expect(verifySignature(publicKey, reportSigned({ ...e, sender: KIM.address, receiver: r.address }), e.sig)).toBe(true);

  // It goes out with no Touch and no X-Direx-Action.
  const actionId = (await q("select distinct report_action_id from placement_probes where credential_id = $1", [r.id]))[0]!.report_action_id as string;
  await ledger.run(r.W, actionId);
  expect(await ledger.getAction(r.W, actionId)).toMatchObject({ state: "sent" });
  expect(Buffer.from(fake.sent.at(-1)!.raw, "base64url").toString()).not.toMatch(/X-Direx-Action/i);

  // KIM's Mailbox sent the plain check, read back under the Message-ID the receiver saw, and never the content one.
  const plainId = read.find((x) => x.kind === "plain")!.message_id as string;
  const { action } = await ledger.createAction(KIM.W, { idempotencyKey: crypto.randomUUID(), capability: SEND, dedupe: "blind", spec: { to: [r.address] }, credentialId: KIM.id, actor: { system: "placement" } });
  await q("update actions set correlation_key = $1 where id = $2", [plainId, action.id]);
  const kimRow = await inWorkspace(KIM.W, (tx) =>
    insertProbe(tx, { workspaceId: KIM.W, credentialId: KIM.id, direction: "send", day: "2026-12-10", listVersion: 3, kind: "plain", seq: 0, peer: r.address, expectedAt: id.expectedAt, actionId: action.id, createdAt: clock.at }),
  );
  await inWorkspace(KIM.W, (tx) => saveListState(tx, { workspaceId: KIM.W, ...listOf([member(KIM.address), member(r.address, { key: publicKey })]), trustedAt: clock.at }));

  // KIM's reply poll reads the report like any mail, and routing claims it before reply intake.
  const kimGmail = startFakeGmail();
  afterAll(() => kimGmail.stop());
  kimGmail.deliver({ from: `Dana <${r.address}>`, subject: REPORT_SUBJECT, text: spec.text, headers: { "Authentication-Results": ar("acme.google.test") }, at: clock.at.getTime() });
  const handed: TriggerEvent[] = [];
  const host = loadPlugins({
    sources: [{ mode: "in_process", plugin: createGmailPlugin({ baseUrl: kimGmail.url, timeoutMs: 1000, now: () => clock.at.getTime() }) }],
    credentials: async () => ({ accessToken: kimGmail.token, expiresAt: "" }),
    confinement: "none",
    log: (...a: unknown[]) => void hostLog.push(a),
    // As the worker wires it.
    onEvent: async (tx, e) => {
      if (e.custom || !(await routePlacement(tx, e, matchExpected, clock.at))) handed.push(e);
    },
  });
  expect(await host.runPoll({ workspaceId: KIM.W, pluginId: GMAIL, trigger: EMAIL_RECEIVED, credentialId: KIM.id })).toBe("handed_off");
  expect(handed).toEqual([]);
  expect((await q("select reported_verdict from placement_probes where id = $1", [kimRow.id]))[0]).toEqual({ reported_verdict: "primary" });

  // No log line, of the console or the plugin host, carries an address.
  const lines = JSON.stringify([...logged.flatMap((s) => s.mock.calls), ...hostLog]);
  for (const a of [r.address, KIM.address, "@circle.google.test", "@acme.google.test"]) expect(lines).not.toContain(a);
  for (const s of logged) s.mockRestore();
});
