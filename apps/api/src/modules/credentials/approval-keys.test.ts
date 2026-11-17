// SPDX-License-Identifier: AGPL-3.0-only
// Approval keys in the vault, and the real ledger signing and verifying with them.
import { afterAll, expect, test } from "vitest";
import { createBoss } from "../../jobs/boss";
import { approverIdFromSession, createLedger, KeysUnavailable } from "../ledger/index";
import { masterRootKey } from "./adapters/crypto";
import { createVault } from "./index";
import { vaultDb } from "./test-helpers";

const db = vaultDb();
afterAll(() => db.close());
const root = masterRootKey(Buffer.alloc(32, 7));
const newVault = () => createVault({ rootKey: root, now: () => new Date() });
const vault = newVault();
const boss = createBoss();
await boss.start();
await createLedger({ boss, signingKeys: vault.approvalKeys }).ensureQueue();
afterAll(() => boss.stop({ graceful: false, close: true }));

async function approved(ledger: ReturnType<typeof createLedger>, ws: string, owner: string) {
  const actor = { userId: owner };
  const { action } = await ledger.createAction(ws, { idempotencyKey: crypto.randomUUID(), capability: "test.send", dedupe: "blind", spec: { body: "hi" }, actor });
  await ledger.submitForApproval(ws, action.id, actor);
  const r = await ledger.approve(ws, action.id, { approverId: approverIdFromSession(owner), draftVersion: 1, snapshot: [] });
  if (!r.ok) throw new Error(r.reason);
  return action.id;
}
const signature = async (ws: string, id: string) => (await db.q(ws, "select signature, key_id from approvals where action_id = $1", [id]))[0];

test("keys sealed under another root key fail as permanent; the ledger can tell them from a passing fault", async () => {
  const { ws } = await db.newWorkspace();
  await vault.approvalKeys(ws);
  const other = createVault({ rootKey: masterRootKey(Buffer.alloc(32, 8)), now: () => new Date() });
  const refused = await other.approvalKeys(ws).catch((e: unknown) => e);
  expect(refused).toBeInstanceOf(KeysUnavailable);
  expect(refused).toMatchObject({ permanent: true });
  expect((refused as Error).message).toContain("another root key");
});

test("a Workspace's first use creates its key, sealed, once, with one audit row", async () => {
  const { ws } = await db.newWorkspace();
  const keys = await vault.approvalKeys(ws);
  expect(keys.current.secret).toMatch(/^[0-9a-f]{64}$/);
  expect((await newVault().approvalKeys(ws)).current).toEqual(keys.current);
  const rows = await db.q(ws, "select key_id, ciphertext from approval_keys");
  expect(rows).toHaveLength(1);
  const stored = rows[0].ciphertext as Buffer;
  for (const form of [keys.current.secret, Buffer.from(keys.current.secret, "hex").toString("base64")]) expect(stored.toString("latin1")).not.toContain(form);
  expect(await db.q(ws, "select event, actor_system from workspace_audit where event = 'approval_key_created'")).toEqual([{ event: "approval_key_created", actor_system: "vault" }]);
});

test("concurrent first uses end with one live key", async () => {
  const { ws } = await db.newWorkspace();
  const all = await Promise.all(Array.from({ length: 10 }, () => newVault().approvalKeys(ws)));
  expect(new Set(all.map((k) => k.current.secret)).size).toBe(1);
  expect(await db.q(ws, "select key_id from approval_keys")).toHaveLength(1);
});

test("Workspaces have different keys, and a sealed key moved to another Workspace doesn't open", async () => {
  const a = await db.newWorkspace();
  const b = await db.newWorkspace();
  const keyA = await vault.approvalKeys(a.ws);
  const keyB = await vault.approvalKeys(b.ws);
  expect(keyA.current.secret).not.toBe(keyB.current.secret);
  const [row] = await db.q(a.ws, "select * from approval_keys");
  const c = await db.newWorkspace();
  await db.q(c.ws, "insert into approval_keys (workspace_id, key_id, ciphertext, nonce, key_version, created_at) values ($1, $2, $3, $4, 1, now())", [c.ws, row.key_id, row.ciphertext, row.nonce]);
  await db.q(c.ws, "insert into workspace_keys (workspace_id, key_version, wrapped_dek, root_key_id, created_at) values ($1, 1, $2, $3, now())", [c.ws, await root.wrap(Buffer.alloc(32, 3), c.ws), root.id]);
  await expect(newVault().approvalKeys(c.ws)).rejects.toThrow("decryption failed");
});

