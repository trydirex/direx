// SPDX-License-Identifier: AGPL-3.0-only
// Placement member keys in the vault: made once per Mailbox, sealed, kept to their Workspace, and
// never handed out by a credential route.
import { createPublicKey, verify } from "node:crypto";
import { afterAll, expect, test } from "vitest";
import { withWorkspace } from "./adapters/repo";
import { masterRootKey } from "./adapters/crypto";
import { createVault } from "./application/secrets";
import { keyring } from "./application/keys";
import { testApp, vaultDb } from "./test-helpers";

const db = vaultDb();
afterAll(() => db.close());
const root = masterRootKey(Buffer.alloc(32, 9));
const newVault = () => createVault({ rootKey: root, now: () => new Date() });
const vault = newVault();
const { call, workspace } = testApp(vault);

async function mailbox(ws: string, cookie: string) {
  const res = await call(`/api/w/${ws}/credentials`, cookie, { method: "POST", body: { scope: "workspace", kind: "api_key", key: `k-${crypto.randomUUID()}`, name: "N", value: { key: "v" } } });
  expect(res.status).toBe(201);
  return ((await res.json()) as { credential: { id: string } }).credential.id;
}

const verifies = (publicKey: string, data: Buffer, signature: string) => verify(null, data, createPublicKey({ key: { kty: "OKP", crv: "Ed25519", x: publicKey }, format: "jwk" }), Buffer.from(signature, "base64url"));

test("a Mailbox's key is made once, sealed, and signs what its public key verifies", async () => {
  const { ws, owner } = await workspace();
  const id = await mailbox(ws, owner.cookie);
  const pub = await vault.memberKeys.publicKey(ws, id);
  expect(pub).toMatch(/^[A-Za-z0-9_-]{43}$/);
  const all = await Promise.all(Array.from({ length: 5 }, () => newVault().memberKeys.publicKey(ws, id)));
  expect(new Set(all)).toEqual(new Set([pub]));
  expect(await db.q(ws, "select credential_id from placement_member_keys")).toEqual([{ credential_id: id }]);
  expect(await db.q(ws, "select event from workspace_audit where event = 'member_key_created'")).toHaveLength(1);

  const data = Buffer.from("list 3, day 2026-11-10, verdict primary");
  const sig = await newVault().memberKeys.sign(ws, id, data);
  expect(verifies(pub, data, sig)).toBe(true);
  expect(verifies(pub, Buffer.from("list 3, day 2026-11-10, verdict spam"), sig)).toBe(false);

  const other = await mailbox(ws, owner.cookie);
  expect(verifies(await vault.memberKeys.publicKey(ws, other), data, sig)).toBe(false);
});

test("no credential route returns a member key, and the stored row holds no private key in the clear", async () => {
  const { ws, owner } = await workspace();
  const id = await mailbox(ws, owner.cookie);
  const pub = await vault.memberKeys.publicKey(ws, id);
  const [row] = await db.q(ws, "select ciphertext, nonce, key_version from placement_member_keys");
  const { pkcs8 } = (await withWorkspace(ws, (tx) => keyring(root, () => new Date()).openFor(tx, ws, `member-key:${id}`, row.key_version, row))) as { pkcs8: string };
  const secret = Buffer.from(pkcs8, "base64");
  const forms = [pkcs8, secret.toString("hex"), secret.subarray(-32).toString("base64url"), secret.subarray(-32).toString("base64")];
  expect((row.ciphertext as Buffer).toString("latin1")).not.toContain(secret.subarray(-32).toString("latin1"));

  for (const path of [`/api/w/${ws}/credentials`, `/api/w/${ws}/credentials/${id}/events`, `/api/w/${ws}/key-services`, `/api/w/${ws}/mailbox-providers`, `/api/w/${ws}/connect-links`]) {
    const res = await call(path, owner.cookie);
    expect(res.status, path).toBe(200);
    const text = await res.text();
    for (const f of [...forms, pub]) expect(text, path).not.toContain(f);
  }
  expect(await vault.list(ws)).toHaveLength(1);
});

test("another Workspace can't see or use a Mailbox's member key", async () => {
  const a = await workspace();
  const b = await workspace();
  const id = await mailbox(a.ws, a.owner.cookie);
  await vault.memberKeys.publicKey(a.ws, id);
  expect(await db.q(b.ws, "select credential_id from placement_member_keys")).toEqual([]);
  // B can't make a key for A's Mailbox either: the credential isn't there under B.
  await expect(vault.memberKeys.publicKey(b.ws, id)).rejects.toThrow();
  await expect(db.q(b.ws, "insert into placement_member_keys (workspace_id, credential_id, public_key, ciphertext, nonce, key_version, created_at) values ($1, $2, 'x', 'x', 'x', 1, now())", [a.ws, id])).rejects.toThrow();
  await expect(db.q(a.ws, "update placement_member_keys set public_key = 'x'")).rejects.toThrow();
  await expect(db.q(a.ws, "delete from placement_member_keys")).rejects.toThrow();
});
