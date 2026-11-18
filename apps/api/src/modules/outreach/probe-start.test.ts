// SPDX-License-Identifier: AGPL-3.0-only
// Connect and Check again: one probe to the Mailbox's own sign-in, approved by whoever connected it.
import { createGmailPlugin } from "@direx/extensions";
import { startFakeGmail } from "@direx/extensions/gmail/fake";
import { afterAll, expect, test } from "vitest";
import { appClient } from "../../../../../test/db";
import { createVault, credentialLabel, credentialReady, rootKeyFromEnv } from "../credentials/index";
import { approverFromMember, approverMayApprove, can, type Permission, workspaceLive } from "../identity/index";
import { createItems } from "../items/index";
import { loadPlugins } from "../plugins/index";
import { touchCheck } from "../schedule/index";
import { currentCheck } from "./adapters/header-checks";
import { inWorkspace, saveSettings } from "./adapters/repo";
import { createHeaderCheck, isProbeCapability, PROBE_TEXT, PROBE_WORDING_VERSION, probeRecipient, probeWordingVersion, signInOf } from "./application/header-check";
import { REPLY_STOP } from "./domain/footer";
import { TEST_SECRET, testIdentity, testLedger } from "./fixtures/support";

process.env.DIREX_AUTH_SECRET = TEST_SECRET;
const PROBE = "com.trydirex.gmail/mailbox.probe";
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
  resolvers: { credential: credentialLabel, wording: probeWordingVersion },
  checks: [workspaceLive(), approverMayApprove((c) => (isProbeCapability(c) ? "credential.connect" : undefined)), probeRecipient, touchCheck({ effects: plugins.effects, now: () => clock.at }), credentialReady],
  now: () => clock.at,
});
let base = "http://localhost:3000";
let canProbe = true;
const items = createItems({ ledger, now: () => clock.at, actionPermission: (c) => (isProbeCapability(c) ? "credential.connect" : undefined) });
const checks = createHeaderCheck({
  items: () => items,
  probeFor: async () => (canProbe ? { send: { id: PROBE, dedupe: "queryable", prepare: (ws, input) => plugins.prepare(ws, PROBE, input) }, read: "com.trydirex.gmail/mailbox.probe_read" } : undefined),
  baseUrl: () => base,
  now: () => clock.at,
});

const { signIn, createOrg, addMember } = testIdentity();
const cookie = await signIn();
const W = (await createOrg(cookie, "Acme")).workspace.id;
const contributor = await addMember(cookie, W, "contributor");
const db = await appClient();
afterAll(() => db.end());
const vault = createVault({ rootKey: rootKeyFromEnv({ DIREX_MASTER_KEY: "11".repeat(32) })!, now: () => clock.at });
const mailbox = async (signIn = `${crypto.randomUUID().slice(0, 8)}@acme.test`, owner = contributor.userId) => {
  const r = await vault.create({ workspaceId: W, actorUserId: owner, scope: "workspace", kind: "api_key", key: signIn, name: "Mailbox", meta: {}, value: { key: "x" } });
  if (!r.ok) throw new Error(r.reason);
  return r.credential.id;
};
await inWorkspace(W, (tx) => saveSettings(tx, W, { senderName: "Sam at Acme", postalAddress: "1 Main St" }, clock.at));
/** What a contributor's click carries: who they are, what their role allows, and the words they saw. */
const as = (userId: string, wordingVersion = PROBE_WORDING_VERSION) => ({ approverId: approverFromMember({ userId }), userId, may: (p: string) => can("contributor", p as Permission), wordingVersion });
const lastSent = () => Buffer.from(fake.sent.at(-1)!.raw, "base64url").toString();
/** The text part of the last message Gmail received, decoded. */
const lastText = () => Buffer.from(lastSent().split("\r\n\r\n")[1]!, "base64").toString();

test("a contributor's Connect sends one probe to the Mailbox's own sign-in, with the footer cold mail carries", async () => {
  const m = await mailbox("me@acme.test");
  const r = await checks.start(W, m, as(contributor.userId));
  expect(r).toMatchObject({ ok: true, check: { state: "pending" } });
  if (!r.ok) return;
  const before = fake.sent.length;
  await ledger.run(W, r.check.probeActionId!);
  expect((await ledger.getAction(W, r.check.probeActionId!))!.state).toBe("sent");
  expect(fake.sent).toHaveLength(before + 1);
  const raw = lastSent();
  expect(raw).toContain("To: me@acme.test");
  expect(lastText()).toBe(`${PROBE_TEXT}\n\n--\nSam at Acme\n1 Main St\n${REPLY_STOP}`);
  // On localhost there's no link or one-click header, exactly as for a cold email.
  expect(raw).not.toContain("List-Unsubscribe");
});

