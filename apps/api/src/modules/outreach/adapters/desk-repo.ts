// SPDX-License-Identifier: AGPL-3.0-only
// Every SQL statement of the reply desk: who owns a reply, and clearing a thread's text once it is settled.
import { approvals, credentials, workspaceMembers } from "@direx/db/schema";
import { replySignals } from "@direx/db/schema-outreach";
import { and, eq, isNotNull, isNull } from "drizzle-orm";
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

/** Drops the words of every reply in this Person's thread. A reply in no thread of ours has a null Action. */
export async function clearThreadText(tx: OutreachTx, personId: string, actionId: string | null): Promise<void> {
  await tx
    .update(replySignals)
    .set({ text: null })
    .where(and(eq(replySignals.personId, personId), actionId ? eq(replySignals.actionId, actionId) : isNull(replySignals.actionId), eq(replySignals.kind, "reply"), isNotNull(replySignals.text)));
}
