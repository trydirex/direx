// SPDX-License-Identifier: AGPL-3.0-only
// The ledger's view of a credential: whether an Action's credential may be used now, and
// the label its approval binds. Neither opens the sealed value.
import type { Check, Resolver } from "../../ledger";
import { credentialById, isMember, type CredentialRow, type WorkspaceTx } from "../adapters/repo";
import { readiness, type NotReady, type Scope, type Status } from "../domain/status";

export async function notReady(tx: WorkspaceTx, row: CredentialRow | null): Promise<NotReady | null> {
  const ownerIsMember = row?.scope === "user" ? await isMember(tx, row.workspaceId, row.ownerUserId!) : true;
  return readiness(row && { scope: row.scope as Scope, status: row.status as Status, deletedAt: row.deletedAt }, ownerIsMember);
}

/** Holds an Action whose credential is missing, deleted, revoked, needs reauth or lost its owner. */
export const credentialReady: Check = async (tx, action) => {
  if (!action.credentialId) return { kind: "ok" };
  const why = await notReady(tx, await credentialById(tx, action.credentialId));
  return why ? { kind: "hold", reason: "credential_unavailable", detail: why } : { kind: "ok" };
};

/** The snapshot version: the credential's key, holding the account address, which refresh and rotation keep. */
export const credentialLabel: Resolver = async (tx, id) => (await credentialById(tx, id))?.key ?? null;

/** A Mailbox's settings without its secret: its name, what a probe is sent to, what its check is bound to, and who connected it. */
export async function credentialSettings(tx: WorkspaceTx, id: string) {
  const row = await credentialById(tx, id);
  return row && !row.deletedAt ? { connection: row.connection, key: row.key, name: row.name, meta: row.meta as Record<string, unknown>, scope: row.scope, ownerUserId: row.ownerUserId, createdBy: row.createdBy } : null;
}
