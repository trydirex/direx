// SPDX-License-Identifier: AGPL-3.0-only
// Hand-overs and their results. A batch's results, its addresses' Person and the job's cursor are
// written in one transaction, so a retried job starts after the last batch that was saved.
import type { WorkspaceTx } from "@direx/db";
import { personKeys } from "@direx/db/schema";
import { campaigns } from "@direx/db/schema-campaigns";
import { personEligibility } from "@direx/db/schema-outreach";
import { marketingPlans } from "@direx/db/schema-plans";
import { prospectAddresses, prospectCohorts, prospectCompanies, prospectHandoverResults, prospectHandovers, prospectSignals, prospectSnapshots } from "@direx/db/schema-prospecting";
import { ADDRESS_KINDS } from "../domain/cohort-filter";
import { and, asc, desc, eq, gt, inArray, isNotNull, isNull, sql } from "drizzle-orm";

export type HandoverStatus = "added" | "joined" | "conflict" | "left_out";
export type HandoverResultRow = { addressId: string; status: HandoverStatus; reason: string | null; personId: string | null; conflictItemId: string | null; missing: string[]; basis?: string | null; evidence?: string | null };

const handoverColumns = {
  id: prospectHandovers.id,
  cohortId: prospectHandovers.cohortId,
  campaignId: prospectHandovers.campaignId,
  status: prospectHandovers.status,
  cursor: prospectHandovers.cursor,
  pendingAddressIds: prospectHandovers.pendingAddressIds,
  createdBy: prospectHandovers.createdBy,
  createdAt: prospectHandovers.createdAt,
  finishedAt: prospectHandovers.finishedAt, failureReason: prospectHandovers.failureReason };

/** A Campaign that takes People: one whose plan has an approved version (ADR 0023). A Draft reads as missing. */
export async function campaignExists(tx: WorkspaceTx, campaignId: string): Promise<boolean> {
  return (await tx.select({ id: campaigns.id }).from(campaigns).innerJoin(marketingPlans, eq(marketingPlans.id, campaigns.planId)).where(and(eq(campaigns.id, campaignId), isNotNull(marketingPlans.currentVersion)))).length > 0;
}

export async function addHandover(tx: WorkspaceTx, h: { workspaceId: string; cohortId: string; campaignId: string; userId: string; now: Date }): Promise<string> {
  const [row] = await tx
    .insert(prospectHandovers)
    .values({ workspaceId: h.workspaceId, cohortId: h.cohortId, campaignId: h.campaignId, createdBy: h.userId, createdAt: h.now })
    .returning({ id: prospectHandovers.id });
  return row!.id;
}

export async function handoverById(tx: WorkspaceTx, id: string) {
  const [row] = await tx.select(handoverColumns).from(prospectHandovers).where(eq(prospectHandovers.id, id));
  return row ?? null;
}

/** The cohort's name and the Campaign's title, so a hand-over can say what went where. */
export async function handoverNames(tx: WorkspaceTx, id: string) {
  const [row] = await tx
    .select({ cohortName: prospectCohorts.name, campaignTitle: marketingPlans.title })
    .from(prospectHandovers)
    .innerJoin(prospectCohorts, and(eq(prospectCohorts.workspaceId, prospectHandovers.workspaceId), eq(prospectCohorts.id, prospectHandovers.cohortId)))
    .innerJoin(campaigns, and(eq(campaigns.workspaceId, prospectHandovers.workspaceId), eq(campaigns.id, prospectHandovers.campaignId)))
    .innerJoin(marketingPlans, and(eq(marketingPlans.workspaceId, campaigns.workspaceId), eq(marketingPlans.id, campaigns.planId)))
    .where(eq(prospectHandovers.id, id));
  return row!;
}

/** Among these addresses, the ones a Person already in the Workspace has, whose recorded country is Canada. */
export async function canadianAddresses(tx: WorkspaceTx, emails: string[]): Promise<Set<string>> {
  if (!emails.length) return new Set();
  const rows = await tx
    .select({ email: personKeys.value })
    .from(personKeys)
    .innerJoin(personEligibility, and(eq(personEligibility.workspaceId, personKeys.workspaceId), eq(personEligibility.personId, personKeys.personId)))
    .where(and(eq(personKeys.kind, "email"), inArray(personKeys.value, emails), eq(personEligibility.country, "CA")));
  return new Set(rows.map((r) => r.email));
}