test("an approval key never shows up as a credential", async () => {
  const { ws } = await db.newWorkspace();
  await vault.approvalKeys(ws);
  expect(await vault.list(ws)).toEqual([]);
  expect(await db.q(ws, "select id from credentials")).toEqual([]);
});

test("an approval signs with its Workspace's key and verifies there, not under another's", async () => {
  const { ws, owner } = await db.newWorkspace();
  const sent: unknown[] = [];
  const effects = { "test.send": { dedupe: "blind" as const, reachesPerson: false, execute: async (s: unknown) => (sent.push(s), { kind: "sent" as const, providerRef: "r", correlationKey: "c" }) } };
  const ledger = createLedger({ boss, signingKeys: vault.approvalKeys, effects });
  const id = await approved(ledger, ws, owner);
  const { key_id } = await signature(ws, id);
  expect(key_id).toBe((await vault.approvalKeys(ws)).current.id);
  await ledger.run(ws, id);
  expect((await ledger.getAction(ws, id))!.state).toBe("sent");

  const other = await db.newWorkspace();
  const second = await approved(ledger, ws, owner);
  const foreign = createLedger({ boss, signingKeys: async () => vault.approvalKeys(other.ws), effects });
  await foreign.run(ws, second);
  expect(await ledger.getAction(ws, second)).toMatchObject({ state: "held", holdReason: "approval_invalid" });
  expect(sent).toHaveLength(1);
});

test("an approval still verifies after its key is retired, and new ones use the new key", async () => {
  const { ws, owner } = await db.newWorkspace();
  const fresh = () => newVault();
  const effects = { "test.send": { dedupe: "blind" as const, reachesPerson: false, execute: async () => ({ kind: "sent" as const, providerRef: "r", correlationKey: "c" }) } };
  const ledger = createLedger({ boss, signingKeys: fresh().approvalKeys, effects });
  const id = await approved(ledger, ws, owner);
  const old = (await fresh().approvalKeys(ws)).current.id;
  await db.q(ws, "update approval_keys set retired_at = now()");
  const after = createLedger({ boss, signingKeys: fresh().approvalKeys, effects });
  const newer = await approved(after, ws, owner);
  expect((await signature(ws, newer)).key_id).not.toBe(old);
  await after.run(ws, id);
  expect((await after.getAction(ws, id))!.state).toBe("sent");
});

test("keys are fetched before any lock is held", async () => {
  const { ws, owner } = await db.newWorkspace();
  const pending: { id?: string } = {};
  const seen: string[] = [];
  const checking = async (w: string) => {
    if (pending.id) {
      const rows = await db.q(ws, "select id from actions where id = $1 for update nowait", [pending.id]);
      seen.push(rows[0].id);
    }
    return vault.approvalKeys(w);
  };
  const ledger = createLedger({ boss, signingKeys: checking, effects: { "test.send": { dedupe: "blind", reachesPerson: false, execute: async () => ({ kind: "sent", providerRef: "r", correlationKey: "c" }) } } });
  const actor = { userId: owner };
  const { action } = await ledger.createAction(ws, { idempotencyKey: crypto.randomUUID(), capability: "test.send", dedupe: "blind", spec: {}, actor });
  await ledger.submitForApproval(ws, action.id, actor);
  pending.id = action.id;
  await ledger.approve(ws, action.id, { approverId: approverIdFromSession(owner), draftVersion: 1, snapshot: [] });
  await ledger.run(ws, action.id);
  expect(seen.length).toBeGreaterThanOrEqual(2);
  expect((await ledger.getAction(ws, action.id))!.state).toBe("sent");
});
