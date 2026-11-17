// SPDX-License-Identifier: AGPL-3.0-only
// Every lessons SQL statement. Versions, events and what a run carried are only inserted.
import { and, asc, eq, inArray, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { withWorkspace, type WorkspaceTx } from "@direx/db";
import { agentLessonEvents, agentLessons, agentLessonVersions, agentRunLessons } from "@direx/db/schema-lessons";
import type { CarriedLesson } from "../application/digest";

export type LessonsTx = WorkspaceTx;
export type LessonRow = typeof agentLessons.$inferSelect;
export type LiveLesson = { id: string; version: number; text: string; agent: string; definitionVersion: number | null; createdAt: Date };
export type NewEvent = Omit<typeof agentLessonEvents.$inferInsert, "id" | "workspaceId">;

export const inWorkspace = <T>(workspaceId: string, fn: (tx: LessonsTx) => Promise<T>) => withWorkspace(workspaceId, fn);

/** One acceptance, rewrite or retirement at a time per Agent, so two can't pass the budget together. */
export const lockAgent = async (tx: LessonsTx, workspaceId: string, agent: string) => {
  await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`lessons:${workspaceId}:${agent}`}, 0))`);
};

const current = (tx: LessonsTx) =>
  tx
    .select({ id: agentLessons.id, version: agentLessons.version, text: agentLessonVersions.text, agent: agentLessons.agent, definitionVersion: agentLessonVersions.definitionVersion, createdAt: agentLessonVersions.createdAt })
    .from(agentLessons)
    .innerJoin(agentLessonVersions, and(eq(agentLessonVersions.workspaceId, agentLessons.workspaceId), eq(agentLessonVersions.lessonId, agentLessons.id), eq(agentLessonVersions.version, agentLessons.version)));

export const liveLessons = (tx: LessonsTx, agent?: string): Promise<LiveLesson[]> =>
  current(tx)
    .where(agent ? and(eq(agentLessons.state, "live"), eq(agentLessons.agent, agent)) : eq(agentLessons.state, "live"))
    .orderBy(asc(agentLessonVersions.createdAt));

const first = alias(agentLessonVersions, "first_version");
const accepted = alias(agentLessonEvents, "accepted");
const proposed = alias(agentLessonEvents, "proposed");

/**
 * Where each lesson came from: the edit its first version names, the proposal Item accepted to make
 * it, and the person who proposed it. Each is null where it wasn't recorded.
 */
export const origins = async (tx: LessonsTx, lessonIds: readonly string[]) =>
  lessonIds.length
    ? tx
        .select({ lessonId: first.lessonId, sourceRef: first.sourceRef, itemId: accepted.itemId, personId: proposed.personId })
        .from(first)
        .leftJoin(accepted, and(eq(accepted.workspaceId, first.workspaceId), eq(accepted.lessonId, first.lessonId), eq(accepted.op, "accept")))
        .leftJoin(proposed, and(eq(proposed.workspaceId, accepted.workspaceId), eq(proposed.itemId, accepted.itemId), eq(proposed.op, "propose")))
        .where(and(inArray(first.lessonId, [...lessonIds]), eq(first.version, 1)))
    : [];

export const lockLesson = async (tx: LessonsTx, id: string): Promise<LessonRow | undefined> => {
  const [row] = await tx.select().from(agentLessons).where(eq(agentLessons.id, id)).for("update");
  return row;
};

export const lessonText = async (tx: LessonsTx, id: string, version: number): Promise<string | undefined> => {
  const [row] = await tx
    .select({ text: agentLessonVersions.text })
    .from(agentLessonVersions)
    .where(and(eq(agentLessonVersions.lessonId, id), eq(agentLessonVersions.version, version)));
  return row?.text;
};

export async function insertLesson(tx: LessonsTx, workspaceId: string, agent: string, at: Date): Promise<string> {
  const [row] = await tx.insert(agentLessons).values({ workspaceId, agent, state: "live", version: 1, createdAt: at, updatedAt: at }).returning({ id: agentLessons.id });
  return row!.id;
}

export async function insertVersion(tx: LessonsTx, workspaceId: string, v: { lessonId: string; version: number; text: string; sourceRef: string | null; definitionVersion: number | null; createdBy: string }, at: Date) {
  await tx.insert(agentLessonVersions).values({ workspaceId, ...v, source: "person", createdAt: at });
}

export async function setLesson(tx: LessonsTx, id: string, patch: { state?: "live" | "cancelled"; version?: number }, at: Date) {
  await tx.update(agentLessons).set({ ...patch, updatedAt: at }).where(eq(agentLessons.id, id));
}

export async function insertEvent(tx: LessonsTx, workspaceId: string, e: NewEvent) {
  await tx.insert(agentLessonEvents).values({ workspaceId, ...e });
}

export const eventsOf = (tx: LessonsTx, lessonId: string) => tx.select().from(agentLessonEvents).where(eq(agentLessonEvents.lessonId, lessonId)).orderBy(asc(agentLessonEvents.at));

/** Fixes what a run carries, once; a second call for the same run adds nothing. */
export async function fixRunLessons(tx: LessonsTx, workspaceId: string, runId: string, set: readonly (CarriedLesson & { digest: string })[]) {
  if (set.length) await tx.insert(agentRunLessons).values(set.map((l) => ({ workspaceId, runId, lessonId: l.lessonId, version: l.version, digest: l.digest }))).onConflictDoNothing();
}

/** What a run carries, with each lesson's words at the version it was fixed at and whether it is still live. */
export const carriedBy = (tx: LessonsTx, runId: string) =>
  tx
    .select({ lessonId: agentRunLessons.lessonId, version: agentRunLessons.version, text: agentLessonVersions.text, state: agentLessons.state })
    .from(agentRunLessons)
    .innerJoin(agentLessonVersions, and(eq(agentLessonVersions.workspaceId, agentRunLessons.workspaceId), eq(agentLessonVersions.lessonId, agentRunLessons.lessonId), eq(agentLessonVersions.version, agentRunLessons.version)))
    .innerJoin(agentLessons, and(eq(agentLessons.workspaceId, agentRunLessons.workspaceId), eq(agentLessons.id, agentRunLessons.lessonId)))
    .where(eq(agentRunLessons.runId, runId))
    .orderBy(asc(agentRunLessons.lessonId));

export const runsCarrying = async (tx: LessonsTx, lessonIds: readonly string[]): Promise<string[]> =>
  lessonIds.length ? (await tx.selectDistinct({ runId: agentRunLessons.runId }).from(agentRunLessons).where(inArray(agentRunLessons.lessonId, [...lessonIds]))).map((r) => r.runId) : [];
