// SPDX-License-Identifier: AGPL-3.0-only
import { withWorkspace, type WorkspaceTx } from "@direx/db";
import { newsletterSubscribers, outreachSettings, personEligibility, replySignals, suppressions, unsubscribeTokens } from "@direx/db/schema-outreach";
import { and, eq, gte, inArray, lt, or, sql } from "drizzle-orm";

export const inWorkspace = withWorkspace;
export type OutreachTx = WorkspaceTx;
export type Settings = typeof outreachSettings.$inferSelect;

/** Replies people wrote, received in [from, to), and how many of them asked to stop. Bounces and read-backs aren't replies. */
export async function countReplies(tx: WorkspaceTx, from: Date, to: Date) {
  const [r] = await tx
    .select({ replies: sql<number>`count(*)::int`, optedOut: sql<number>`count(*) filter (where ${replySignals.status} = 'opted_out')::int` })
    .from(replySignals)
    .where(and(eq(replySignals.kind, "reply"), gte(replySignals.receivedAt, from), lt(replySignals.receivedAt, to)));
  return r!;
}

export async function readSettings(tx: WorkspaceTx): Promise<Settings | null> {
  const [row] = await tx.select().from(outreachSettings);
  return row ?? null;
}

export async function saveSettings(tx: WorkspaceTx, workspaceId: string, set: Partial<Settings>, now: Date): Promise<Settings> {
  const values = { ...set, updatedAt: now };
  const [row] = await tx
    .insert(outreachSettings)
    .values({ workspaceId, ...values })
    .onConflictDoUpdate({ target: outreachSettings.workspaceId, set: values })
    .returning();
  return row!;
}

export async function suppress(tx: WorkspaceTx, workspaceId: string, email: string, reason: "unsubscribe" | "manual" | "reply" | "hard_bounce", now: Date) {
  await tx.insert(suppressions).values({ workspaceId, email, reason, createdAt: now }).onConflictDoNothing();
}

export type SubscriberState = "subscribed" | "unsubscribed" | "bounced" | "complained" | "other";

/**
 * Records one page of a newsletter list. A new address is added; a known one keeps when it was first
 * seen and takes its latest state. Nothing is removed, so an address the tool stopped listing stays.
 */
export async function upsertSubscribers(tx: WorkspaceTx, workspaceId: string, credentialId: string, rows: readonly { email: string; state: SubscriberState }[], at: Date) {
  if (!rows.length) return;
  // The same address twice in one page keeps its last state.
  const unique = [...new Map(rows.map((r) => [r.email.toLowerCase(), r.state])).entries()];
  await tx
    .insert(newsletterSubscribers)
    .values(unique.map(([email, state]) => ({ workspaceId, credentialId, email, state, firstSeenAt: at, lastSeenAt: at })))
    .onConflictDoUpdate({
      target: [newsletterSubscribers.workspaceId, newsletterSubscribers.credentialId, newsletterSubscribers.email],
      set: { state: sql`excluded.state`, lastSeenAt: sql`excluded.last_seen_at` },
    });
}

export type ContactSummary = { name: string | null; company: string | null; campaign: { id: string; title: string } | null; lastEmailAt: Date | null; replied: boolean };

/**
 * For each Person, in one query: the name and company their latest Campaign row holds, that Campaign
 * and its plan's title, when Direx last sent them an email, and whether they ever replied.
 */
export async function contactSummaries(tx: WorkspaceTx, personIds: readonly string[]): Promise<Map<string, ContactSummary>> {
  if (!personIds.length) return new Map();
  const { rows } = await tx.execute<{ person_id: string; name: string | null; company: string | null; campaign_id: string | null; title: string | null; last_email_at: string | Date | null; replied: boolean }>(sql`
    select p.id as person_id, cp.first_name as name, cp.company, cp.campaign_id, mp.title, sent.at as last_email_at,
      exists (select 1 from reply_signals r where r.person_id = p.id and r.kind = 'reply') as replied
    from people p
    left join lateral (select x.campaign_id, x.first_name, x.company from campaign_people x where x.person_id = p.id order by x.at desc limit 1) cp on true
    left join campaigns c on c.id = cp.campaign_id
    left join marketing_plans mp on mp.workspace_id = c.workspace_id and mp.id = c.plan_id
    left join (
      select a.spec -> 'touch' ->> 'personId' as person_id, max(coalesce(a.first_dispatched_at, a.updated_at)) as at
      from actions a where a.state = 'sent' and a.spec ? 'touch' group by 1
    ) sent on sent.person_id = p.id::text
    where p.id in (${sql.join(personIds.map((id) => sql`${id}::uuid`), sql`, `)})`);
  return new Map(
    rows.map((r) => [
      r.person_id,
      {
        name: r.name,
        company: r.company,
        campaign: r.campaign_id ? { id: r.campaign_id, title: r.title ?? "" } : null,
        lastEmailAt: r.last_email_at === null ? null : new Date(r.last_email_at),
        replied: r.replied,
      },
    ]),
  );
}

/** Which of these addresses have ever been on a connected newsletter list, and since when. */
export async function subscribedAmong(tx: WorkspaceTx, emails: readonly string[]): Promise<{ email: string; credentialId: string; firstSeenAt: Date }[]> {
  if (!emails.length) return [];
  return tx
    .select({ email: newsletterSubscribers.email, credentialId: newsletterSubscribers.credentialId, firstSeenAt: newsletterSubscribers.firstSeenAt })
    .from(newsletterSubscribers)
    .where(inArray(newsletterSubscribers.email, emails.map((e) => e.toLowerCase())));
}

