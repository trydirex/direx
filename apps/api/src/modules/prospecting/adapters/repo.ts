// SPDX-License-Identifier: AGPL-3.0-only
import { withWorkspace, type WorkspaceTx } from "@direx/db";
import { items } from "@direx/db/schema";
import { prospectAddresses, prospectCompanies, prospectPeople, prospectRuns, prospectSignals, prospectSnapshots } from "@direx/db/schema-prospecting";
import { and, asc, desc, eq, gt, inArray, isNull, ne, sql } from "drizzle-orm";
import type { AddressKind } from "../domain/addresses";
import type { Country } from "../domain/country";
import type { Signal } from "../domain/signals";

export const inWorkspace = withWorkspace;
export type ProspectingTx = WorkspaceTx;

export type CompanyToRead = { website: string; domain: string; readStatus: string; signals: string[]; confirmedBy: string };

export async function companyToRead(tx: WorkspaceTx, companyId: string): Promise<CompanyToRead | null> {
  const [row] = await tx
    .select({ website: prospectCompanies.website, domain: prospectCompanies.domain, readStatus: prospectCompanies.readStatus, signals: prospectRuns.signals, confirmedBy: prospectRuns.confirmedBy })
    .from(prospectCompanies)
    .innerJoin(prospectRuns, and(eq(prospectRuns.workspaceId, prospectCompanies.workspaceId), eq(prospectRuns.id, prospectCompanies.firstRunId)))
    .where(eq(prospectCompanies.id, companyId));
  return row ?? null;
}

export type StoredAddress = {
  email: string;
  kind: AddressKind;
  name: string | null;
  role: string | null;
  pageUrl: string;
  noticeFound: boolean;
  leftOutReason: string | null;
};
export type ReadOutcome =
  | { status: "not_read"; reason: string }
  | { status: "read"; country: Country | null; pages: { url: string; digest: string; text: string }[]; addresses: StoredAddress[]; signals: Signal[] };

/**
 * Records a read once. The company row moves out of pending first, so a retry or a second job for the
 * same company finds it already done and writes nothing. False when it was already recorded.
 */
export async function recordRead(tx: WorkspaceTx, workspaceId: string, companyId: string, outcome: ReadOutcome, now: Date): Promise<boolean> {
  const set =
    outcome.status === "not_read"
      ? { readStatus: "not_read", readReason: outcome.reason, namesStatus: "skipped", namesReason: "site_not_read", updatedAt: now }
      : { readStatus: "read", country: outcome.country?.code ?? null, countryQuote: outcome.country?.quote ?? null, namesStatus: "pending", updatedAt: now };
  const moved = await tx
    .update(prospectCompanies)
    .set(set)
    .where(and(eq(prospectCompanies.id, companyId), eq(prospectCompanies.readStatus, "pending")))
    .returning({ id: prospectCompanies.id });
  if (!moved.length || outcome.status === "not_read" || !outcome.pages.length) return moved.length > 0;
  const snapshots = await tx
    .insert(prospectSnapshots)
    .values(outcome.pages.map((p) => ({ workspaceId, companyId, pageUrl: p.url, digest: p.digest, text: p.text, readAt: now })))
    .returning({ id: prospectSnapshots.id, pageUrl: prospectSnapshots.pageUrl });
  const snapshotOf = new Map(snapshots.map((s) => [s.pageUrl, s.id]));
  if (outcome.addresses.length) {
    await tx
      .insert(prospectAddresses)
      .values(
        outcome.addresses.map((a) => ({
          workspaceId,
          companyId,
          email: a.email,
          kind: a.kind,
          source: "published",
          name: a.name,
          role: a.role,
          snapshotId: snapshotOf.get(a.pageUrl)!,
          readAt: now,
          noticeFound: a.noticeFound,
          leftOutReason: a.leftOutReason,
          createdAt: now,
        })),
      )
      .onConflictDoNothing({ target: [prospectAddresses.workspaceId, prospectAddresses.companyId, prospectAddresses.email] });
  }
  // A company read again keeps the signals it already had once.
  const had = new Set((await tx.select({ type: prospectSignals.type, quote: prospectSignals.quote }).from(prospectSignals).where(eq(prospectSignals.companyId, companyId))).map((s) => `${s.type}\n${s.quote}`));
  const fresh = outcome.signals.filter((s) => !had.has(`${s.type}\n${s.quote}`));
  if (fresh.length) {
    await tx
      .insert(prospectSignals)
      .values(fresh.map((s) => ({ workspaceId, companyId, type: s.type, quote: s.quote, pageUrl: s.pageUrl, snapshotId: snapshotOf.get(s.pageUrl)!, observedOn: s.observedOn, createdAt: now })));
  }
  return true;
}

