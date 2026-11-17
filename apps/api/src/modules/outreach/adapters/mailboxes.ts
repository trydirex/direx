// SPDX-License-Identifier: AGPL-3.0-only
// The two jobs that run across Workspaces: which mailboxes to read, and clearing old reply text.
import { withSystem } from "@direx/db";
import { sql } from "drizzle-orm";

/** Live mailboxes on the given connections. Connection names never contain a comma. */
export async function connectedMailboxes(connections: readonly string[]): Promise<{ workspaceId: string; credentialId: string; connection: string }[]> {
  const list = connections.join(",");
  const { rows } = await withSystem((tx) => tx.execute(sql`select workspace_id, credential_id, connection from system.connected_mailboxes(string_to_array(${list}, ','))`));
  return rows.map((r) => ({ workspaceId: r.workspace_id as string, credentialId: r.credential_id as string, connection: r.connection as string }));
}

export async function clearOldReplyText(): Promise<number> {
  const { rows } = await withSystem((tx) => tx.execute(sql`select system.clear_old_reply_text() as cleared`));
  return Number(rows[0]?.cleared ?? 0);
}