export async function suppressedAmong(tx: WorkspaceTx, emails: string[]): Promise<string[]> {
  if (!emails.length) return [];
  const rows = await tx.select({ email: suppressions.email }).from(suppressions).where(inArray(suppressions.email, emails));
  return rows.map((r) => r.email);
}

export async function insertToken(tx: WorkspaceTx, workspaceId: string, tokenHash: string, email: string, now: Date) {
  await tx.insert(unsubscribeTokens).values({ workspaceId, tokenHash, email, createdAt: now });
}

export async function emailForToken(tx: WorkspaceTx, tokenHash: string): Promise<string | null> {
  const [row] = await tx.select({ email: unsubscribeTokens.email }).from(unsubscribeTokens).where(eq(unsubscribeTokens.tokenHash, tokenHash));
  return row?.email ?? null;
}

export async function saveEligibility(tx: WorkspaceTx, row: typeof personEligibility.$inferInsert) {
  await tx
    .insert(personEligibility)
    .values(row)
    .onConflictDoUpdate({ target: [personEligibility.workspaceId, personEligibility.personId], set: row });
}

export async function eligibilityOf(tx: WorkspaceTx, personIds: string[]) {
  if (!personIds.length) return [];
  return tx.select().from(personEligibility).where(inArray(personEligibility.personId, personIds));
}

export type Signal = typeof replySignals.$inferSelect;
export type NewSignal = typeof replySignals.$inferInsert;

/** Null when this message was already recorded. */
export async function insertSignal(tx: WorkspaceTx, row: NewSignal): Promise<Signal | null> {
  const [signal] = await tx.insert(replySignals).values(row).onConflictDoNothing().returning();
  return signal ?? null;
}

export async function readSignal(tx: WorkspaceTx, id: string): Promise<Signal | null> {
  const [signal] = await tx.select().from(replySignals).where(eq(replySignals.id, id));
  return signal ?? null;
}

export async function lockSignal(tx: WorkspaceTx, id: string): Promise<Signal | null> {
  const [signal] = await tx.select().from(replySignals).where(eq(replySignals.id, id)).for("update");
  return signal ?? null;
}

export async function settleSignal(tx: WorkspaceTx, id: string, set: Partial<Pick<Signal, "status" | "decidedBy" | "decidedAt" | "quote" | "text">>) {
  await tx.update(replySignals).set(set).where(eq(replySignals.id, id));
}

/** Whether a reply from this Person's group, or in a thread sent to them, is still undecided. */
export async function hasOpenSignal(tx: WorkspaceTx, emails: string[], personId: string): Promise<boolean> {
  const whose = emails.length ? or(inArray(replySignals.senderEmail, emails), eq(replySignals.personId, personId)) : eq(replySignals.personId, personId);
  const rows = await tx.select({ id: replySignals.id }).from(replySignals).where(and(inArray(replySignals.status, ["pending", "needs_person"]), whose)).limit(1);
  return rows.length > 0;
}

export async function suppressionReasons(tx: WorkspaceTx, emails: string[]): Promise<string[]> {
  if (!emails.length) return [];
  const rows = await tx.select({ reason: suppressions.reason }).from(suppressions).where(inArray(suppressions.email, emails));
  return rows.map((r) => r.reason);
}

/** Whether any Workspace purged from this one's Organization left its opt-outs as hashes (ADR 0030 Q6). */
export async function hashedOptOutsExist(tx: WorkspaceTx): Promise<boolean> {
  const r = await tx.execute<{ found: boolean }>(sql`select system.hashed_opt_outs_exist() as found`);
  return Boolean(r.rows[0]?.found);
}

/** Whether one of these hashes is an opt-out kept from a purged Workspace of this Organization. */
export async function hashedOptOut(tx: WorkspaceTx, hashes: string[]): Promise<boolean> {
  if (!hashes.length) return false;
  const r = await tx.execute<{ found: boolean }>(sql`select system.hashed_opt_out(${sql.param(hashes)}::text[]) as found`);
  return Boolean(r.rows[0]?.found);
}

/** Removes these addresses' reply opt-outs and keeps a record of each; other reasons stay. How many were removed. */
export async function undoReplySuppressions(tx: WorkspaceTx, emails: string[], undoneBy: string, reason: string, quote: string | null): Promise<number> {
  const r = await tx.execute<{ n: number }>(sql`select system.undo_reply_suppressions(${sql.param(emails)}::text[], ${undoneBy}::uuid, ${reason}, ${quote}) as n`);
  return Number(r.rows[0]!.n);
}

/** Why each of these addresses is suppressed, with the sender's own words when they asked in a reply. */
export async function suppressionDetails(tx: WorkspaceTx, emails: string[]): Promise<Map<string, { reason: string; quote: string | null }>> {
  if (!emails.length) return new Map();
  const rows = await tx.select({ email: suppressions.email, reason: suppressions.reason }).from(suppressions).where(inArray(suppressions.email, emails));
  const quotes = await tx.select({ email: replySignals.senderEmail, quote: replySignals.quote }).from(replySignals).where(and(inArray(replySignals.senderEmail, emails), eq(replySignals.status, "opted_out")));
  const said = new Map(quotes.map((q) => [q.email, q.quote]));
  return new Map(rows.map((r) => [r.email, { reason: r.reason, quote: said.get(r.email) ?? null }]));
}

/** Searches of a new Person's recent mail that should have finished by now. */
export async function overdueReadBacks(tx: WorkspaceTx, before: Date): Promise<string[]> {
  const rows = await tx
    .select({ id: replySignals.id })
    .from(replySignals)
    .where(and(eq(replySignals.kind, "read_back"), eq(replySignals.status, "pending"), lt(replySignals.receivedAt, before)));
  return rows.map((r) => r.id);
}
