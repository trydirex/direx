// SPDX-License-Identifier: AGPL-3.0-only
import { appClient } from "../../../../../test/db";
import { afterAll, expect, test } from "vitest";
import { createVault, rootKeyFromEnv } from "../credentials/index";
import { currentCheck, pendingChecks, probesSince, settleCheck, startCheck } from "./adapters/header-checks";
import { inWorkspace } from "./adapters/repo";
import { TEST_SECRET, testIdentity, testLedger } from "./fixtures/support";

process.env.DIREX_AUTH_SECRET = TEST_SECRET;
const { clock, ledger } = await testLedger();
const { signIn, createOrg } = testIdentity();
const cookie = await signIn();
const W = (await createOrg(cookie, "Acme")).workspace.id;
const db = await appClient();
afterAll(() => db.end());
await db.query("begin");
await db.query("select set_config('app.workspace_id', $1, true)", [W]);
const owner = (await db.query("select user_id from workspace_members")).rows[0].user_id as string;
await db.query("commit");
const vault = createVault({ rootKey: rootKeyFromEnv({ DIREX_MASTER_KEY: "11".repeat(32) })!, now: () => clock.at });
const mailbox = async () => {
  const r = await vault.create({ workspaceId: W, actorUserId: owner, scope: "workspace", kind: "api_key", key: `m${crypto.randomUUID()}`, name: "Mailbox", meta: {}, value: { key: "x" } });
  if (!r.ok) throw new Error(r.reason);
  return r.credential.id;
};
const probe = async () => (await ledger.createAction(W, { idempotencyKey: crypto.randomUUID(), capability: "test.probe", dedupe: "queryable", spec: {}, actor: { userId: owner } })).action.id;
let tick = 0;
const at = () => new Date(Date.UTC(2026, 10, 5, 9, 0, tick++));
const start = (credentialId: string, probeActionId: string | null, settingsHash = "s1") =>
  inWorkspace(W, (tx) => startCheck(tx, { workspaceId: W, credentialId, probeActionId, probeSubject: "Direx check", settingsHash, state: probeActionId ? "pending" : "unchecked", createdBy: owner, createdAt: at() }));
const settle = (credentialId: string, probeActionId: string, settingsHash = "s1") =>
  inWorkspace(W, (tx) => settleCheck(tx, { credentialId, probeActionId, settingsHash, state: "passed", settledAt: at() }));

test("a result lands on the current pending check for its probe and settings, once", async () => {
  const m = await mailbox();
  const p = await probe();
  await start(m, p);
  expect(await settle(m, p)).toBe(true);
  expect(await inWorkspace(W, (tx) => currentCheck(tx, m))).toMatchObject({ state: "passed", probeActionId: p });
  // Settled already: a second result changes nothing.
  expect(await settle(m, p)).toBe(false);
});

test("a late result from an older probe, or from before a settings change, writes nothing", async () => {
  const m = await mailbox();
  const old = await probe();
  await start(m, old);
  const newer = await probe();
  await start(m, newer);
  expect(await settle(m, old)).toBe(false);
  expect(await settle(m, newer, "s2")).toBe(false);
  expect(await inWorkspace(W, (tx) => currentCheck(tx, m))).toMatchObject({ state: "pending", probeActionId: newer });
});

test("two settles of one probe at once: exactly one writes", async () => {
  const m = await mailbox();
  const p = await probe();
  await start(m, p);
  expect((await Promise.all([settle(m, p), settle(m, p)])).filter(Boolean)).toHaveLength(1);
});

test("pending lists only Mailboxes whose current check is pending, and probes are counted per day", async () => {
  const done = await mailbox();
  const waiting = await mailbox();
  const none = await mailbox();
  const p = await probe();
  await start(done, p);
  await settle(done, p);
  const since = at();
  await start(waiting, await probe());
  await start(waiting, await probe());
  await start(none, null);
  const pending = await inWorkspace(W, (tx) => pendingChecks(tx));
  expect(pending.map((c) => c.credentialId)).toContain(waiting);
  expect(pending.map((c) => c.credentialId)).not.toContain(done);
  expect(pending.map((c) => c.credentialId)).not.toContain(none);
  expect(await inWorkspace(W, (tx) => probesSince(tx, waiting, since))).toBe(2);
  expect(await inWorkspace(W, (tx) => probesSince(tx, none, since))).toBe(0);
});

test("the app can't delete a check", async () => {
  await db.query("begin");
  await db.query("select set_config('app.workspace_id', $1, true)", [W]);
  await expect(db.query("delete from mailbox_header_checks")).rejects.toThrow(/permission denied/);
  await db.query("rollback");
});
