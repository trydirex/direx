// SPDX-License-Identifier: AGPL-3.0-only
// Storage for Mailbox header checks. The newest row for a credential is its current check, and a
// result is written only onto the check that is still current, for the same probe and settings.
import type { WorkspaceTx } from "@direx/db";
import { mailboxHeaderChecks } from "@direx/db/schema-outreach";
import { and, desc, eq, gte, isNotNull, sql } from "drizzle-orm";

export type HeaderCheck = typeof mailboxHeaderChecks.$inferSelect;
export type CheckState = "unchecked" | "pending" | "passed" | "replies_only" | "failed" | "inconclusive";

export async function currentCheck(tx: WorkspaceTx, credentialId: string): Promise<HeaderCheck | null> {
  const [row] = await tx
    .select()
    .from(mailboxHeaderChecks)
    .where(eq(mailboxHeaderChecks.credentialId, credentialId))
    .orderBy(desc(mailboxHeaderChecks.seq))
    .limit(1);
  return row ?? null;
}

export async function startCheck(
  tx: WorkspaceTx,
  row: { workspaceId: string; credentialId: string; probeActionId: string | null; probeSubject: string | null; settingsHash: string; state: "pending" | "unchecked"; reason?: string | null; createdBy: string | null; createdAt: Date },
): Promise<HeaderCheck> {
  const [created] = await tx.insert(mailboxHeaderChecks).values(row).returning();
  return created!;
}

/**
 * Settles the current check, only if it is still pending for this probe and these settings. False
 * when a newer check, a settings change or another settle got there first.
 */
export async function settleCheck(
  tx: WorkspaceTx,
  a: { credentialId: string; probeActionId: string; settingsHash: string; state: Exclude<CheckState, "pending" | "unchecked">; failures?: string[]; warnings?: string[]; reason?: string | null; settledAt: Date },
): Promise<boolean> {
  // Locking the current row makes two settles of one probe take turns, so only the first writes.
  const [current] = await tx
    .select()
    .from(mailboxHeaderChecks)
    .where(eq(mailboxHeaderChecks.credentialId, a.credentialId))
    .orderBy(desc(mailboxHeaderChecks.seq))
    .limit(1)
    .for("update");
  if (!current || current.state !== "pending" || current.probeActionId !== a.probeActionId || current.settingsHash !== a.settingsHash) return false;
  await tx
    .update(mailboxHeaderChecks)
    .set({ state: a.state, failures: a.failures ?? [], warnings: a.warnings ?? [], reason: a.reason ?? null, settledAt: a.settledAt })
    .where(eq(mailboxHeaderChecks.id, current.id));
  return true;
}

/** Each credential's current check. */
export function currentChecks(tx: WorkspaceTx): Promise<HeaderCheck[]> {
  return tx.selectDistinctOn([mailboxHeaderChecks.credentialId]).from(mailboxHeaderChecks).orderBy(mailboxHeaderChecks.credentialId, desc(mailboxHeaderChecks.seq));
}

/** Every credential whose current check is still pending, with that check. */
export async function pendingChecks(tx: WorkspaceTx): Promise<HeaderCheck[]> {
  return (await currentChecks(tx)).filter((r) => r.state === "pending");
}

/** How many probes this Mailbox has sent since a time, for the daily limit. */
export async function probesSince(tx: WorkspaceTx, credentialId: string, since: Date): Promise<number> {
  const [row] = await tx
    .select({ n: sql<number>`count(*)::int` })
    .from(mailboxHeaderChecks)
    .where(and(eq(mailboxHeaderChecks.credentialId, credentialId), isNotNull(mailboxHeaderChecks.probeActionId), gte(mailboxHeaderChecks.createdAt, since)));
  return row?.n ?? 0;
}
