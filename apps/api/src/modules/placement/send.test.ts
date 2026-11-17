// SPDX-License-Identifier: AGPL-3.0-only
// Sending Placement checks, through the daily job, the Dispatcher and the Gmail plugin against the
// fake Gmail. Checks are made only for a Mailbox with a live yes that is on a trusted list, on a
// self-hosted install; each goes out at its time without X-Direx-Action, under the daily cap, never
// to a suppressed address, never as a content check to another member without a yes, and never
// late. A sending-limit refusal stops placement for the Mailbox.
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
import { loadPlugins } from "../plugins/index";
import { mailboxDayCheck, mailboxDays, touchCheck } from "../schedule/index";
import { currentGrant, inWorkspace, insertGrant, insertProbe, stopGrant } from "./adapters/repo";
import type { Member } from "./domain/list";
import {
  contentSubject,
  contentTestVersion,
  createContentTests,
  createPlacement,
  createSending,
  DAILY_CAP,
  isPlacementCapability,
  PLACEMENT_WORDING_VERSION,
  placementGranted,
  placementGrantVersion,
  placementSendCheck,
  probeIdentity,
  seed,
  stopOnAccountLimit,
  type TrustedList,
} from "./index";

const SEND = "com.trydirex.gmail/placement.send";
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
  resolvers: { credential: credentialLabel, placement_grant: placementGrantVersion, placement_content_test: contentTestVersion },
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
  onAccountLimit: (tx, action, limit) => stopOnAccountLimit(() => clock.at)(tx, action, limit),
});
const placement = createPlacement({ ledger: () => ledger, deployment: () => deployment.value, now: () => clock.at });
const contentTests = createContentTests({ deployment: () => deployment.value, now: () => clock.at });
const vault = createVault({ rootKey: rootKeyFromEnv({ DIREX_MASTER_KEY: "11".repeat(32) })!, now: () => clock.at });

const { call, signIn, createOrg } = testIdentity();
const ownerCookie = await signIn();
const W = (await createOrg(ownerCookie)).workspace.id;
const ownerId = ((await (await call("/api/me", ownerCookie)).json()) as { user: { id: string } }).user.id;
const db = await ownerClient();
afterAll(() => db.end());
const q = async (text: string, params: unknown[] = []) => (await db.query(text, params)).rows;

// The sender's footer, and a Campaign whose template step A has a yes for the member RECEIVER.
await q("insert into outreach_settings (workspace_id, sender_name, postal_address, updated_at) values ($1, 'Dana', '1 Main St, Springfield', now())", [W]);
const C = crypto.randomUUID();
await db.query("begin");
await db.query("set local session_replication_role = replica");
await db.query("insert into campaigns (id, workspace_id, plan_id, owner_user_id, created_at, updated_at) values ($1, $2, $3, $4, now(), now())", [C, W, crypto.randomUUID(), ownerId]);
await db.query("insert into campaign_steps (workspace_id, campaign_id, step_key, type, drafting_mode, template, updated_at) values ($1, $2, 'a', 'email', 'template', $3::jsonb, now())", [
  W,
  C,
  JSON.stringify({ subject: "Quick idea for {{company}}", text: "Hi {{firstName}}, a short note from {{senderName}}.", citations: [], warnings: [], needsDecision: [] }),
]);
await db.query("commit");

const RECEIVER = "kim@google.test";
const NO_YES = "lee@google.test";
const ELSEWHERE = "sam@other.test";
expect((await contentTests.record(W, { userId: ownerId, role: "owner" }, { campaignId: C, stepKey: "a", receivers: [RECEIVER], wordingVersion: "2026-11-10" })).ok).toBe(true);

const resolveMx = async (domain: string) => [{ exchange: domain.endsWith("google.test") ? "aspmx.l.google.com" : `mx.${domain}`, priority: 1 }];

