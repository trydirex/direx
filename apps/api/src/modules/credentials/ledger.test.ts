// SPDX-License-Identifier: AGPL-3.0-only
// The credential through the real ledger: approvals bind it, the dispatcher holds an
// Action whose credential cannot be used, and a rotation resumes it.
import type { EffectCapability } from "@direx/plugin-sdk";
import { afterAll, expect, test } from "vitest";
import { createBoss } from "../../jobs/boss";
import { approverIdFromSession, createLedger, oneKey } from "../ledger/index";
import { masterRootKey } from "./adapters/crypto";
import { credentialLabel, credentialReady, createVault } from "./index";
import { vaultDb } from "./test-helpers";

const db = vaultDb();
const SEND = "com.example.test/test.send";
const sent: unknown[] = [];
const effect: EffectCapability = {
  dedupe: "blind",
  reachesPerson: false,
  execute: async (spec) => {
    sent.push(spec);
    return { kind: "sent", providerRef: "ref", correlationKey: "c" };
  },
};
const boss = createBoss();
await boss.start();
const ledger = createLedger({
  boss,
  signingKeys: oneKey({ id: "test", secret: "t".repeat(32) }),
  effects: { [SEND]: effect },
  checks: [credentialReady],
  resolvers: { credential: credentialLabel },
});
await ledger.ensureQueue();
const vault = createVault({ rootKey: masterRootKey(Buffer.alloc(32, 7)), now: () => new Date(), onReady: ledger.resumeHeld });
afterAll(async () => {
  await boss.stop({ graceful: false, close: true });
  await db.close();
});

const { ws, owner } = await db.newWorkspace();
const person = { userId: owner };

async function apiKey(scope: "workspace" | "user" = "workspace", actor = owner) {
  const key = `k-${crypto.randomUUID()}`;
  const r = await vault.create({ workspaceId: ws, actorUserId: actor, scope, kind: "api_key", key, name: "N", meta: {}, value: { key: "sk" } });
  if (!r.ok) throw new Error(r.reason);
  return r.credential;
}

async function approved(credentialId: string) {
  const { action } = await ledger.createAction(ws, {
    idempotencyKey: crypto.randomUUID(),
    capability: SEND,
    dedupe: "blind",
    spec: { n: credentialId },
    actor: person,
    credentialId,
  });
  await ledger.submitForApproval(ws, action.id, person);
  const r = await ledger.approve(ws, action.id, { approverId: approverIdFromSession(owner), draftVersion: 1, snapshot: [] });
  if (!r.ok) throw new Error(`approve: ${r.reason}`);
  return action.id;
}

const setStatus = (id: string, status: string) => db.q(ws, "update credentials set status = $2 where id = $1", [id, status]);

test("V21: the approval binds the credential's id and label, not its value", async () => {
  const c = await apiKey();
  const id = await approved(c.id);
  const [row] = await db.q(ws, "select snapshot from approvals where action_id = $1", [id]);
  expect(row!.snapshot).toEqual([{ kind: "credential", id: c.id, version: c.key }]);
  await ledger.run(ws, id);
  expect(await ledger.getAction(ws, id)).toMatchObject({ state: "sent" });
});

test("V21: an approved Action pointed at another credential is held with snapshot_changed", async () => {
  const [a, b] = [await apiKey(), await apiKey()];
  const id = await approved(a.id);
  await db.q(ws, "update actions set credential_id = $2 where id = $1", [id, b.id]);
  await ledger.run(ws, id);
  expect(await ledger.getAction(ws, id)).toMatchObject({ state: "held", holdReason: "snapshot_changed" });
});

test("V20: an unusable credential holds the Action with credential_unavailable and nothing is sent", async () => {
  const cases: [string, (id: string) => Promise<unknown>, "workspace" | "user"][] = [
    ["deleted", (id) => vault.remove({ workspaceId: ws, id, actorUserId: owner }), "workspace"],
    ["revoked", (id) => setStatus(id, "revoked"), "workspace"],
    ["needs_reauth", (id) => setStatus(id, "needs_reauth"), "workspace"],
    ["owner_left", async () => {}, "user"],
  ];
  for (const [why, spoil, scope] of cases) {
    const member = await db.newUser();
    await db.addMember(ws, member);
    const c = await apiKey(scope, member);
    const id = await approved(c.id);
    if (why === "owner_left") await db.q(ws, "delete from workspace_members where workspace_id = $1 and user_id = $2", [ws, member]);
    await spoil(c.id);
    const before = sent.length;
    await ledger.run(ws, id);
    expect(await ledger.getAction(ws, id), why).toMatchObject({ state: "held", holdReason: "credential_unavailable" });
    expect((await ledger.getEvents(ws, id)).at(-1)?.detail, why).toBe(why);
    expect(sent.length, why).toBe(before);
  }
});

test("V20: a rotation moves the credential's held Actions back to scheduled, and they send", async () => {
  const c = await apiKey();
  const id = await approved(c.id);
  await setStatus(c.id, "revoked");
  await ledger.run(ws, id);
  expect(await ledger.getAction(ws, id)).toMatchObject({ state: "held", holdReason: "credential_unavailable" });

  await setStatus(c.id, "active");
  const [{ version }] = (await db.q(ws, "select version from credentials where id = $1", [c.id])) as [{ version: string }];
  expect(await vault.rotate({ workspaceId: ws, id: c.id, version: Number(version), value: { key: "sk2" }, actorUserId: owner })).toMatchObject({ ok: true });
  expect(await ledger.getAction(ws, id)).toMatchObject({ state: "scheduled" });
  await ledger.run(ws, id);
  expect(await ledger.getAction(ws, id)).toMatchObject({ state: "sent" });
});
