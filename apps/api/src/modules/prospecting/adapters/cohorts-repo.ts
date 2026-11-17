// SPDX-License-Identifier: AGPL-3.0-only
// Saved cohorts and the addresses they match. Matching is done in SQL each time, so a company accepted
// after a cohort was saved shows up in it without anything being re-run.
import type { WorkspaceTx } from "@direx/db";
import { campaigns } from "@direx/db/schema-campaigns";
import { marketingPlans } from "@direx/db/schema-plans";
import { prospectAddresses, prospectCohorts, prospectCompanies, prospectHandoverResults, prospectHandovers, prospectSignals, prospectSnapshots } from "@direx/db/schema-prospecting";
import { and, asc, desc, eq, gt, inArray, isNull, sql, type SQL } from "drizzle-orm";
import { ADDRESS_KINDS, type CohortFilter } from "../domain/cohort-filter";

const cohortColumns = {
  id: prospectCohorts.id,
  name: prospectCohorts.name,
  filter: prospectCohorts.filter,
  createdBy: prospectCohorts.createdBy,
  createdAt: prospectCohorts.createdAt,
  updatedAt: prospectCohorts.updatedAt,
};

export async function addCohort(tx: WorkspaceTx, c: { workspaceId: string; name: string; filter: CohortFilter; userId: string; now: Date }) {
  const [row] = await tx
    .insert(prospectCohorts)
    .values({ workspaceId: c.workspaceId, name: c.name, filter: c.filter, createdBy: c.userId, createdAt: c.now, updatedAt: c.now })
    .returning(cohortColumns);
  return row!;
}

/** Null when there is no such cohort in this Workspace. */
export async function changeCohort(tx: WorkspaceTx, id: string, c: { name: string; filter: CohortFilter; now: Date }) {
  const [row] = await tx.update(prospectCohorts).set({ name: c.name, filter: c.filter, updatedAt: c.now }).where(eq(prospectCohorts.id, id)).returning(cohortColumns);
  return row ?? null;
}

export async function cohortById(tx: WorkspaceTx, id: string) {
  const [row] = await tx.select(cohortColumns).from(prospectCohorts).where(eq(prospectCohorts.id, id));
  return row ?? null;
}

export async function allCohorts(tx: WorkspaceTx) {
  return tx.select(cohortColumns).from(prospectCohorts).orderBy(asc(prospectCohorts.name), asc(prospectCohorts.id));
}

/**
 * Who a cohort can ever hold: kept addresses of a person or a team at an accepted company. An empty
 * list in the filter puts no limit on that field.
 */
function matches(workspaceId: string, f: CohortFilter): SQL {
  const kinds = f.kinds.length ? f.kinds : [...ADDRESS_KINDS];
  return and(
    eq(prospectAddresses.workspaceId, workspaceId),
    isNull(prospectAddresses.leftOutReason),
    inArray(prospectAddresses.kind, kinds),
    eq(prospectCompanies.state, "accepted"),
    f.sources.length ? inArray(prospectAddresses.source, f.sources) : undefined,
    f.verification.length ? inArray(prospectAddresses.verificationResult, f.verification) : undefined,
    f.countries.length ? inArray(prospectCompanies.country, f.countries) : undefined,
    f.runs.length ? inArray(prospectCompanies.firstRunId, f.runs) : undefined,
    f.signals.length || f.signalMaxAgeDays !== undefined ? hasSignal(f) : undefined,
  )!;
}

/** The company has a Signal of one of the types, read recently enough when an age is set. Today is the database's. */
function hasSignal(f: CohortFilter): SQL {
  const type = f.signals.length ? inArray(prospectSignals.type, f.signals) : undefined;
  const recent = f.signalMaxAgeDays !== undefined ? sql`${prospectSignals.observedOn} >= current_date - ${f.signalMaxAgeDays}::int` : undefined;
  return sql`exists (select 1 from ${prospectSignals} where ${and(eq(prospectSignals.workspaceId, prospectAddresses.workspaceId), eq(prospectSignals.companyId, prospectAddresses.companyId), type, recent)})`;
}