/** A Mailbox of this Workspace with a live yes, its address on the Google domain. */
async function mailbox(opts: { grant?: boolean } = {}) {
  const address = `${crypto.randomUUID().slice(0, 8)}@acme.google.test`;
  const r = await vault.create({ workspaceId: W, actorUserId: ownerId, scope: "workspace", kind: "api_key", key: address, connection: "google", name: "Mailbox", meta: {}, value: { key: "x" } });
  if (!r.ok) throw new Error(r.reason);
  if (opts.grant !== false) await inWorkspace(W, (tx) => insertGrant(tx, { workspaceId: W, credentialId: r.credential.id, answer: "yes", wordingVersion: PLACEMENT_WORDING_VERSION, answeredBy: ownerId, answeredAt: clock.at }));
  return { id: r.credential.id, address };
}

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
  contentHash: "c".repeat(64),
  list: { version: 3, expires: "2027-01-01T00:00:00Z", bootstrap: true, members, removed: [] },
  rootChainLength: 0,
  rootChainHash: "",
  pinnedRootHash: "",
});
/** The job, trusting a list of the sender, the given members and another Mailbox of this Workspace. */
const sendingWith = (members: Member[] | null) =>
  createSending({
    placement,
    contentTests,
    ledger: () => ledger,
    sendFor: async () => ({ id: SEND, dedupe: "blind", prepare: (ws, input) => plugins.prepare(ws, SEND, input) }),
    deployment: () => deployment.value,
    trust: async () => (members ? { ok: true, trusted: listOf(members) } : { ok: false, reason: "not_configured" }),
    resolveMx,
    now: () => clock.at,
  });

const checksOf = async (credentialId: string) =>
  (await q("select p.peer, p.kind, p.skip_reason, p.action_id, p.expected_at, a.state, a.hold_reason, a.block_reason from placement_probes p left join actions a on a.id = p.action_id where p.credential_id = $1 order by p.peer, p.kind", [credentialId])) as {
    peer: string;
    kind: string;
    skip_reason: string | null;
    action_id: string | null;
    expected_at: Date;
    state: string | null;
    hold_reason: string | null;
    block_reason: string | null;
  }[];
const actionsOf = async (credentialId: string) => (await q("select count(*)::int as n from actions where credential_id = $1", [credentialId]))[0].n as number;
const at = (iso: string) => (clock.at = new Date(iso));
const header = (i: number, name: string) => fake.sent[i]!.headers.find((h) => h.name.toLowerCase() === name.toLowerCase())?.value;

// Block.

test("nothing is made on the cloud, with no list, off the list, or without a live yes", async () => {
  at("2026-11-02T06:00:00Z");
  const m = await mailbox();
  const members = [member(m.address), member(RECEIVER)];
  deployment.value = "cloud";
  expect(await sendingWith(members).daily(W, m.id)).toEqual({ ok: false, reason: "not_available" });
  deployment.value = "self_host";
  expect(await sendingWith(null).daily(W, m.id)).toEqual({ ok: false, reason: "no_list" });
  expect(await sendingWith([member(RECEIVER), member(NO_YES)]).daily(W, m.id)).toEqual({ ok: false, reason: "not_listed" });
  const unanswered = await mailbox({ grant: false });
  expect(await sendingWith([member(unanswered.address), member(RECEIVER)]).daily(W, unanswered.id)).toEqual({ ok: false, reason: "not_granted" });
  expect(await checksOf(m.id)).toEqual([]);
  expect(await actionsOf(m.id)).toBe(0);
});

