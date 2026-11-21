// SPDX-License-Identifier: AGPL-3.0-only
// Every SQL statement of a Mailbox's pause and ramp, which live in credential columns beside its pace.
import { actions, credentials } from "@direx/db/schema";
import { and, desc, eq, gt, isNotNull, isNull, sql } from "drizzle-orm";
import { RAMP_FLOOR, type RampState } from "../domain/ramp";
import type { OutreachTx } from "./repo";

export type PauseReason = "bounces" | "provider_abuse" | "person";
export type PauseState = { pausedAt: Date | null; pauseReason: PauseReason | null; resumedAt: Date | null };

const live = (credentialId: string) => and(eq(credentials.id, credentialId), isNull(credentials.deletedAt));

/** A credential's pause, or undefined when there is no such credential. A pause holds only email, so any credential may carry one. */
export async function pauseOf(tx: OutreachTx, credentialId: string): Promise<PauseState | undefined> {
  const [row] = await tx.select({ pausedAt: credentials.pausedAt, pauseReason: credentials.pauseReason, resumedAt: credentials.resumedAt }).from(credentials).where(live(credentialId));
  return row && { ...row, pauseReason: row.pauseReason as PauseReason | null };
}

/** The Mailbox's latest sent emails after `since`, newest first, each saying whether it bounced. */
export async function latestSends(tx: OutreachTx, credentialId: string, since: Date | null, limit: number): Promise<{ bounced: boolean }[]> {
  return tx
    // Named in full: inside a select list Drizzle drops the table from a column, and "id" would mean the signal's.
    .select({ bounced: sql<boolean>`exists (select 1 from reply_signals s where s.action_id = "actions"."id" and s.kind = 'bounce')` })
    .from(actions)
    .where(and(eq(actions.credentialId, credentialId), eq(actions.state, "sent"), sql`${actions.capability} like '%/email.send'`, since ? gt(actions.firstDispatchedAt, since) : undefined))
    .orderBy(desc(actions.firstDispatchedAt))
    .limit(limit);
}

/** Pauses a Mailbox that isn't paused yet. */
export async function setPause(tx: OutreachTx, credentialId: string, p: { reason: PauseReason; by: string | null; at: Date; resumedAt?: Date | null }): Promise<void> {
  await tx
    .update(credentials)
    .set({ pausedAt: p.at, pauseReason: p.reason, pausedBy: p.by })
    .where(and(live(credentialId), isNull(credentials.pausedAt), p.resumedAt === undefined ? undefined : p.resumedAt === null ? isNull(credentials.resumedAt) : eq(credentials.resumedAt, p.resumedAt)));
}

export async function clearPause(tx: OutreachTx, credentialId: string, at: Date): Promise<void> {
  await tx.update(credentials).set({ pausedAt: null, pauseReason: null, pausedBy: null, resumedAt: at }).where(live(credentialId));
}

/** Every paused Mailbox in the Workspace. */
export async function pausedMailboxes(tx: OutreachTx): Promise<{ credentialId: string; pausedAt: Date; reason: PauseReason }[]> {
  const rows = await tx
    .select({ credentialId: credentials.id, pausedAt: credentials.pausedAt, reason: credentials.pauseReason })
    .from(credentials)
    .where(and(isNotNull(credentials.pausedAt), isNull(credentials.deletedAt)));
  return rows.map((r) => ({ credentialId: r.credentialId, pausedAt: r.pausedAt!, reason: r.reason as PauseReason }));
}

/** Halves a Mailbox's ramp and restarts its clean days. An established Mailbox has no ramp to halve. */
export async function halveRampOf(tx: OutreachTx, credentialId: string, at: Date): Promise<void> {
  await tx
    .update(credentials)
    .set({ rampLimit: sql`greatest(${RAMP_FLOOR}, ${credentials.rampLimit} / 2)`, rampCleanSince: at })
    .where(and(live(credentialId), isNotNull(credentials.rampLimit)));
}

/** Locks the ramp row against warning updates until the sweep transaction ends. */
export async function lockRamp(tx: OutreachTx, credentialId: string): Promise<boolean> {
  const [row] = await tx.select({ id: credentials.id }).from(credentials)
    .where(and(live(credentialId), isNotNull(credentials.rampLimit)))
    .for("no key update");
  return !!row;
}

/** A Mailbox's ramp with its emails sent and bounced since its clean days began, or undefined when it has none. */
export async function rampOf(tx: OutreachTx, credentialId: string): Promise<RampState | undefined> {
  const [row] = await tx
    .select({
      ramp: credentials.rampLimit,
      cleanSince: credentials.rampCleanSince,
      dailyLimit: credentials.dailyLimit,
      pausedAt: credentials.pausedAt,
      // Named in full, as in latestSends: inside a select list Drizzle drops the table from a column.
      sent: sql<number>`(select count(*)::int from actions a where a.credential_id = "credentials"."id" and a.state = 'sent' and a.capability like '%/email.send' and a.first_dispatched_at > "credentials"."ramp_clean_since")`,
      bounced: sql<number>`(select count(*)::int from reply_signals s join actions a on a.id = s.action_id where s.kind = 'bounce' and a.credential_id = "credentials"."id" and s.received_at > "credentials"."ramp_clean_since")`,
    })
    .from(credentials)
    .where(and(live(credentialId), isNotNull(credentials.rampLimit)));
  return row && { ramp: row.ramp!, cleanSince: row.cleanSince!, dailyLimit: row.dailyLimit, paused: !!row.pausedAt, sent: row.sent, bounced: row.bounced };
}

/** Sets a Mailbox's ramp and starts its clean days again. */
export async function setRamp(tx: OutreachTx, credentialId: string, ramp: number, at: Date): Promise<void> {
  await tx.update(credentials).set({ rampLimit: ramp, rampCleanSince: at }).where(and(live(credentialId), isNotNull(credentials.rampLimit)));
}
