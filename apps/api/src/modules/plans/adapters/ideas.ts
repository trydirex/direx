// SPDX-License-Identifier: AGPL-3.0-only
// Every Ideas SQL statement. An Idea is dismissed, never deleted; the app role has no DELETE on it.
import { and, desc, eq, gte, isNotNull, isNull } from "drizzle-orm";
import { ideas, marketingPlans } from "@direx/db/schema-plans";
import type { PlansTx } from "./repo";

export type IdeaRow = typeof ideas.$inferSelect;

/** The newest open Ideas, then those started since `startedSince`, with their plan's title. */
export async function listIdeas(tx: PlansTx, a: { open: number; started: number; startedSince: Date }) {
  const open = await tx
    .select()
    .from(ideas)
    .where(and(isNull(ideas.planId), isNull(ideas.dismissedAt)))
    .orderBy(desc(ideas.createdAt))
    .limit(a.open);
  const started = await tx
    .select({ idea: ideas, planTitle: marketingPlans.title })
    .from(ideas)
    .innerJoin(marketingPlans, eq(marketingPlans.id, ideas.planId))
    .where(and(isNotNull(ideas.planId), gte(ideas.startedAt, a.startedSince)))
    .orderBy(desc(ideas.startedAt))
    .limit(a.started);
  return { open, started };
}

export async function insertIdea(tx: PlansTx, a: { workspaceId: string; text: string; createdBy: string; now: Date }): Promise<IdeaRow> {
  const [row] = await tx.insert(ideas).values({ workspaceId: a.workspaceId, text: a.text, createdBy: a.createdBy, createdAt: a.now }).returning();
  return row!;
}

/** False when there is no such open Idea. */
export async function dismissIdea(tx: PlansTx, id: string, now: Date): Promise<boolean> {
  const rows = await tx
    .update(ideas)
    .set({ dismissedAt: now })
    .where(and(eq(ideas.id, id), isNull(ideas.dismissedAt), isNull(ideas.planId)))
    .returning({ id: ideas.id });
  return rows.length === 1;
}

/** Links an open Idea to the plan started from it. False when it is gone, dismissed or already started. */
export async function startIdea(tx: PlansTx, id: string, planId: string, now: Date): Promise<boolean> {
  const rows = await tx
    .update(ideas)
    .set({ planId, startedAt: now })
    .where(and(eq(ideas.id, id), isNull(ideas.dismissedAt), isNull(ideas.planId)))
    .returning({ id: ideas.id });
  return rows.length === 1;
}

/** Whether this Workspace has the plan; RLS keeps another Workspace's out of sight. */
export const hasPlan = async (tx: PlansTx, planId: string) => (await tx.select({ id: marketingPlans.id }).from(marketingPlans).where(eq(marketingPlans.id, planId))).length === 1;
