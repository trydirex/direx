// SPDX-License-Identifier: AGPL-3.0-only
// Every SQL statement of the reply desk: who owns a reply, and clearing a thread's text once it is settled.
import { actions, approvals, credentials, items, workspaceMembers } from "@direx/db/schema";
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

/** Drops the words of every reply in this Person's thread. A reply in no thread of ours has a null Action. */
export async function clearThreadText(tx: OutreachTx, personId: string, actionId: string | null): Promise<void> {
  await tx
    .update(replySignals)
    .set({ text: null })
    .where(and(eq(replySignals.personId, personId), actionId ? eq(replySignals.actionId, actionId) : isNull(replySignals.actionId), eq(replySignals.kind, "reply"), isNotNull(replySignals.text)));
}

/** Whether a reply in this thread was already sorted as wanting to talk, so its owner was already told. */
export async function threadWasInterested(tx: OutreachTx, groupKey: string): Promise<boolean> {
  const rows = await tx.select({ id: items.id }).from(items).where(and(eq(items.kind, "reply"), eq(items.groupKey, groupKey), sql`${items.payload}->>'label' = 'interested'`)).limit(1);
  return rows.length > 0;
}

/** The subject of our email being replied to: our own words, never the reply's. */
export async function sentSubject(tx: OutreachTx, actionId: string): Promise<string | null> {
  const [row] = await tx.select({ subject: sql<string | null>`${actions.spec}->>'subject'` }).from(actions).where(eq(actions.id, actionId));
  return row?.subject ?? null;
}
