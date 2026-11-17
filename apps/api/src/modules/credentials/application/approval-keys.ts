// SPDX-License-Identifier: AGPL-3.0-only
// Each Workspace's keys for signing approvals: generated on first use and sealed in the
// vault, so a leak in one Workspace can't forge approvals in another. Nothing here returns
// a key to a route, a plugin or an agent; only the ledger receives them.
import { randomBytes } from "node:crypto";
import { KeysUnavailable, type WorkspaceKeys } from "../../ledger";
import { DEK_TTL_MS, RootKeyMismatch } from "../adapters/crypto";
import { insertApprovalKey, insertAudit, listApprovalKeys, withWorkspace, type ApprovalKeyRow, type WorkspaceTx } from "../adapters/repo";
import type { Keyring } from "./keys";

// Keeps a key's seal apart from any credential's, whose ids are bare uuids.
const sealId = (keyId: string) => `approval-key:${keyId}`;

export function approvalKeyStore(keys: Keyring, now: () => Date) {
  const cache = new Map<string, { value: WorkspaceKeys; until: number }>();

  async function create(tx: WorkspaceTx, workspaceId: string) {
    const keyId = `ak-${crypto.randomUUID()}`;
    const at = now();
    const sealed = await keys.seal(tx, workspaceId, sealId(keyId), { secret: randomBytes(32).toString("hex") });
    if (await insertApprovalKey(tx, { workspaceId, keyId, ...sealed, createdAt: at })) {
      await insertAudit(tx, { workspaceId, event: "approval_key_created", actorSystem: "vault", at });
    }
  }

  async function load(tx: WorkspaceTx, workspaceId: string): Promise<WorkspaceKeys> {
    let rows: ApprovalKeyRow[] = await listApprovalKeys(tx, workspaceId);
    if (!rows.some((r) => !r.retiredAt)) {
      await create(tx, workspaceId);
      rows = await listApprovalKeys(tx, workspaceId);
    }
    const opened = new Map<string, { id: string; secret: string }>();
    for (const r of rows) {
      const { secret } = (await keys.openFor(tx, workspaceId, sealId(r.keyId), r.keyVersion, r)) as { secret: string };
      opened.set(r.keyId, { id: r.keyId, secret });
    }
    const live = rows.find((r) => !r.retiredAt)!;
    return { current: opened.get(live.keyId)!, byId: (id) => opened.get(id) };
  }

  return async function approvalKeys(workspaceId: string): Promise<WorkspaceKeys> {
    const hit = cache.get(workspaceId);
    if (hit && hit.until > now().getTime()) return hit.value;
    let value: WorkspaceKeys;
    try {
      value = await withWorkspace(workspaceId, (tx) => load(tx, workspaceId));
    } catch (e) {
      if (e instanceof RootKeyMismatch) throw new KeysUnavailable(`this Workspace's keys were set up under another root key: ${e.message}`, true);
      throw new KeysUnavailable(`approval keys couldn't be loaded: ${(e as Error).message}`, false);
    }
    cache.set(workspaceId, { value, until: now().getTime() + DEK_TTL_MS });
    return value;
  };
}