/** What a re-read is checked against, locked when `lock` so two re-reads take turns. */
export async function companyForReread(tx: WorkspaceTx, companyId: string, lock = false) {
  const q = tx
    .select({ name: prospectCompanies.name, domain: prospectCompanies.domain, state: prospectCompanies.state, readStatus: prospectCompanies.readStatus, readReason: prospectCompanies.readReason, namesStatus: prospectCompanies.namesStatus, reviewItemId: prospectCompanies.reviewItemId, updatedAt: prospectCompanies.updatedAt })
    .from(prospectCompanies)
    .where(eq(prospectCompanies.id, companyId));
  const [row] = lock ? await q.for("update") : await q;
  return row ?? null;
}

/** Puts a read company back to pending, as a new one is, so its read job reads it again. */
export async function resetRead(tx: WorkspaceTx, companyId: string, now: Date): Promise<void> {
  await tx.update(prospectCompanies).set({ readStatus: "pending", readReason: null, namesStatus: null, namesReason: null, updatedAt: now }).where(eq(prospectCompanies.id, companyId));
}

/** Records why a company's names won't be read. Only names still pending change. */
export async function skipNames(tx: WorkspaceTx, companyId: string, reason: string, now: Date): Promise<void> {
  await tx
    .update(prospectCompanies)
    .set({ namesStatus: "skipped", namesReason: reason, updatedAt: now })
    .where(and(eq(prospectCompanies.id, companyId), eq(prospectCompanies.namesStatus, "pending")));
}

/** What a names run is checked against, with the company row locked so two hand-overs take turns. */
export async function namesToCheck(tx: WorkspaceTx, companyId: string) {
  const [company] = await tx.select({ namesStatus: prospectCompanies.namesStatus }).from(prospectCompanies).where(eq(prospectCompanies.id, companyId)).for("update");
  if (!company) return null;
  const pages = await tx.select({ url: prospectSnapshots.pageUrl, text: prospectSnapshots.text }).from(prospectSnapshots).where(eq(prospectSnapshots.companyId, companyId));
  const unknown = await tx
    .select({ id: prospectAddresses.id, email: prospectAddresses.email })
    .from(prospectAddresses)
    .where(and(eq(prospectAddresses.companyId, companyId), eq(prospectAddresses.kind, "unknown")));
  return { namesStatus: company.namesStatus, pages, unknown };
}

export type KeptPerson = { first: string; last: string; role: string | null };

/** Stores the people a names run found and names the addresses that are theirs, then marks the names done. */
export async function recordNames(
  tx: WorkspaceTx,
  a: { workspaceId: string; companyId: string; runId: string; people: KeptPerson[]; named: { id: string; person: KeptPerson }[]; now: Date },
): Promise<void> {
  if (a.people.length) {
    await tx
      .insert(prospectPeople)
      .values(a.people.map((p) => ({ workspaceId: a.workspaceId, companyId: a.companyId, first: p.first, last: p.last, role: p.role, namesRunId: a.runId, createdAt: a.now })))
      .onConflictDoNothing({ target: [prospectPeople.workspaceId, prospectPeople.companyId, prospectPeople.first, prospectPeople.last] });
  }
  for (const { id, person } of a.named) {
    await tx
      .update(prospectAddresses)
      .set({ kind: "named", name: `${person.first} ${person.last}`.trim(), role: person.role })
      .where(eq(prospectAddresses.id, id));
  }
  await tx.update(prospectCompanies).set({ namesStatus: "done", namesReason: null, updatedAt: a.now }).where(eq(prospectCompanies.id, a.companyId));
}

