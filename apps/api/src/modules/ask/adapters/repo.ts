// SPDX-License-Identifier: AGPL-3.0-only
// Every Ask SQL statement. A message is never deleted; its run and reply are each written once.
import { and, desc, eq, inArray, isNull } from "drizzle-orm";
import { withWorkspace, type WorkspaceTx } from "@direx/db";
import { askMessages, askStarts } from "@direx/db/schema-ask";

export type AskMessageRow = typeof askMessages.$inferSelect;

export const inWorkspace = <T>(workspaceId: string, fn: (tx: WorkspaceTx) => Promise<T>) => withWorkspace(workspaceId, fn);

export async function insertMessage(tx: WorkspaceTx, m: { workspaceId: string; userId: string; text: string; itemId: string | null; agent: string | null; createdAt: Date }): Promise<AskMessageRow> {
  const [row] = await tx.insert(askMessages).values(m).returning();
  return row!;
}

export const setRun = (tx: WorkspaceTx, id: string, runId: string) => tx.update(askMessages).set({ runId }).where(and(eq(askMessages.id, id), isNull(askMessages.runId)));

/** The first reply stands: a retried run can't overwrite what the person already saw. */
export const setReply = (tx: WorkspaceTx, id: string, reply: unknown) => tx.update(askMessages).set({ reply }).where(and(eq(askMessages.id, id), isNull(askMessages.reply)));

export async function messageOfRun(tx: WorkspaceTx, runId: string): Promise<AskMessageRow | undefined> {
  const [row] = await tx.select().from(askMessages).where(eq(askMessages.runId, runId)).limit(1);
  return row;
}

/** One person's newest messages, oldest first, in the order they were written, so every caller agrees which is newest. */
export async function conversation(tx: WorkspaceTx, userId: string, limit: number): Promise<AskMessageRow[]> {
  const rows = await tx.select().from(askMessages).where(eq(askMessages.userId, userId)).orderBy(desc(askMessages.seq)).limit(limit);
  return rows.reverse();
}

export type AskStartRow = typeof askStarts.$inferSelect;

/** Written in the approval's transaction; a second approval of the same Item can't make a second row. */
export const insertStart = (tx: WorkspaceTx, row: { workspaceId: string; itemId: string; messageId: string; createdAt: Date }) => tx.insert(askStarts).values(row).onConflictDoNothing();

export async function startOf(tx: WorkspaceTx, itemId: string): Promise<AskStartRow | undefined> {
  const [row] = await tx.select().from(askStarts).where(eq(askStarts.itemId, itemId));
  return row;
}

/** The outcome is written once: a retried job can't replace the work a start already made. */
export const setStartOutcome = (tx: WorkspaceTx, itemId: string, outcome: { workKind: string; workId: string } | { refused: string }) =>
  tx
    .update(askStarts)
    .set(outcome)
    .where(and(eq(askStarts.itemId, itemId), isNull(askStarts.workKind), isNull(askStarts.refused)));

export const startsOfMessages = (tx: WorkspaceTx, messageIds: string[]) => (messageIds.length ? tx.select().from(askStarts).where(inArray(askStarts.messageId, messageIds)) : Promise.resolve([] as AskStartRow[]));
