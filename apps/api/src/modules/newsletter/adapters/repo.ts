// SPDX-License-Identifier: AGPL-3.0-only
import { withSystem, withWorkspace, type WorkspaceTx } from "@direx/db";
import { newsletterIssues, newsletterSettings } from "@direx/db/schema-newsletter";
import { and, desc, gt, isNotNull, isNull, lt, lte, or, sql } from "drizzle-orm";

export const inWorkspace = withWorkspace;
export type NewsletterTx = WorkspaceTx;
export type SettingsRow = typeof newsletterSettings.$inferSelect;

export async function readSettings(tx: WorkspaceTx): Promise<SettingsRow | null> {
  const [row] = await tx.select().from(newsletterSettings);
  return row ?? null;
}

/** Saves the choices a person made. Read-only and last-sent are the system's, so a save leaves them. */
export async function saveSettings(tx: WorkspaceTx, workspaceId: string, s: Pick<SettingsRow, "list" | "credentialId" | "weekday" | "sendTime" | "timeZone" | "enabled">, now: Date): Promise<SettingsRow> {
  const values = { ...s, updatedAt: now };
  const [row] = await tx
    .insert(newsletterSettings)
    .values({ workspaceId, ...values })
    .onConflictDoUpdate({ target: newsletterSettings.workspaceId, set: values })
    .returning();
  return row!;
}

export type IssueRow = typeof newsletterIssues.$inferSelect;

/** The Workspaces whose weekly issue is on, across tenants. Ids only. */
export async function enabledWorkspaces(): Promise<string[]> {
  const { rows } = await withSystem((tx) => tx.execute(sql`select workspace_id from system.newsletter_workspaces()`));
  return rows.map((r) => r.workspace_id as string);
}

/** Records the slot's issue, or leaves the one already there, so a second run makes nothing new. */
export async function insertIssue(tx: WorkspaceTx, workspaceId: string, slot: Date, itemId: string, now: Date): Promise<void> {
  await tx.insert(newsletterIssues).values({ workspaceId, slot, itemId, createdAt: now }).onConflictDoNothing({ target: [newsletterIssues.workspaceId, newsletterIssues.slot] });
}

export async function issueAt(tx: WorkspaceTx, slot: Date): Promise<IssueRow | null> {
  const [row] = await tx.select().from(newsletterIssues).where(sql`${newsletterIssues.slot} = ${slot.toISOString()}::timestamptz`);
  return row ?? null;
}

/** Issues whose slot passed since `since` and that never went out. */
export const unsentSince = (tx: WorkspaceTx, since: Date, now: Date): Promise<IssueRow[]> =>
  tx.select().from(newsletterIssues).where(and(gt(newsletterIssues.slot, since), lte(newsletterIssues.slot, now), isNull(newsletterIssues.sentAt)));

/** Issues newest slot first, those before `before` when given. */
export const issuesBefore = (tx: WorkspaceTx, before: Date | null, limit: number): Promise<IssueRow[]> =>
  tx.select().from(newsletterIssues).where(before ? lt(newsletterIssues.slot, before) : undefined).orderBy(desc(newsletterIssues.slot)).limit(limit);

/** The issue an Item shows, so an issue route can never reach any other Item. */
export async function issueByItem(tx: WorkspaceTx, itemId: string): Promise<IssueRow | null> {
  const [row] = await tx.select().from(newsletterIssues).where(sql`${newsletterIssues.itemId} = ${itemId}`);
  return row ?? null;
}

/** Issues that may still need their send recorded or their stats read: slot or send within `since`. */
export const recentIssues = (tx: WorkspaceTx, since: Date): Promise<IssueRow[]> =>
  tx.select().from(newsletterIssues).where(or(and(isNull(newsletterIssues.sentAt), gt(newsletterIssues.slot, since)), and(isNotNull(newsletterIssues.sentAt), gt(newsletterIssues.sentAt, since))));

/** The issue went out: its id at the tool and when. The Workspace's last send only ever moves forward. */
export async function recordSent(tx: WorkspaceTx, id: string, providerRef: string | null, sentAt: Date, now: Date): Promise<void> {
  await tx.update(newsletterIssues).set({ providerRef, sentAt }).where(sql`${newsletterIssues.id} = ${id}`);
  await tx
    .update(newsletterSettings)
    .set({ lastSentAt: sql`greatest(${newsletterSettings.lastSentAt}, ${sentAt.toISOString()}::timestamptz)`, updatedAt: now });
}

export async function saveStats(tx: WorkspaceTx, id: string, stats: unknown, at: Date): Promise<void> {
  await tx.update(newsletterIssues).set({ stats, statsReadAt: at }).where(sql`${newsletterIssues.id} = ${id}`);
}

/** The tool refused to send on this plan. The first refusal's time and reason stand until cleared. */
export async function setReadOnly(tx: WorkspaceTx, reason: string, now: Date): Promise<void> {
  await tx.update(newsletterSettings).set({ readOnlySince: now, readOnlyReason: reason, updatedAt: now }).where(isNull(newsletterSettings.readOnlySince));
}

/** A new key for this list may be on another plan, so the list tries sending again. */
export async function clearReadOnly(tx: WorkspaceTx, credentialId: string, now: Date): Promise<boolean> {
  const rows = await tx
    .update(newsletterSettings)
    .set({ readOnlySince: null, readOnlyReason: null, updatedAt: now })
    .where(and(sql`${newsletterSettings.credentialId} = ${credentialId}`, isNotNull(newsletterSettings.readOnlySince)))
    .returning();
  return rows.length > 0;
}

/** This slot's issue is now shown by another Item, as when a refused send becomes a handoff. */
export async function moveIssueItem(tx: WorkspaceTx, id: string, itemId: string): Promise<void> {
  await tx.update(newsletterIssues).set({ itemId }).where(sql`${newsletterIssues.id} = ${id}`);
}
