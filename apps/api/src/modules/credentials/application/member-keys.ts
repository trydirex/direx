// SPDX-License-Identifier: AGPL-3.0-only
// Each placement Mailbox's member key: an Ed25519 pair made on first need and sealed in the vault
// like an approval key. Only its public half and its signatures leave here; nothing returns the
// private half to a route, a plugin or an agent.
import { createPrivateKey, generateKeyPairSync, sign } from "node:crypto";
import { insertAudit, insertMemberKey, memberKeyRow, withWorkspace, type MemberKeyRow, type WorkspaceTx } from "../adapters/repo";
import type { Keyring } from "./keys";

// Keeps a member key's seal apart from any credential's and from approval keys'.
const sealId = (credentialId: string) => `member-key:${credentialId}`;

export function memberKeyStore(keys: Keyring, now: () => Date) {
  async function ensure(tx: WorkspaceTx, workspaceId: string, credentialId: string): Promise<MemberKeyRow> {
    const found = await memberKeyRow(tx, credentialId);
    if (found) return found;
    const pair = generateKeyPairSync("ed25519");
    const at = now();
    const sealed = await keys.seal(tx, workspaceId, sealId(credentialId), { pkcs8: pair.privateKey.export({ format: "der", type: "pkcs8" }).toString("base64") });
    const publicKey = pair.publicKey.export({ format: "jwk" }).x!;
    if (await insertMemberKey(tx, { workspaceId, credentialId, publicKey, ...sealed, createdAt: at })) {
      await insertAudit(tx, { workspaceId, event: "member_key_created", actorSystem: "vault", at });
    }
    return (await memberKeyRow(tx, credentialId))!;
  }

  return {
    /** The Mailbox's public key, base64url of the raw 32 bytes, as it goes in a member list entry. */
    publicKey: (workspaceId: string, credentialId: string) => withWorkspace(workspaceId, async (tx) => (await ensure(tx, workspaceId, credentialId)).publicKey),

    /** An Ed25519 signature over `data` with the Mailbox's key, base64url. */
    sign: (workspaceId: string, credentialId: string, data: Uint8Array) =>
      withWorkspace(workspaceId, async (tx) => {
        const row = await ensure(tx, workspaceId, credentialId);
        const { pkcs8 } = (await keys.openFor(tx, workspaceId, sealId(credentialId), row.keyVersion, row)) as { pkcs8: string };
        return sign(null, data, createPrivateKey({ key: Buffer.from(pkcs8, "base64"), format: "der", type: "pkcs8" })).toString("base64url");
      }),
  };
}
