// SPDX-License-Identifier: AGPL-3.0-only
// A pending Mailbox check moves on: the probe arrives and is compared, is refused, or never comes.
import { createGmailPlugin } from "@direx/extensions";
import { startFakeGmail } from "@direx/extensions/gmail/fake";
import { afterAll, expect, test } from "vitest";
import { appClient } from "../../../../../test/db";
import { createVault, credentialLabel, credentialReady, rootKeyFromEnv } from "../credentials/index";
import { approverFromMember, approverMayApprove, can, type Permission, workspaceLive } from "../identity/index";
import { createItems } from "../items/index";
import { loadPlugins, type QueryOf } from "../plugins/index";
import { touchCheck } from "../schedule/index";
import { currentCheck } from "./adapters/header-checks";
import { inWorkspace, saveSettings } from "./adapters/repo";
import { createHeaderCheck, finishHeaderCheck, isProbeCapability, PROBE_WORDING_VERSION, probeRecipient, probeWordingVersion } from "./application/header-check";
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
  probeFor: async () => (canProbe ? { send: { id: PROBE, dedupe: "queryable", prepare: (ws, input) => plugins.prepare(ws, PROBE, input) }, read: "com.trydirex.gmail/mailbox.probe_read" as const } : undefined),
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

const READ = "com.trydirex.gmail/mailbox.probe_read" as const;
const probeFor = async () => ({ send: { id: PROBE, dedupe: "queryable" as const, prepare: (ws: string, input: unknown) => plugins.prepare(ws, PROBE, input) }, read: READ });
const query: QueryOf<"mailbox.probe_read"> = (ws, capability, input, credentialId) => plugins.query(ws, capability, input, credentialId);
const finish = finishHeaderCheck({ ledger: () => ledger, probeFor, query, now: () => clock.at });
/** A Mailbox signed in as the fake Gmail account, so its probe to itself lands in its inbox. */
const started = async () => {
  const made = await vault.create({ workspaceId: W, actorUserId: contributor.userId, scope: "workspace", kind: "basic", key: `m${crypto.randomUUID()}`, name: "Mailbox", meta: { username: "dana@example.com" }, value: { password: "x" } });
  if (!made.ok) throw new Error(made.reason);
  const m = made.credential.id;
  const r = await checks.start(W, m, as(contributor.userId));
  if (!r.ok) throw new Error(r.reason);
  return { m, actionId: r.check.probeActionId! };
};
const current = (m: string) => inWorkspace(W, (tx) => currentCheck(tx, m));

test("a probe that arrives as sent passes the Mailbox", async () => {
  const { m, actionId } = await started();
  expect(await finish(W, m)).toBe("pending");
  await ledger.run(W, actionId);
  expect(await finish(W, m)).toBe("passed");
  expect(await current(m)).toMatchObject({ state: "passed", failures: [] });
  // Settled: running again changes nothing.
  expect(await finish(W, m)).toBe("passed");
});

test("a probe the provider refuses fails the check, and probing waits a day", async () => {
  const { m, actionId } = await started();
  const real = (await ledger.getAction(W, actionId))!;
  const refusing = finishHeaderCheck({ ledger: () => ({ getAction: async () => ({ ...real, state: "held", holdReason: "provider_rejected" }), resumeHeldBy: ledger.resumeHeldBy }), probeFor, query, now: () => clock.at });
  expect(await refusing(W, m)).toBe("failed");
  expect(await current(m)).toMatchObject({ state: "failed", reason: "provider_refused" });
  expect(await checks.start(W, m, as(contributor.userId))).toEqual({ ok: false, reason: "provider_refused_recently" });
});

test("a blocked probe fails the check with the block's reason", async () => {
  const { m, actionId } = await started();
  const real = (await ledger.getAction(W, actionId))!;
  const blocked = finishHeaderCheck({ ledger: () => ({ getAction: async () => ({ ...real, state: "blocked", blockReason: "probe_recipient" }), resumeHeldBy: ledger.resumeHeldBy }), probeFor, query, now: () => clock.at });
  expect(await blocked(W, m)).toBe("failed");
  expect(await current(m)).toMatchObject({ state: "failed", reason: "probe_recipient" });
});

test("a probe not found within a day leaves the check inconclusive", async () => {
  const { m, actionId } = await started();
  await ledger.run(W, actionId);
  const nothing = finishHeaderCheck({ ledger: () => ledger, probeFor, query: async () => ({ found: false }), now: () => clock.at });
  expect(await nothing(W, m)).toBe("pending");
  const later = finishHeaderCheck({ ledger: () => ledger, probeFor, query: async () => ({ found: false }), now: () => new Date(clock.at.getTime() + 25 * 60 * 60 * 1000) });
  expect(await later(W, m)).toBe("inconclusive");
  expect(await current(m)).toMatchObject({ state: "inconclusive", reason: "probe_not_found" });
});

test("a probe that arrives with its unsubscribe link swapped makes the Mailbox replies only", async () => {
  const { m, actionId } = await started();
  await ledger.run(W, actionId);
  const swapped = finishHeaderCheck({
    ledger: () => ledger,
    probeFor,
    query: async (...args) => {
      const read = await query(...args);
      return read.found ? { ...read, headers: `${read.headers}\r\nList-Unsubscribe: <https://relay.example/u/1>` } : read;
    },
    now: () => clock.at,
  });
  expect(await swapped(W, m)).toBe("replies_only");
  expect(await current(m)).toMatchObject({ state: "replies_only", failures: ["unsubscribe_header_added"] });
});

test("changing a Mailbox's settings while its probe is out makes it unchecked", async () => {
  const { m } = await started();
  await db.query("begin");
  await db.query("select set_config('app.workspace_id', $1, true)", [W]);
  await db.query(`update credentials set meta = '{"smtpHost":"other.example"}'::jsonb where id = $1`, [m]);
  await db.query("commit");
  expect(await finish(W, m)).toBe("unchecked");
  expect(await current(m)).toMatchObject({ state: "unchecked", reason: "settings_changed" });
});

test("a Mailbox with no check, or a deleted one, is left alone", async () => {
  expect(await finish(W, await mailbox())).toBeNull();
  expect(await finish(W, crypto.randomUUID())).toBeNull();
});

test("the probe's wording version is what an approval binds", async () => {
  expect(await probeWordingVersion({} as never, "mailbox_probe")).toBe(PROBE_WORDING_VERSION);
  expect(await probeWordingVersion({} as never, "other")).toBeNull();
});