/**
 * The Campaign's reasons to leave an address out, read without writing: anyone in the address's group
 * opted out or was already sent something, or the Person was removed from this Campaign. The same rules
 * the Campaign applies when it takes the address; an address with no Person yet is its own group.
 */
export async function campaignSkips(tx: WorkspaceTx, campaignId: string, emails: string[]): Promise<Map<string, "suppressed" | "already_contacted" | "removed">> {
  if (!emails.length) return new Map();
  const { rows } = await tx.execute<{ email: string; suppressed: boolean; contacted: boolean; removed: boolean }>(sql`
    with input as (select distinct unnest(${sql.param(emails)}::text[]) as email),
    known as (
      select i.email, pk.person_id, p.coordination_id from input i
      left join person_keys pk on pk.kind = 'email' and pk.value = i.email
      left join people p on p.id = pk.person_id
    ),
    grp as (
      select k.email, coalesce(g.value, k.email) as e from known k
      left join people m on m.coordination_id = k.coordination_id
      left join person_keys g on g.person_id = m.id and g.kind = 'email'
    )
    select k.email,
      bool_or(exists (select 1 from grp join suppressions s on s.email = grp.e where grp.email = k.email)) as suppressed,
      bool_or(exists (
        select 1 from grp join actions a on a.state = 'sent' and a.spec -> 'to' @> jsonb_build_array(grp.e)
        where grp.email = k.email and a.capability not like '%/mailbox.probe' and a.capability not like '%/placement.%'
      )) as contacted,
      bool_or(exists (select 1 from campaign_people cp where cp.campaign_id = ${campaignId}::uuid and cp.person_id = k.person_id and cp.status = 'removed')) as removed
    from known k group by k.email`);
  const out = new Map<string, "suppressed" | "already_contacted" | "removed">();
  for (const r of rows) {
    const why = r.suppressed ? "suppressed" : r.contacted ? "already_contacted" : r.removed ? "removed" : null;
    if (why) out.set(r.email, why);
  }
  return out;
}

/** When each address was last checked, read after a re-check so the summary names the right date. */
export async function checkedAt(tx: WorkspaceTx, addressIds: string[]): Promise<Map<string, Date | null>> {
  if (!addressIds.length) return new Map();
  const rows = await tx.select({ id: prospectAddresses.id, at: prospectAddresses.verifiedAt }).from(prospectAddresses).where(inArray(prospectAddresses.id, addressIds));
  return new Map(rows.map((r) => [r.id, r.at]));
}

/** Checkpoint one batch before verification can change who matches the cohort. */
export async function savePendingBatch(tx: WorkspaceTx, handoverId: string, addressIds: string[]): Promise<void> {
  await tx.update(prospectHandovers).set({ pendingAddressIds: addressIds }).where(eq(prospectHandovers.id, handoverId));
}

/** Reload the selected addresses that are still kept at accepted companies. */
export async function pendingMembers(tx: WorkspaceTx, workspaceId: string, ids: string[]) {
  const a = prospectAddresses;
  const c = prospectCompanies;
  const s = prospectSnapshots;
  const rows = await tx.select({
    addressId: a.id, email: a.email, name: a.name, source: a.source, pattern: a.pattern,
    company: { name: c.name, domain: c.domain, country: c.country },
    evidence: { pageUrl: s.pageUrl, readAt: a.readAt, snapshotId: a.snapshotId },
  }).from(a)
    .innerJoin(c, and(eq(c.workspaceId, a.workspaceId), eq(c.id, a.companyId)))
    .innerJoin(s, and(eq(s.workspaceId, a.workspaceId), eq(s.id, a.snapshotId)))
    .where(and(eq(a.workspaceId, workspaceId), inArray(a.id, ids), isNull(a.leftOutReason), inArray(a.kind, [...ADDRESS_KINDS]), eq(c.state, "accepted")))
    .orderBy(asc(a.id));
  return rows.map((r) => ({ ...r, evidence: { ...r.evidence, readAt: r.evidence.readAt.toISOString() } }));
}

