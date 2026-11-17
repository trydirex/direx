// SPDX-License-Identifier: AGPL-3.0-only
// Clip runs and clips. Every call runs inside the Workspace, so RLS hides other Workspaces' runs.
import { withWorkspace, type WorkspaceTx } from "@direx/db";
import { clipRuns, clips } from "@direx/db/schema-clips";
import { and, asc, eq, inArray, notInArray } from "drizzle-orm";

export type ClipRunRow = typeof clipRuns.$inferSelect;
export type ClipRow = typeof clips.$inferSelect;
export type RunState = "queued" | "transcribing" | "picking" | "cutting" | "done" | "failed";
export type RunPatch = Partial<Pick<ClipRunRow, "transcript" | "durationMs" | "agentRunId" | "moments" | "failure">> & { state?: RunState };

export const inWorkspace = withWorkspace;

/** A unique violation, as node-postgres reports it through drizzle. */
export function isUniqueViolation(e: unknown): boolean {
  const err = e as { code?: string; cause?: { code?: string } };
  return (err.code ?? err.cause?.code) === "23505";
}

export async function insertRun(tx: WorkspaceTx, row: typeof clipRuns.$inferInsert): Promise<ClipRunRow> {
  const [made] = await tx.insert(clipRuns).values(row).returning();
  return made!;
}

/** The run still going for one video, if any: there is at most one (clip_runs_one_live_per_source). */
export function liveRunOf(workspaceId: string, mediaId: string): Promise<ClipRunRow | undefined> {
  return withWorkspace(workspaceId, async (tx) => (await tx.select().from(clipRuns).where(and(eq(clipRuns.sourceMediaId, mediaId), notInArray(clipRuns.state, ["done", "failed"]))))[0]);
}

export function readRun(workspaceId: string, id: string): Promise<ClipRunRow | undefined> {
  return withWorkspace(workspaceId, async (tx) => (await tx.select().from(clipRuns).where(eq(clipRuns.id, id)))[0]);
}

/** Moves a run on only from the states given, so a stage that comes twice changes nothing the second time. */
export async function moveRunIn(tx: WorkspaceTx, id: string, from: readonly RunState[], patch: RunPatch, at: Date): Promise<ClipRunRow | undefined> {
  return (await tx.update(clipRuns).set({ ...patch, updatedAt: at }).where(and(eq(clipRuns.id, id), inArray(clipRuns.state, [...from]))).returning())[0];
}

export function moveRun(workspaceId: string, id: string, from: readonly RunState[], patch: RunPatch, at: Date): Promise<ClipRunRow | undefined> {
  return withWorkspace(workspaceId, (tx) => moveRunIn(tx, id, from, patch, at));
}

export function clipsOf(workspaceId: string, runId: string): Promise<ClipRow[]> {
  return withWorkspace(workspaceId, (tx) => tx.select().from(clips).where(eq(clips.runId, runId)).orderBy(asc(clips.position)));
}

export function insertClip(row: typeof clips.$inferInsert): Promise<void> {
  return withWorkspace(row.workspaceId, async (tx) => {
    await tx.insert(clips).values(row);
  });
}