test("a plain check is made for each paired receiver on Google MX, with its library subject and window; a content check only where a yes or this Workspace's own Mailbox lets it", async () => {
  at("2026-11-02T06:00:00Z");
  const m = await mailbox();
  const own = await mailbox({ grant: false });
  const members = [member(m.address), member(RECEIVER), member(NO_YES), member(ELSEWHERE), member(own.address)];
  const job = sendingWith(members);
  expect(await job.daily(W, m.id)).toEqual({ ok: true, made: 5, skipped: 3 });
  const rows = await checksOf(m.id);
  expect(rows.map((r) => [r.peer, r.kind, r.skip_reason, r.state])).toEqual([
    [own.address, "content", null, "scheduled"],
    [own.address, "plain", null, "scheduled"],
    [RECEIVER, "content", null, "scheduled"],
    [RECEIVER, "plain", null, "scheduled"],
    [NO_YES, "content", "no_content_yes", null],
    [NO_YES, "plain", null, "scheduled"],
    [ELSEWHERE, "content", "receiver_mx", null],
    [ELSEWHERE, "plain", "receiver_mx", null],
  ]);
  // Each plain check carries the subject and time its receiver computes for it.
  const s = seed(new Date("2026-11-02T00:00:00Z"), "c".repeat(64));
  for (const r of rows.filter((r) => r.kind === "plain" && r.action_id)) {
    const id = probeIdentity(s, member(m.address), members.find((x) => x.address === r.peer)!, "plain");
    const [spec] = await q("select spec ->> 'subject' as subject from actions where id = $1", [r.action_id]);
    expect(spec.subject).toBe(id.subject);
    expect(new Date(r.expected_at)).toEqual(id.expectedAt);
  }
  // A rerun the same day makes nothing twice.
  expect(await job.daily(W, m.id)).toEqual({ ok: true, made: 0, skipped: 3 });
  expect(await actionsOf(m.id)).toBe(5);
  // Placement checks never take a place on the Mailbox's day.
  expect((await mailboxDays(W, new Date("2026-11-01T00:00:00Z"), new Date("2026-11-04T00:00:00Z"), { now: clock.at })).filter((d) => d.credentialId === m.id)).toEqual([]);
});

test("a content check to an address that opted out is blocked by the suppression floor, with no Touch", async () => {
  at("2026-11-03T06:00:00Z");
  const m = await mailbox();
  const opted = `${crypto.randomUUID().slice(0, 8)}@acme.google.test`;
  const own = await mailbox({ grant: false });
  await q("insert into suppressions (workspace_id, email, reason, created_at) values ($1, $2, 'unsubscribe', now())", [W, own.address]);
  await sendingWith([member(m.address), member(own.address), member(opted)]).daily(W, m.id);
  const [check] = (await checksOf(m.id)).filter((r) => r.peer === own.address);
  clock.at = new Date(check!.expected_at);
  await ledger.run(W, check!.action_id!);
  expect((await checksOf(m.id)).find((r) => r.peer === own.address)).toMatchObject({ state: "blocked", block_reason: "suppressed" });
});

test("a content check to another member whose approval doesn't bind a yes is held", async () => {
  at("2026-11-04T06:00:00Z");
  const m = await mailbox();
  const b = (await placement.binding(W, m.id))!;
  const { action } = await ledger.createAction(W, { idempotencyKey: crypto.randomUUID(), capability: SEND, dedupe: "blind", spec: (await plugins.prepare(W, SEND, { to: [NO_YES], subject: "Quick idea (ref 00000000)", text: "Hi" })).spec, credentialId: m.id, actor: { system: "placement" } });
  const expectedAt = new Date("2026-11-04T10:00:00Z");
  await inWorkspace(W, (tx) => insertProbe(tx, { workspaceId: W, credentialId: m.id, direction: "send", day: "2026-11-04", listVersion: 3, kind: "content", seq: 1, peer: NO_YES, expectedAt, actionId: action.id, createdAt: clock.at }));
  await ledger.submitForApproval(W, action.id, { system: "placement" });
  expect((await ledger.approve(W, action.id, { approverId: b.approverId, draftVersion: 1, snapshot: b.snapshot, dueAt: expectedAt })).ok).toBe(true);
  at("2026-11-04T10:00:00Z");
  await ledger.run(W, action.id);
  expect(await ledger.getAction(W, action.id)).toMatchObject({ state: "held", holdReason: "placement_no_content_yes" });
  // And a placement.send the daily job never planned is held too.
  const { action: stray } = await ledger.createAction(W, { idempotencyKey: crypto.randomUUID(), capability: SEND, dedupe: "blind", spec: (await plugins.prepare(W, SEND, { to: [RECEIVER], subject: "x", text: "y" })).spec, credentialId: m.id, actor: { system: "placement" } });
  await ledger.submitForApproval(W, stray.id, { system: "placement" });
  await ledger.approve(W, stray.id, { approverId: b.approverId, draftVersion: 1, snapshot: b.snapshot });
  await ledger.run(W, stray.id);
  expect(await ledger.getAction(W, stray.id)).toMatchObject({ state: "held", holdReason: "placement_unknown_check" });
  expect(fake.sent.filter((s) => s.headers.some((h) => h.value === NO_YES))).toEqual([]);
});

