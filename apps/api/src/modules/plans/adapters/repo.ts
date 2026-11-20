// SPDX-License-Identifier: AGPL-3.0-only
// Every plans SQL statement. Versions, progress and readings are only inserted. Items are read,
// never written, to find the Item still waiting on a version.
import { and, asc, desc, eq, gt, isNull, ne, or, sql } from "drizzle-orm";
import { withWorkspace, type WorkspaceTx } from "@direx/db";
import { items } from "@direx/db/schema";
import { marketingPlans, marketingPlanVersions, planMeasureReadings, planStepProgress, strategies, strategyVersions } from "@direx/db/schema-plans";
import type { Progress, Reading } from "../domain/tracking";

export type PlansTx = WorkspaceTx;
export type StrategyRow = typeof strategies.$inferSelect;
export type PlanRow = typeof marketingPlans.$inferSelect;
export type StrategyVersionRow = typeof strategyVersions.$inferSelect;
export type PlanVersionRow = typeof marketingPlanVersions.$inferSelect;
export type Writer = { actorUserId: string | null; actorSystem: string | null };

export const inWorkspace = <T>(workspaceId: string, fn: (tx: PlansTx) => Promise<T>) => withWorkspace(workspaceId, fn);

// Strategy
export const readStrategy = async (tx: PlansTx): Promise<StrategyRow | undefined> => (await tx.select().from(strategies))[0];
export const lockStrategy = async (tx: PlansTx): Promise<StrategyRow | undefined> => (await tx.select().from(strategies).for("update"))[0];

/** Two first saves can race; the unique Workspace row settles it and both then lock that row. */
export async function ensureStrategy(tx: PlansTx, workspaceId: string, now: Date): Promise<StrategyRow> {
  await tx.insert(strategies).values({ workspaceId, createdAt: now, updatedAt: now }).onConflictDoNothing();
  return (await lockStrategy(tx))!;
}
export async function setStrategyDraft(tx: PlansTx, id: string, draft: unknown, revision: number, now: Date) {
  await tx.update(strategies).set({ draft, draftRevision: revision, draftRunId: null, updatedAt: now }).where(eq(strategies.id, id));
}
export async function fillStrategyDraft(tx: PlansTx, id: string, draft: unknown, revision: number, runId: string, now: Date) {
  await tx.update(strategies).set({ draft, draftRevision: revision, draftRunId: runId, updatedAt: now }).where(eq(strategies.id, id));
}
export async function setStrategyCurrent(tx: PlansTx, id: string, version: number, now: Date) {
  await tx.update(strategies).set({ currentVersion: version, updatedAt: now }).where(eq(strategies.id, id));
}
export const strategyVersionsOf = (tx: PlansTx, id: string): Promise<StrategyVersionRow[]> =>
  tx.select().from(strategyVersions).where(eq(strategyVersions.strategyId, id)).orderBy(asc(strategyVersions.version));
export async function readStrategyVersion(tx: PlansTx, id: string, version: number): Promise<StrategyVersionRow | undefined> {
  const [r] = await tx.select().from(strategyVersions).where(and(eq(strategyVersions.strategyId, id), eq(strategyVersions.version, version)));
  return r;
}
export async function latestStrategyVersion(tx: PlansTx, id: string): Promise<StrategyVersionRow | undefined> {
  const [r] = await tx.select().from(strategyVersions).where(eq(strategyVersions.strategyId, id)).orderBy(desc(strategyVersions.version)).limit(1);
  return r;
}
export async function insertStrategyVersion(tx: PlansTx, v: typeof strategyVersions.$inferInsert) {
  await tx.insert(strategyVersions).values(v);
}

// Marketing plans
export async function insertPlan(tx: PlansTx, workspaceId: string, a: { title: string; request: string | null; createdBy: string }, now: Date): Promise<PlanRow> {
  const [r] = await tx.insert(marketingPlans).values({ workspaceId, ...a, createdAt: now, updatedAt: now }).returning();
  return r!;
}
export const readPlan = async (tx: PlansTx, id: string): Promise<PlanRow | undefined> => (await tx.select().from(marketingPlans).where(eq(marketingPlans.id, id)))[0];
export const lockPlan = async (tx: PlansTx, id: string): Promise<PlanRow | undefined> => (await tx.select().from(marketingPlans).where(eq(marketingPlans.id, id)).for("update"))[0];
/** Plans not archived, newest first, each with its current version's body when it has one. */
export async function listPlans(tx: PlansTx): Promise<(PlanRow & { currentBody: unknown })[]> {
  const rows = await tx
    .select({ plan: marketingPlans, body: marketingPlanVersions.body })
    .from(marketingPlans)
    .leftJoin(marketingPlanVersions, and(eq(marketingPlanVersions.planId, marketingPlans.id), eq(marketingPlanVersions.version, marketingPlans.currentVersion)))
    .where(isNull(marketingPlans.archivedAt))
    .orderBy(desc(marketingPlans.createdAt));
  return rows.map((r) => ({ ...r.plan, currentBody: r.body }));
}
export async function setPlanDraft(tx: PlansTx, id: string, draft: unknown, revision: number, now: Date) {
  await tx.update(marketingPlans).set({ draft, draftRevision: revision, draftRunId: null, updatedAt: now }).where(eq(marketingPlans.id, id));
}
export async function fillPlanDraft(tx: PlansTx, id: string, draft: unknown, revision: number, runId: string, now: Date) {
  await tx.update(marketingPlans).set({ draft, draftRevision: revision, draftRunId: runId, updatedAt: now }).where(eq(marketingPlans.id, id));
}
export async function setPlanCurrent(tx: PlansTx, id: string, version: number, now: Date) {
  await tx.update(marketingPlans).set({ currentVersion: version, updatedAt: now }).where(eq(marketingPlans.id, id));
}
export async function archivePlanRow(tx: PlansTx, id: string, now: Date) {
  await tx.update(marketingPlans).set({ archivedAt: now, updatedAt: now }).where(eq(marketingPlans.id, id));
}
export const planVersionsOf = (tx: PlansTx, id: string): Promise<PlanVersionRow[]> =>
  tx.select().from(marketingPlanVersions).where(eq(marketingPlanVersions.planId, id)).orderBy(asc(marketingPlanVersions.version));