/** New companies in one Workspace are added one run at a time, so a double submit finds the first one's companies. */
export async function lockNewCompanies(tx: WorkspaceTx, workspaceId: string): Promise<void> {
  await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`prospecting:companies:${workspaceId}`}, 0))`);
}

export async function knownCompanies(tx: WorkspaceTx, domains: string[]) {
  if (!domains.length) return [];
  return tx.select({ id: prospectCompanies.id, domain: prospectCompanies.domain, runId: prospectCompanies.firstRunId }).from(prospectCompanies).where(inArray(prospectCompanies.domain, domains));
}

export async function addRun(
  tx: WorkspaceTx,
  r: {
    workspaceId: string;
    source: "pasted" | "search";
    terms?: string[];
    signals: string[];
    companyLimit: number;
    confirmedMicros: bigint;
    searchCostMicros?: bigint;
    status?: "running" | "done" | "stopped";
    confirmedBy: string;
    now: Date;
  },
): Promise<string> {
  const status = r.status ?? "running";
  const [row] = await tx
    .insert(prospectRuns)
    .values({
      workspaceId: r.workspaceId,
      source: r.source,
      terms: r.terms ?? [],
      signals: r.signals,
      companyLimit: r.companyLimit,
      confirmedMicros: r.confirmedMicros,
      searchCostMicros: r.searchCostMicros ?? 0n,
      status,
      confirmedBy: r.confirmedBy,
      createdAt: r.now,
      updatedAt: r.now,
      finishedAt: status === "running" ? null : r.now,
    })
    .returning({ id: prospectRuns.id });
  return row!.id;
}

export async function addCompanies(tx: WorkspaceTx, workspaceId: string, runId: string, companies: { domain: string; website: string; name?: string | null }[], now: Date) {
  return tx
    .insert(prospectCompanies)
    .values(companies.map((c) => ({ workspaceId, domain: c.domain, website: c.website, name: c.name ?? null, firstRunId: runId, createdAt: now, updatedAt: now })))
    .returning({ id: prospectCompanies.id, domain: prospectCompanies.domain });
}

/** A run with counts over the companies it found. A company is settled once its read and its names are no longer pending. */
export async function runWithProgress(tx: WorkspaceTx, runId: string) {
  const [run] = await tx.select().from(prospectRuns).where(eq(prospectRuns.id, runId));
  if (!run) return null;
  const count = (where: ReturnType<typeof sql>) => sql<number>`count(*) filter (where ${where})::int`;
  const [p] = await tx
    .select({
      companies: sql<number>`count(*)::int`,
      readPending: count(sql`${prospectCompanies.readStatus} = 'pending'`),
      read: count(sql`${prospectCompanies.readStatus} = 'read'`),
      notRead: count(sql`${prospectCompanies.readStatus} = 'not_read'`),
      namesPending: count(sql`${prospectCompanies.namesStatus} = 'pending'`),
      namesDone: count(sql`${prospectCompanies.namesStatus} = 'done'`),
      namesSkipped: count(sql`${prospectCompanies.namesStatus} = 'skipped'`),
    })
    .from(prospectCompanies)
    .where(eq(prospectCompanies.firstRunId, runId));
  return { run, progress: p! };
}

/**
 * A run's accepted companies, and how many of their addresses the checking service hasn't answered:
 * a kept address with no result or `unknown`, or a guess stored as `unknown`.
 */
export async function uncheckedOfRun(tx: WorkspaceTx, runId: string) {
  const ofRun = and(eq(prospectCompanies.firstRunId, runId), eq(prospectCompanies.state, "accepted"));
  const accepted = await tx.select({ id: prospectCompanies.id }).from(prospectCompanies).where(ofRun);
  const r = prospectAddresses.verificationResult;
  const [u] = await tx
    .select({ n: sql<number>`count(*)::int` })
    .from(prospectAddresses)
    .innerJoin(prospectCompanies, and(eq(prospectCompanies.workspaceId, prospectAddresses.workspaceId), eq(prospectCompanies.id, prospectAddresses.companyId)))
    .where(and(ofRun, sql`((${prospectAddresses.leftOutReason} is null and (${r} is null or ${r} = 'unknown')) or (${prospectAddresses.source} = 'guessed' and ${r} = 'unknown'))`));
  return { companyIds: accepted.map((a) => a.id), unchecked: u!.n };
}

/** The latest runs, newest first, each with how many companies it found. */
export async function recentRuns(tx: WorkspaceTx, limit: number) {
  return tx
    .select({ run: prospectRuns, companies: sql<number>`count(${prospectCompanies.id})::int` })
    .from(prospectRuns)
    .leftJoin(prospectCompanies, eq(prospectCompanies.firstRunId, prospectRuns.id))
    .groupBy(prospectRuns.id)
    .orderBy(desc(prospectRuns.createdAt))
    .limit(limit);
}

export async function finishRun(tx: WorkspaceTx, runId: string, now: Date): Promise<void> {
  await tx
    .update(prospectRuns)
    .set({ status: "done", finishedAt: now, updatedAt: now })
    .where(and(eq(prospectRuns.id, runId), eq(prospectRuns.status, "running")));
}

/** One page of companies in id order, which the Workspace's (workspace_id, id) key serves, with their addresses. */
export async function companiesPage(tx: WorkspaceTx, cursor: string | undefined, limit: number, runId?: string) {
  // One run's companies follow its (first run, created) index, with the id breaking ties within a run's
  // shared creation time, so a cursor keeps its place in that order.
  const after = cursor
    ? runId
      ? sql`(${prospectCompanies.createdAt}, ${prospectCompanies.id}) > (select c.created_at, c.id from prospect_companies c where c.id = ${cursor})`
      : gt(prospectCompanies.id, cursor)
    : undefined;
  const rows = await tx
    .select({
      id: prospectCompanies.id,
      domain: prospectCompanies.domain,
      website: prospectCompanies.website,
      name: prospectCompanies.name,
      country: prospectCompanies.country,
      runId: prospectCompanies.firstRunId,
      readStatus: prospectCompanies.readStatus,
      readReason: prospectCompanies.readReason,
      namesStatus: prospectCompanies.namesStatus,
      namesReason: prospectCompanies.namesReason,
      state: prospectCompanies.state,
      reviewItemId: prospectCompanies.reviewItemId,
    })
    .from(prospectCompanies)
    .where(and(runId ? eq(prospectCompanies.firstRunId, runId) : undefined, after))
    .orderBy(...(runId ? [asc(prospectCompanies.createdAt), asc(prospectCompanies.id)] : [asc(prospectCompanies.id)]))
    .limit(limit);
  const addresses = rows.length
    ? await tx
        .select({ companyId: prospectAddresses.companyId, email: prospectAddresses.email, kind: prospectAddresses.kind, leftOutReason: prospectAddresses.leftOutReason })
        .from(prospectAddresses)
        .where(inArray(
          prospectAddresses.companyId,
          rows.map((r) => r.id),
        ))
        .orderBy(asc(prospectAddresses.email))
    : [];
  const signals = rows.length
    ? await tx
        .select({ companyId: prospectSignals.companyId, type: prospectSignals.type, quote: prospectSignals.quote, pageUrl: prospectSignals.pageUrl, observedOn: prospectSignals.observedOn })
        .from(prospectSignals)
        .where(inArray(
          prospectSignals.companyId,
          rows.map((r) => r.id),
        ))
        .orderBy(asc(prospectSignals.type), asc(prospectSignals.pageUrl))
    : [];
  return { rows, addresses, signals };
}

/** A company as its review shows it, or null when it isn't there. */
export async function companyForReview(tx: WorkspaceTx, companyId: string) {
  const [row] = await tx
    .select({
      domain: prospectCompanies.domain,
      website: prospectCompanies.website,
      name: prospectCompanies.name,
      country: prospectCompanies.country,
      countryQuote: prospectCompanies.countryQuote,
      readStatus: prospectCompanies.readStatus,
      namesStatus: prospectCompanies.namesStatus,
      namesReason: prospectCompanies.namesReason,
      reviewItemId: prospectCompanies.reviewItemId,
    })
    .from(prospectCompanies)
    .where(eq(prospectCompanies.id, companyId));
  return row ?? null;
}

/** What a review shows: each signal and address with the page it came from. */
export async function reviewContent(tx: WorkspaceTx, companyId: string) {
  const signals = await tx
    .select({ type: prospectSignals.type, quote: prospectSignals.quote, pageUrl: prospectSignals.pageUrl, observedOn: prospectSignals.observedOn })
    .from(prospectSignals)
    .where(eq(prospectSignals.companyId, companyId))
    .orderBy(asc(prospectSignals.type), asc(prospectSignals.pageUrl));
  const addresses = await tx
    .select({
      id: prospectAddresses.id,
      email: prospectAddresses.email,
      kind: prospectAddresses.kind,
      source: prospectAddresses.source,
      name: prospectAddresses.name,
      role: prospectAddresses.role,
      pageUrl: prospectSnapshots.pageUrl,
      snapshotId: prospectAddresses.snapshotId,
      readAt: prospectAddresses.readAt,
      leftOutReason: prospectAddresses.leftOutReason,
    })
    .from(prospectAddresses)
    .innerJoin(prospectSnapshots, and(eq(prospectSnapshots.workspaceId, prospectAddresses.workspaceId), eq(prospectSnapshots.id, prospectAddresses.snapshotId)))
    .where(eq(prospectAddresses.companyId, companyId))
    .orderBy(asc(prospectAddresses.email));
  const people = await tx
    .select({ first: prospectPeople.first, last: prospectPeople.last, role: prospectPeople.role })
    .from(prospectPeople)
    .where(eq(prospectPeople.companyId, companyId))
    .orderBy(asc(prospectPeople.createdAt), asc(prospectPeople.id));
  return { signals, addresses, people };
}

/**
 * A review Item made for this company that never got linked, as after a crash between making it and
 * linking it. Linking it instead of making another keeps one Item per company.
 */
export async function unlinkedReview(tx: WorkspaceTx, kind: string, companyId: string): Promise<string | null> {
  const [row] = await tx
    .select({ id: items.id })
    .from(items)
    .where(and(eq(items.kind, kind), ne(items.state, "cancelled"), sql`${items.payload} ->> 'companyId' = ${companyId}`))
    .orderBy(asc(items.createdAt))
    .limit(1);
  return row?.id ?? null;
}

/** Links a company to its review Item. False when another one got there first. */
export async function linkReview(tx: WorkspaceTx, companyId: string, itemId: string, now: Date): Promise<boolean> {
  const moved = await tx
    .update(prospectCompanies)
    .set({ reviewItemId: itemId, state: "in_review", updatedAt: now })
    .where(and(eq(prospectCompanies.id, companyId), isNull(prospectCompanies.reviewItemId)))
    .returning({ id: prospectCompanies.id });
  return moved.length > 0;
}

/** The company this Item reviews, locked, while it is still waiting on that Item. */
export async function lockInReview(tx: WorkspaceTx, companyId: string, itemId: string): Promise<boolean> {
  const [row] = await tx
    .select({ id: prospectCompanies.id })
    .from(prospectCompanies)
    .where(and(eq(prospectCompanies.id, companyId), eq(prospectCompanies.reviewItemId, itemId), eq(prospectCompanies.state, "in_review")))
    .for("update");
  return !!row;
}

/** Accepted: every address a person didn't keep says why, so the ones left with no reason are the kept ones. */
export async function acceptCompany(tx: WorkspaceTx, companyId: string, notKept: { id: string; reason: string }[], now: Date): Promise<void> {
  for (const a of notKept) {
    await tx
      .update(prospectAddresses)
      .set({ leftOutReason: sql`coalesce(${prospectAddresses.leftOutReason}, ${a.reason})` })
      .where(and(eq(prospectAddresses.id, a.id), eq(prospectAddresses.companyId, companyId)));
  }
  await tx.update(prospectCompanies).set({ state: "accepted", updatedAt: now }).where(eq(prospectCompanies.id, companyId));
}

/** Rejected: its pages are kept only until expiresAt, for a later sweep to delete. */
export async function rejectCompany(tx: WorkspaceTx, companyId: string, expiresAt: Date, now: Date): Promise<void> {
  await tx.update(prospectCompanies).set({ state: "rejected", updatedAt: now }).where(eq(prospectCompanies.id, companyId));
  await tx.update(prospectSnapshots).set({ expiresAt }).where(and(eq(prospectSnapshots.companyId, companyId), isNull(prospectSnapshots.expiresAt)));
}
