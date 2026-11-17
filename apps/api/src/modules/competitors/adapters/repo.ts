// SPDX-License-Identifier: AGPL-3.0-only
// Every competitors SQL statement, inside one Workspace, apart from the weekly read's list of Workspaces.
import { and, asc, count, desc, eq, gte, isNull, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { withSystem, withWorkspace, type WorkspaceTx } from "@direx/db";
import { competitorChanges, competitors, competitorSnapshots } from "@direx/db/schema-competitors";

export type CompetitorRow = typeof competitors.$inferSelect;
export type CompetitorValues = Pick<CompetitorRow, "name" | "pricingUrl" | "changelogUrl" | "landingUrl"> & Partial<Pick<CompetitorRow, "comparisonUrl">>;

export const inWorkspace = <T>(workspaceId: string, fn: (tx: WorkspaceTx) => Promise<T>) => withWorkspace(workspaceId, fn);

export function isUniqueViolation(e: unknown): boolean {
  const err = e as { code?: string; cause?: { code?: string } };
  return (err.code ?? err.cause?.code) === "23505";
}

/** Held until the transaction ends, so two adds at once can't both see room for one more. */
export const lockList = (tx: WorkspaceTx, workspaceId: string) => tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`competitors:${workspaceId}`}, 0))`);

export const listRows = (tx: WorkspaceTx) => tx.select().from(competitors).orderBy(asc(competitors.createdAt), asc(competitors.id));

export const countRows = async (tx: WorkspaceTx) => (await tx.select({ n: count() }).from(competitors))[0]!.n;

export const getRow = async (tx: WorkspaceTx, id: string): Promise<CompetitorRow | undefined> => (await tx.select().from(competitors).where(eq(competitors.id, id)))[0];

export async function insertRow(tx: WorkspaceTx, workspaceId: string, v: CompetitorValues, createdBy: string, at: Date): Promise<CompetitorRow> {
  const [r] = await tx.insert(competitors).values({ workspaceId, ...v, createdBy, createdAt: at, updatedAt: at }).returning();
  return r!;
}

export async function updateRow(tx: WorkspaceTx, id: string, v: CompetitorValues, at: Date): Promise<CompetitorRow | undefined> {
  return (await tx.update(competitors).set({ ...v, updatedAt: at }).where(eq(competitors.id, id)).returning())[0];
}

export type SnapshotRow = typeof competitorSnapshots.$inferSelect;
export type NewSnapshot = Omit<typeof competitorSnapshots.$inferInsert, "id">;
export type ChangeRow = typeof competitorChanges.$inferSelect;
export type NewChange = Omit<typeof competitorChanges.$inferInsert, "id">;

/** Every Workspace with a competitor, through the one system function that may look across them. */
export async function competitorWorkspaces(): Promise<string[]> {
  const { rows } = await withSystem((tx) => tx.execute(sql`select workspace_id from system.competitor_workspaces()`));
  return rows.map((r) => r.workspace_id as string);
}

export async function hasSnapshot(tx: WorkspaceTx, competitorId: string, source: string, week: string): Promise<boolean> {
  const s = competitorSnapshots;
  return (await tx.select({ id: s.id }).from(s).where(and(eq(s.competitorId, competitorId), eq(s.source, source), eq(s.week, week)))).length > 0;
}

/** The good reads of this exact URL, newest first: a changed URL starts again from nothing. */
export function lastGood(tx: WorkspaceTx, competitorId: string, source: string, url: string, limit: number): Promise<SnapshotRow[]> {
  const s = competitorSnapshots;
  return tx
    .select()
    .from(s)
    .where(and(eq(s.competitorId, competitorId), eq(s.source, source), eq(s.url, url), isNull(s.failure)))
    .orderBy(desc(s.readAt))
    .limit(limit);
}

/** Undefined when another run took this week first. */
export async function insertSnapshot(tx: WorkspaceTx, row: NewSnapshot): Promise<SnapshotRow | undefined> {
  return (await tx.insert(competitorSnapshots).values(row).onConflictDoNothing().returning())[0];
}

export async function insertChanges(tx: WorkspaceTx, rows: NewChange[]) {
  if (rows.length > 0) await tx.insert(competitorChanges).values(rows);
}

/** Each page's latest read, failed or not. */
export function lastReads(tx: WorkspaceTx) {
  const s = competitorSnapshots;
  return tx
    .selectDistinctOn([s.competitorId, s.source], { competitorId: s.competitorId, source: s.source, url: s.url, readAt: s.readAt, failure: s.failure })
    .from(s)
    .orderBy(s.competitorId, s.source, desc(s.readAt));
}

export function changesSince(tx: WorkspaceTx, competitorId: string, since: Date): Promise<ChangeRow[]> {
  const c = competitorChanges;
  return tx
    .select()
    .from(c)
    .where(and(eq(c.competitorId, competitorId), gte(c.createdAt, since)))
    .orderBy(desc(c.createdAt), asc(c.id));
}

const forLabel = { id: competitorChanges.id, competitorId: competitorChanges.competitorId, competitor: competitors.name, source: competitorChanges.source, at: competitorChanges.createdAt, detail: competitorChanges.detail };

/** Changes since `since` that no run has labelled, oldest first, with their competitor's name. */
export function unlabelledSince(tx: WorkspaceTx, since: Date) {
  const c = competitorChanges;
  return tx
    .select(forLabel)
    .from(c)
    .innerJoin(competitors, eq(competitors.id, c.competitorId))
    .where(and(isNull(c.label), gte(c.createdAt, since)))
    .orderBy(asc(c.createdAt), asc(c.id));
}

/** Changes since `since` labelled answer, oldest first: what a new Change may be another sighting of. */
export function answersSince(tx: WorkspaceTx, since: Date) {
  const c = competitorChanges;
  return tx
    .select({ ...forLabel, kind: c.kind, reason: c.reason })
    .from(c)
    .innerJoin(competitors, eq(competitors.id, c.competitorId))
    .where(and(eq(c.label, "answer"), gte(c.createdAt, since)))
    .orderBy(asc(c.createdAt), asc(c.id));
}

export type NewLabel = { changeId: string; label: string; kind: string | null; sameAs: string | null; reason: string };

/** Writes each label onto a Change still unlabelled, so a second run never relabels. Returns how many were written. */
export async function writeLabels(tx: WorkspaceTx, runId: string | null, labels: NewLabel[], at: Date): Promise<number> {
  const c = competitorChanges;
  let written = 0;
  for (const l of labels) {
    const set = { label: l.label, kind: l.kind, sameAsChangeId: l.sameAs, reason: l.reason, labelledAt: at, runId };
    written += (await tx.update(c).set(set).where(and(eq(c.id, l.changeId), isNull(c.label))).returning({ id: c.id })).length;
  }
  return written;
}

export const labelledByRun = async (tx: WorkspaceTx, runId: string) =>
  (await tx.select({ n: count() }).from(competitorChanges).where(eq(competitorChanges.runId, runId)))[0]!.n;

const before = alias(competitorSnapshots, "before_snapshot");
const after = alias(competitorSnapshots, "after_snapshot");

/** Answers since `since` that no counter-move holds yet, first sightings first, then oldest first, with what a counter-move quotes. */
export function unmovedAnswers(tx: WorkspaceTx, since: Date) {
  const c = competitorChanges;
  return tx
    .select({
      id: c.id,
      competitorId: c.competitorId,
      competitor: competitors.name,
      comparisonUrl: competitors.comparisonUrl,
      source: c.source,
      detail: c.detail,
      reason: c.reason,
      sameAs: c.sameAsChangeId,
      before: { id: before.id, readAt: before.readAt },
      after: { id: after.id, readAt: after.readAt, url: sql<string>`coalesce(${after.finalUrl}, ${after.url})` },
    })
    .from(c)
    .innerJoin(competitors, eq(competitors.id, c.competitorId))
    .innerJoin(before, eq(before.id, c.beforeSnapshotId))
    .innerJoin(after, eq(after.id, c.afterSnapshotId))
    .where(and(eq(c.label, "answer"), isNull(c.itemId), gte(c.createdAt, since)))
    // An event's first Change and its sightings can come from one read, so first sightings go first.
    .orderBy(sql`${c.sameAsChangeId} is not null`, asc(c.createdAt), asc(c.id));
}

/**
 * Every answer's link to its event and counter-move, to find an event's first Change.
 * ponytail: all of a Workspace's answers, about 2 a month; page by competitor if that grows.
 */
export const answerLinks = (tx: WorkspaceTx) =>
  tx.select({ id: competitorChanges.id, sameAs: competitorChanges.sameAsChangeId, itemId: competitorChanges.itemId, kind: competitorChanges.kind }).from(competitorChanges).where(eq(competitorChanges.label, "answer"));

/** Only onto an answer with no counter-move yet, so a retry never moves one. */
export const setItemId = (tx: WorkspaceTx, changeId: string, itemId: string) =>
  tx
    .update(competitorChanges)
    .set({ itemId })
    .where(and(eq(competitorChanges.id, changeId), isNull(competitorChanges.itemId)));

export const deleteRow = async (tx: WorkspaceTx, id: string) => (await tx.delete(competitors).where(eq(competitors.id, id)).returning({ id: competitors.id })).length > 0;