test("a Gmail Mailbox's sign-in is its account address, not its `google:` credential key", () => {
  expect(signInOf({ key: "google:Me@acme.test", meta: { accountEmail: "Me@acme.test", scopes: ["openid"] } })).toBe("me@acme.test");
  expect(signInOf({ key: "me@acme.test", meta: {} })).toBe("me@acme.test");
});

test("on a public HTTPS address the probe carries a link Direx never issued, and the one-click headers", async () => {
  base = "https://direx.example";
  try {
    const r = await checks.start(W, await mailbox(), as(contributor.userId));
    if (!r.ok) throw new Error(r.reason);
    await ledger.run(W, r.check.probeActionId!);
    expect(lastSent()).toMatch(/List-Unsubscribe: <https:\/\/direx\.example\/api\/unsubscribe\/[0-9a-f-]+\/probe-[0-9a-f]{32}>/);
    expect(lastSent()).toContain("List-Unsubscribe-Post: List-Unsubscribe=One-Click");
  } finally {
    base = "http://localhost:3000";
  }
});

test("old wording is refused and nothing is sent", async () => {
  const m = await mailbox();
  expect(await checks.start(W, m, as(contributor.userId, "2020-01-01"))).toEqual({ ok: false, reason: "stale_wording" });
  expect(await inWorkspace(W, (tx) => currentCheck(tx, m))).toBeNull();
});

test("a second click while a probe is out gets the same probe", async () => {
  const m = await mailbox();
  const a = await checks.start(W, m, as(contributor.userId));
  const b = await checks.start(W, m, as(contributor.userId));
  expect(a.ok && b.ok && a.check.probeActionId === b.check.probeActionId).toBe(true);
});

test("five probes a day, then no more", async () => {
  const m = await mailbox();
  for (let i = 0; i < 5; i++) {
    const r = await checks.start(W, m, as(contributor.userId));
    if (!r.ok) throw new Error(r.reason);
    await ledger.run(W, r.check.probeActionId!);
    // Settled, so the next click sends another.
    await db.query("begin");
    await db.query("select set_config('app.workspace_id', $1, true)", [W]);
    await db.query("update mailbox_header_checks set state = 'passed' where probe_action_id = $1", [r.check.probeActionId]);
    await db.query("commit");
    clock.at = new Date(clock.at.getTime() + 2 * 60_000);
  }
  expect(await checks.start(W, m, as(contributor.userId))).toEqual({ ok: false, reason: "daily_limit" });
});

test("no probe for a sign-in that isn't an email, a provider that can't check, or no sender identity", async () => {
  expect(await checks.start(W, await mailbox("not-an-email"), as(contributor.userId))).toMatchObject({ ok: true, check: { state: "unchecked", reason: "sign_in_not_email", probeActionId: null } });
  canProbe = false;
  try {
    expect(await checks.start(W, await mailbox(), as(contributor.userId))).toMatchObject({ ok: true, check: { state: "unchecked", reason: "provider_cannot_check" } });
  } finally {
    canProbe = true;
  }
  const other = (await createOrg(cookie, "Other")).workspace.id;
  const r = await vault.create({ workspaceId: other, actorUserId: contributor.userId, scope: "workspace", kind: "api_key", key: "x@other.test", name: "M", meta: {}, value: { key: "x" } });
  if (!r.ok) throw new Error(r.reason);
  expect(await checks.start(other, r.credential.id, as(contributor.userId))).toMatchObject({ ok: true, check: { state: "unchecked", reason: "sender_identity_missing" } });
});

test("a probe whose recipient isn't the sign-in is blocked at dispatch", async () => {
  const m = await mailbox("me2@acme.test");
  const { spec } = await plugins.prepare(W, PROBE, { to: ["someone@else.test"], subject: "Direx Mailbox check x", text: "hi" });
  const { action } = await ledger.createAction(W, { idempotencyKey: crypto.randomUUID(), capability: PROBE, dedupe: "queryable", spec, actor: { userId: contributor.userId }, credentialId: m });
  await ledger.submitForApproval(W, action.id, { userId: contributor.userId });
  await ledger.approve(W, action.id, { approverId: approverFromMember(contributor), draftVersion: action.draftVersion, snapshot: [{ kind: "credential", id: m, version: "me2@acme.test" }] });
  await ledger.run(W, action.id);
  expect(await ledger.getAction(W, action.id)).toMatchObject({ state: "blocked", blockReason: "probe_recipient" });
});

test("a contributor still can't approve anything that isn't a probe", async () => {
  const check = approverMayApprove((c) => (isProbeCapability(c) ? "credential.connect" : undefined));
  const r = await inWorkspace(W, (t) => check(t, { capability: "com.trydirex.gmail/email.send" } as never, { approverId: contributor.userId } as never));
  expect(r.kind).toBe("hold");
  const p = await inWorkspace(W, (t) => check(t, { capability: PROBE } as never, { approverId: contributor.userId } as never));
  expect(p.kind).toBe("ok");
});