test("a check whose grant was stopped after it was made is held, and once 30 minutes late it is cancelled and recorded as not sent", async () => {
  at("2026-11-05T06:00:00Z");
  const m = await mailbox();
  await sendingWith([member(m.address), member(RECEIVER)]).daily(W, m.id);
  const [check] = await checksOf(m.id);
  const g = (await inWorkspace(W, (tx) => currentGrant(tx, m.id)))!;
  await inWorkspace(W, (tx) => stopGrant(tx, g.id, { stoppedBy: ownerId, stoppedAt: clock.at, stopReason: "testing" }));
  clock.at = new Date(check!.expected_at);
  await ledger.run(W, check!.action_id!);
  expect((await checksOf(m.id))[0]).toMatchObject({ state: "held", hold_reason: "snapshot_changed" });
  const sending = sendingWith([member(m.address), member(RECEIVER)]);
  await sending.cancelLate(W);
  expect((await checksOf(m.id))[0]).toMatchObject({ state: "held", skip_reason: null });
  clock.at = new Date(check!.expected_at.getTime() + 31 * 60_000);
  expect(await sending.cancelLate(W)).toBeGreaterThanOrEqual(1);
  expect((await checksOf(m.id))[0]).toMatchObject({ state: "cancelled", skip_reason: "not_sent" });
});

test("a check still unsent 30 minutes after its time is held at claim, never sent late", async () => {
  at("2026-11-06T06:00:00Z");
  const m = await mailbox();
  await sendingWith([member(m.address), member(RECEIVER)]).daily(W, m.id);
  const [check] = await checksOf(m.id);
  const before = fake.calls.send;
  clock.at = new Date(check!.expected_at.getTime() + 31 * 60_000);
  await ledger.run(W, check!.action_id!);
  expect((await checksOf(m.id))[0]).toMatchObject({ state: "held", hold_reason: "placement_too_late" });
  expect(fake.calls.send).toBe(before);
});

test("checks past the 10th of a Mailbox's day, plain or content, are refused and recorded as skipped", async () => {
  at("2026-11-09T06:00:00Z");
  const m = await mailbox();
  // Ten checks already made today, to members not in today's pairing.
  for (let i = 0; i < DAILY_CAP; i++) {
    const { action } = await ledger.createAction(W, { idempotencyKey: crypto.randomUUID(), capability: SEND, dedupe: "blind", spec: { to: [`p${i}@google.test`] }, credentialId: m.id, actor: { system: "placement" } });
    await inWorkspace(W, (tx) => insertProbe(tx, { workspaceId: W, credentialId: m.id, direction: "send", day: "2026-11-09", listVersion: 3, kind: "content", seq: 1, peer: `p${i}@google.test`, expectedAt: clock.at, actionId: action.id, createdAt: clock.at }));
  }
  // Plain and content alike count toward the cap.
  expect(await sendingWith([member(m.address), member(RECEIVER)]).daily(W, m.id)).toEqual({ ok: true, made: 0, skipped: 2 });
  expect((await checksOf(m.id)).filter((r) => r.peer === RECEIVER).map((r) => [r.kind, r.skip_reason, r.action_id])).toEqual([
    ["content", "daily_cap", null],
    ["plain", "daily_cap", null],
  ]);
});