const companyOfAddress = and(eq(prospectCompanies.workspaceId, prospectAddresses.workspaceId), eq(prospectCompanies.id, prospectAddresses.companyId));

export async function cohortCount(tx: WorkspaceTx, workspaceId: string, f: CohortFilter): Promise<number> {
  const [row] = await tx
    .select({ n: sql<number>`count(*)::int` })
    .from(prospectAddresses)
    .innerJoin(prospectCompanies, companyOfAddress)
    .where(matches(workspaceId, f));
  return row!.n;
}

/** One page of matching addresses in address id order, each with the page it was read from. */
export async function cohortPage(tx: WorkspaceTx, workspaceId: string, f: CohortFilter, cursor: string | undefined, limit: number) {
  return tx
    .select({
      addressId: prospectAddresses.id,
      email: prospectAddresses.email,
      kind: prospectAddresses.kind,
      name: prospectAddresses.name,
      role: prospectAddresses.role,
      source: prospectAddresses.source,
      pattern: prospectAddresses.pattern,
      verificationResult: prospectAddresses.verificationResult,
      verifiedAt: prospectAddresses.verifiedAt,
      companyId: prospectCompanies.id,
      domain: prospectCompanies.domain,
      companyName: prospectCompanies.name,
      country: prospectCompanies.country,
      pageUrl: prospectSnapshots.pageUrl,
      readAt: prospectAddresses.readAt,
      snapshotId: prospectAddresses.snapshotId,
    })
    .from(prospectAddresses)
    .innerJoin(prospectCompanies, companyOfAddress)
    .innerJoin(prospectSnapshots, and(eq(prospectSnapshots.workspaceId, prospectAddresses.workspaceId), eq(prospectSnapshots.id, prospectAddresses.snapshotId)))
    .where(and(matches(workspaceId, f), cursor ? gt(prospectAddresses.id, cursor) : undefined))
    .orderBy(asc(prospectAddresses.id))
    .limit(limit);
}

const wentOver = inArray(prospectHandoverResults.status, ["added", "joined"]);
const resultsOf = and(eq(prospectHandoverResults.workspaceId, prospectHandovers.workspaceId), eq(prospectHandoverResults.handoverId, prospectHandovers.id));

/**
 * The Campaigns a cohort was handed to, latest first, each with how many People went over to it, and
 * how many different People went over to any of them.
 */
export async function cohortUse(tx: WorkspaceTx, cohortId: string) {
  const usedBy = await tx
    .select({
      campaignId: prospectHandovers.campaignId,
      title: marketingPlans.title,
      people: sql<number>`count(distinct ${prospectHandoverResults.personId}) filter (where ${wentOver})::int`,
      lastAddedAt: sql<Date>`max(${prospectHandovers.createdAt})`.mapWith(prospectHandovers.createdAt),
    })
    .from(prospectHandovers)
    .innerJoin(campaigns, and(eq(campaigns.workspaceId, prospectHandovers.workspaceId), eq(campaigns.id, prospectHandovers.campaignId)))
    .innerJoin(marketingPlans, and(eq(marketingPlans.workspaceId, campaigns.workspaceId), eq(marketingPlans.id, campaigns.planId)))
    .leftJoin(prospectHandoverResults, resultsOf)
    .where(eq(prospectHandovers.cohortId, cohortId))
    .groupBy(prospectHandovers.campaignId, marketingPlans.title)
    .orderBy(desc(sql`max(${prospectHandovers.createdAt})`), asc(prospectHandovers.campaignId));
  const [row] = await tx
    .select({ n: sql<number>`count(distinct ${prospectHandoverResults.personId})::int` })
    .from(prospectHandovers)
    .innerJoin(prospectHandoverResults, resultsOf)
    .where(and(eq(prospectHandovers.cohortId, cohortId), wentOver));
  return { usedBy, inCampaign: row!.n };
}