export async function saveBatch(tx: WorkspaceTx, b: { workspaceId: string; handoverId: string; results: HandoverResultRow[]; cursor: string; at: Date }): Promise<void> {
  if (b.results.length) {
    await tx
      .insert(prospectHandoverResults)
      .values(b.results.map((r) => ({ ...r, workspaceId: b.workspaceId, handoverId: b.handoverId, createdAt: b.at })))
      .onConflictDoNothing();
  }
  for (const r of b.results) {
    if (r.status !== "left_out") await tx.update(prospectAddresses).set({ personId: r.personId }).where(eq(prospectAddresses.id, r.addressId));
  }
  await tx.update(prospectHandovers).set({ cursor: b.cursor, pendingAddressIds: null }).where(eq(prospectHandovers.id, b.handoverId));
}

/** The job gave up: the hand-over stops where it is, saying why. Only a running one changes. */
export async function failHandover(tx: WorkspaceTx, id: string, reason: string, at: Date): Promise<void> {
  await tx.update(prospectHandovers).set({ status: "failed", failureReason: reason, finishedAt: at }).where(and(eq(prospectHandovers.id, id), eq(prospectHandovers.status, "running")));
}

export async function finishHandover(tx: WorkspaceTx, id: string, at: Date): Promise<void> {
  await tx.update(prospectHandovers).set({ status: "done", finishedAt: at }).where(eq(prospectHandovers.id, id));
}

export async function handoverCounts(tx: WorkspaceTx, id: string): Promise<Record<HandoverStatus, number>> {
  const rows = await tx
    .select({ status: prospectHandoverResults.status, n: sql<number>`count(*)::int` })
    .from(prospectHandoverResults)
    .where(eq(prospectHandoverResults.handoverId, id))
    .groupBy(prospectHandoverResults.status);
  const counts = { added: 0, joined: 0, conflict: 0, left_out: 0 };
  for (const r of rows) counts[r.status as HandoverStatus] = r.n;
  return counts;
}

/** One page of a hand-over's results in address order, each with its address. */
export async function resultsPage(tx: WorkspaceTx, id: string, cursor: string | undefined, limit: number) {
  return tx
    .select({
      addressId: prospectHandoverResults.addressId,
      email: prospectAddresses.email,
      status: prospectHandoverResults.status,
      reason: prospectHandoverResults.reason,
      personId: prospectHandoverResults.personId,
      conflictItemId: prospectHandoverResults.conflictItemId,
      missing: prospectHandoverResults.missing,
    })
    .from(prospectHandoverResults)
    .innerJoin(prospectAddresses, and(eq(prospectAddresses.workspaceId, prospectHandoverResults.workspaceId), eq(prospectAddresses.id, prospectHandoverResults.addressId)))
    .where(and(eq(prospectHandoverResults.handoverId, id), cursor ? gt(prospectHandoverResults.addressId, cursor) : undefined))
    .orderBy(asc(prospectHandoverResults.addressId))
    .limit(limit);
}

/** The signals of every company a Person's handed-over addresses came from, newest first. */
export async function signalsOfPerson(tx: WorkspaceTx, personId: string) {
  const companies = tx.select({ id: prospectAddresses.companyId }).from(prospectAddresses).where(eq(prospectAddresses.personId, personId));
  return tx
    .select({ type: prospectSignals.type, quote: prospectSignals.quote, pageUrl: prospectSignals.pageUrl, observedOn: prospectSignals.observedOn })
    .from(prospectSignals)
    .where(inArray(prospectSignals.companyId, companies))
    .orderBy(desc(prospectSignals.observedOn), asc(prospectSignals.type), asc(prospectSignals.pageUrl));
}

/** How each of a Person's handed-over addresses was found. */
/** The basis and evidence an address last went over with, newest first, for a Person whose country came later. */
export async function keptFor(tx: WorkspaceTx, email: string): Promise<{ basis: string; evidence: string } | null> {
  const [row] = await tx
    .select({ basis: prospectHandoverResults.basis, evidence: prospectHandoverResults.evidence })
    .from(prospectHandoverResults)
    .innerJoin(prospectAddresses, eq(prospectAddresses.id, prospectHandoverResults.addressId))
    .where(and(eq(prospectAddresses.email, email.toLowerCase()), isNotNull(prospectHandoverResults.basis)))
    .orderBy(desc(prospectHandoverResults.createdAt))
    .limit(1);
  return row?.basis && row.evidence ? { basis: row.basis, evidence: row.evidence } : null;
}

export async function addressesOfPerson(tx: WorkspaceTx, personId: string) {
  return tx.select({ kind: prospectAddresses.kind, source: prospectAddresses.source }).from(prospectAddresses).where(eq(prospectAddresses.personId, personId));
}