// Allow, then a sending-limit refusal.

test("a check goes out at its time without X-Direx-Action, with the subject the receiver expects and Gmail's Message-ID as its key; a sending-limit refusal then stops placement for the Mailbox", async () => {
  at("2026-11-10T06:00:00Z");
  const m = await mailbox();
  const members = [member(m.address), member(RECEIVER)];
  await sendingWith(members).daily(W, m.id);
  const [check] = await checksOf(m.id);
  clock.at = new Date(check!.expected_at);
  const first = fake.sent.length;
  await ledger.run(W, check!.action_id!);
  const sent = await ledger.getAction(W, check!.action_id!);
  expect(sent).toMatchObject({ state: "sent" });
  expect(sent!.correlationKey).toMatch(/^<gmail-\d+@mail\.gmail\.com>$/);
  expect(header(first, "X-Direx-Action")).toBeUndefined();
  expect(header(first, "To")).toBe(RECEIVER);
  const id = probeIdentity(seed(new Date("2026-11-10T00:00:00Z"), "c".repeat(64)), member(m.address), member(RECEIVER), "content");
  expect(header(first, "Subject")).toBe(contentSubject("Quick idea for Example Ltd", id));
  expect(id.expectedAt).toEqual(check!.expected_at);

  // The next day's check meets Gmail's sending limit: the grant stops, and nothing is made after.
  at("2026-11-11T06:00:00Z");
  await sendingWith(members).daily(W, m.id);
  const next = (await checksOf(m.id)).find((r) => new Date(r.expected_at) > new Date("2026-11-11T00:00:00Z"))!;
  clock.at = new Date(next.expected_at);
  fake.sendScript.push({ status: 429, reason: "rateLimitExceeded" });
  await ledger.run(W, next.action_id!);
  expect(await inWorkspace(W, (tx) => currentGrant(tx, m.id))).toMatchObject({ stoppedBy: null, stopReason: expect.stringContaining("sending limit") });
  at("2026-11-12T06:00:00Z");
  const made = await actionsOf(m.id);
  expect(await sendingWith(members).daily(W, m.id)).toEqual({ ok: false, reason: "not_granted" });
  expect(await actionsOf(m.id)).toBe(made);
});

test("a check whose send outcome is unknown waits for no person: the sweep cancels it, never resends it, and records it as unknown", async () => {
  at("2026-11-13T06:00:00Z");
  const m = await mailbox();
  const sending = sendingWith([member(m.address), member(RECEIVER)]);
  await sending.daily(W, m.id);
  const [check] = await checksOf(m.id);
  clock.at = new Date(check!.expected_at);
  // Gmail takes the message and never answers: it may have gone out.
  fake.sendScript.push("accept_then_hang");
  await ledger.run(W, check!.action_id!);
  expect((await checksOf(m.id))[0]).toMatchObject({ state: "held", hold_reason: "outcome_unknown" });
  const sends = fake.calls.send;
  // At the next sweep, long before the 30 minute cancel.
  clock.at = new Date(check!.expected_at.getTime() + 5 * 60_000);
  expect(await sending.cancelLate(W)).toBeGreaterThanOrEqual(1);
  expect((await checksOf(m.id))[0]).toMatchObject({ state: "cancelled", skip_reason: "unknown_outcome" });
  const events = await ledger.getEvents(W, check!.action_id!);
  expect(events.at(-1)).toMatchObject({ fromState: "held", toState: "cancelled", actorSystem: "placement", detail: expect.stringContaining("may have gone out") });
  await ledger.run(W, check!.action_id!);
  expect(fake.calls.send).toBe(sends);
  // Only an unknown outcome is cancelled this way.
  expect((await ledger.cancelUnknown(W, check!.action_id!, { system: "placement" })).ok).toBe(false);
});
