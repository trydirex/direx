// SPDX-License-Identifier: AGPL-3.0-only
// Every Mailbox capacity SQL statement. Reservations are only inserted, never updated or deleted.
import { and, desc, eq, gte, inArray, isNotNull, isNull, lte, sql } from "drizzle-orm";
import { actions, credentials, mailboxReservations, mailboxSettingChanges, workspaces } from "@direx/db/schema";
import type { MailboxPace, MailboxReservationRow } from "../domain/mailbox";
import type { ScheduleTx } from "./schedule-repo";

/** The Mailbox an Action sends from, and what it does. */
export async function sendOf(tx: ScheduleTx, actionId: string): Promise<{ capability: string; credentialId: string | null } | undefined> {
  const [row] = await tx.select({ capability: actions.capability, credentialId: actions.credentialId }).from(actions).where(eq(actions.id, actionId));
  return row;
}

/** A Mailbox's pace and the time zone its days and hours are in. */
export async function paceOf(tx: ScheduleTx, credentialId: string): Promise<{ pace: MailboxPace; timeZone: string } | undefined> {
  const [row] = await tx
    .select({ dailyLimit: credentials.dailyLimit, sendFrom: credentials.sendFrom, sendUntil: credentials.sendUntil, sendWeekends: credentials.sendWeekends, timeZone: workspaces.timeZone })
    .from(credentials)
    .innerJoin(workspaces, eq(workspaces.id, credentials.workspaceId))
    .where(eq(credentials.id, credentialId));
  if (!row) return undefined;
  const { timeZone, ...pace } = row;
  return { pace, timeZone };
}

/**
 * Serializes everyone counting one Mailbox's days until the transaction ends. An advisory lock, not
 * the credential row: a token refresh holds that row across a network call.
 */
export async function lockMailbox(tx: ScheduleTx, credentialId: string): Promise<void> {
  await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`mailbox:${credentialId}`}, 0))`);
}

/**
 * The newest reservation of every Action that has one on a Mailbox's days in [from, to]. An Action
 * moved away keeps its old rows, so its newest is read wherever it lies.
 */
export async function newestAround(tx: ScheduleTx, credentialId: string, from: string, to: string): Promise<MailboxReservationRow[]> {
  const near = tx
    .select({ actionId: mailboxReservations.actionId })
    .from(mailboxReservations)
    .where(and(eq(mailboxReservations.credentialId, credentialId), gte(mailboxReservations.day, from), lte(mailboxReservations.day, to)));
  const rows = await tx
    .selectDistinctOn([mailboxReservations.actionId], { actionId: mailboxReservations.actionId, day: mailboxReservations.day, slot: mailboxReservations.slot, createdAt: mailboxReservations.createdAt })
    .from(mailboxReservations)
    .where(inArray(mailboxReservations.actionId, near))
    .orderBy(mailboxReservations.actionId, desc(mailboxReservations.createdAt));
  return rows;
}

/** The Action's newest Mailbox reservation. */
export async function newestFor(tx: ScheduleTx, actionId: string): Promise<MailboxReservationRow | undefined> {
  const [row] = await tx
    .select({ actionId: mailboxReservations.actionId, day: mailboxReservations.day, slot: mailboxReservations.slot, createdAt: mailboxReservations.createdAt })
    .from(mailboxReservations)
    .where(eq(mailboxReservations.actionId, actionId))
    .orderBy(desc(mailboxReservations.createdAt))
    .limit(1);
  return row;
}

export async function insertMailboxReservation(tx: ScheduleTx, r: { workspaceId: string; actionId: string; credentialId: string; day: string; slot: Date; createdAt: Date }): Promise<void> {
  await tx.insert(mailboxReservations).values(r);
}

/** Every Mailbox of the Workspace that has reservations on days in [from, to], with its pace. */
export async function mailboxesAround(tx: ScheduleTx, from: string, to: string): Promise<{ credentialId: string; name: string; pace: MailboxPace }[]> {
  const used = tx.selectDistinct({ id: mailboxReservations.credentialId }).from(mailboxReservations).where(and(gte(mailboxReservations.day, from), lte(mailboxReservations.day, to)));
  const rows = await tx
    .select({ credentialId: credentials.id, name: credentials.name, dailyLimit: credentials.dailyLimit, sendFrom: credentials.sendFrom, sendUntil: credentials.sendUntil, sendWeekends: credentials.sendWeekends })
    .from(credentials)
    .where(inArray(credentials.id, used));
  return rows.map(({ credentialId, name, ...pace }) => ({ credentialId, name, pace }));
}

/** A live Mailbox's pace and who connected it, locked for a change. */
export async function lockPace(tx: ScheduleTx, credentialId: string): Promise<{ pace: MailboxPace; createdBy: string | null } | undefined> {
  const [row] = await tx
    .select({ dailyLimit: credentials.dailyLimit, sendFrom: credentials.sendFrom, sendUntil: credentials.sendUntil, sendWeekends: credentials.sendWeekends, createdBy: credentials.createdBy })
    .from(credentials)
    .where(and(eq(credentials.id, credentialId), isNull(credentials.deletedAt), isNotNull(credentials.connection)))
    .for("no key update");
  if (!row) return undefined;
  const { createdBy, ...pace } = row;
  return { pace, createdBy };
}

/** Whether anyone has set this Mailbox's pace before. */
export async function paceEverSet(tx: ScheduleTx, credentialId: string): Promise<boolean> {
  const [row] = await tx.select({ id: mailboxSettingChanges.id }).from(mailboxSettingChanges).where(eq(mailboxSettingChanges.credentialId, credentialId)).limit(1);
  return !!row;
}

export async function writePace(tx: ScheduleTx, workspaceId: string, credentialId: string, before: MailboxPace, after: MailboxPace, changedBy: string, at: Date): Promise<void> {
  await tx.update(credentials).set(after).where(eq(credentials.id, credentialId));
  await tx.insert(mailboxSettingChanges).values({ workspaceId, credentialId, before, after, changedBy, changedAt: at });
}

export async function setWorkspaceZone(tx: ScheduleTx, workspaceId: string, timeZone: string): Promise<void> {
  await tx.update(workspaces).set({ timeZone }).where(eq(workspaces.id, workspaceId));
}

/** The Workspace's time zone. */
export async function workspaceZone(tx: ScheduleTx, workspaceId: string): Promise<string> {
  const [row] = await tx.select({ timeZone: workspaces.timeZone }).from(workspaces).where(eq(workspaces.id, workspaceId));
  return row?.timeZone ?? "UTC";
}