export async function readPlanVersion(tx: PlansTx, id: string, version: number): Promise<PlanVersionRow | undefined> {
  const [r] = await tx.select().from(marketingPlanVersions).where(and(eq(marketingPlanVersions.planId, id), eq(marketingPlanVersions.version, version)));
  return r;
}
export async function latestPlanVersion(tx: PlansTx, id: string): Promise<PlanVersionRow | undefined> {
  const [r] = await tx.select().from(marketingPlanVersions).where(eq(marketingPlanVersions.planId, id)).orderBy(desc(marketingPlanVersions.version)).limit(1);
  return r;
}
export async function insertPlanVersion(tx: PlansTx, v: typeof marketingPlanVersions.$inferInsert) {
  await tx.insert(marketingPlanVersions).values(v);
}

// Tracking
export async function insertProgress(tx: PlansTx, workspaceId: string, planId: string, stepKey: string, status: Progress["status"], by: Writer, now: Date) {
  await tx.insert(planStepProgress).values({ workspaceId, planId, stepKey, status, ...by, at: now });
}
export async function insertReading(tx: PlansTx, workspaceId: string, planId: string, r: { measureKey: string; value: string; observedOn: string; note: string | null }, by: Writer, now: Date) {
  await tx.insert(planMeasureReadings).values({ workspaceId, planId, ...r, source: by.actorUserId ? "person" : "system", ...by, at: now });
}
export async function progressOf(tx: PlansTx, planId: string): Promise<Progress[]> {
  const rows = await tx.select().from(planStepProgress).where(eq(planStepProgress.planId, planId)).orderBy(asc(planStepProgress.at));
  return rows.map((r) => ({ stepKey: r.stepKey, status: r.status as Progress["status"], at: r.at }));
}
export async function readingsOf(tx: PlansTx, planId?: string): Promise<(Reading & { id: string; planId: string })[]> {
  const rows = await tx.select().from(planMeasureReadings).where(planId === undefined ? undefined : eq(planMeasureReadings.planId, planId)).orderBy(asc(planMeasureReadings.at));
  return rows.map((r) => ({ id: r.id, planId: r.planId, measureKey: r.measureKey, value: r.value, observedOn: r.observedOn, source: r.source as Reading["source"], note: r.note, actorUserId: r.actorUserId, at: r.at }));
}
/**
 * A reading by id, under RLS so only this Workspace's, and whether it is still the newest for its plan
 * and Measure: no other reading has a later observed day, or the same day and a later write, as
 * tracking() orders them. Null when there is no such reading.
 */
export async function readingStanding(tx: PlansTx, id: string): Promise<{ planId: string; measureKey: string; isNewest: boolean } | null> {
  const [r] = await tx.select().from(planMeasureReadings).where(eq(planMeasureReadings.id, id));
  if (!r) return null;
  const t = planMeasureReadings;
  const newer = await tx
    .select({ id: t.id })
    .from(t)
    .where(and(eq(t.planId, r.planId), eq(t.measureKey, r.measureKey), ne(t.id, r.id), or(gt(t.observedOn, r.observedOn), and(eq(t.observedOn, r.observedOn), gt(t.at, r.at)))))
    .limit(1);
  return { planId: r.planId, measureKey: r.measureKey, isNewest: newer.length === 0 };
}

/** The Items still waiting on a version of this Strategy or plan, newest last. */
export async function openVersionItems(tx: PlansTx, kind: string, targetId: string): Promise<{ id: string; version: number }[]> {
  const rows = await tx
    .select({ id: items.id, version: sql<number>`(${items.payload}->>'version')::int` })
    .from(items)
    .where(and(eq(items.kind, kind), eq(items.state, "needs_approval"), sql`${items.payload}->>'targetId' = ${targetId}`));
  return rows.sort((a, b) => a.version - b.version);
}
