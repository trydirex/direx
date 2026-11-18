// SPDX-License-Identifier: AGPL-3.0-only
// Every SQL statement of the reply desk: who owns a reply, and clearing a thread's text once it is settled.
import { approvals, credentials, items, workspaceMembers } from "@direx/db/schema";
import { replySignals } from "@direx/db/schema-outreach";
import { and, eq, isNotNull, isNull, sql } from "drizzle-orm";
import type { OutreachTx } from "./repo";

/** Who approved the email being replied to, while they are still a member. */
export async function liveApprover(tx: OutreachTx, actionId: string): Promise<string | null> {
  const [row] = await tx
    .select({ userId: approvals.approverId })
    .from(approvals)
    .innerJoin(workspaceMembers, eq(workspaceMembers.userId, approvals.approverId))
    .where(and(eq(approvals.actionId, actionId), isNull(approvals.voidedAt)));
  return row?.userId ?? null;
}

/** The person a Mailbox belongs to, while they are still a member. Workspace-wide Mailboxes have none. */
export async function mailboxOwner(tx: OutreachTx, credentialId: string): Promise<string | null> {
  const [row] = await tx
    .select({ userId: workspaceMembers.userId })
    .from(credentials)
    .innerJoin(workspaceMembers, eq(workspaceMembers.userId, credentials.ownerUserId))
    .where(and(eq(credentials.id, credentialId), isNull(credentials.deletedAt)));
  return row?.userId ?? null;
}

export async function workspaceOwners(tx: OutreachTx): Promise<string[]> {
  const rows = await tx.select({ userId: workspaceMembers.userId }).from(workspaceMembers).where(eq(workspaceMembers.role, "owner"));
  return rows.map((r) => r.userId);
}

// received_at plus UUID is a stable total order, including equal intake timestamps.
// Keep comparison in SQL so PostgreSQL timestamp precision is preserved.
export async function mayOpenReply(tx: OutreachTx, signalId: string): Promise<boolean> {
  const [signal] = await tx.select().from(replySignals).where(and(eq(replySignals.id, signalId), eq(replySignals.status, "not_opt_out"), isNotNull(replySignals.text)));
  if (!signal?.personId) return false;
  const [represented] = await tx.select({ id: items.id }).from(items)
    .innerJoin(replySignals, sql`${items.payload}->>'signalId' = ${replySignals.id}::text`)
    .where(and(eq(items.kind, "reply"), eq(replySignals.personId, signal.personId), signal.actionId ? eq(replySignals.actionId, signal.actionId) : isNull(replySignals.actionId),
      sql`(${replySignals.receivedAt}, ${replySignals.id}) >= (select received_at, id from reply_signals where id = ${signalId})`)).limit(1);
  return !represented;
}

/** Drops only replies through the settled Item's boundary; pending decisions retain their evidence. */
export async function clearThreadText(tx: OutreachTx, personId: string, actionId: string | null, signalId: string): Promise<void> {
  await tx
    .update(replySignals)
    .set({ text: null })
    .where(and(eq(replySignals.personId, personId), actionId ? eq(replySignals.actionId, actionId) : isNull(replySignals.actionId), eq(replySignals.kind, "reply"), eq(replySignals.status, "not_opt_out"), sql`(${replySignals.receivedAt}, ${replySignals.id}) <= (select received_at, id from reply_signals where id = ${signalId})`, isNotNull(replySignals.text)));
}
