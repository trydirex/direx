// SPDX-License-Identifier: AGPL-3.0-only
// Every Voice SQL statement (ADR 0022). Versions are only inserted; an entry is retired, never removed.
// Writes for one Workspace take one lock, so the limits are checked on what is really there.
import { and, asc, eq, isNull, sql } from "drizzle-orm";
import type { WorkspaceTx } from "@direx/db";
import { voiceEntries, voiceVersions } from "@direx/db/schema-voice";

export type VoiceKind = "example" | "swap";
export type LiveVoice = { id: string; kind: VoiceKind; text: string; prefer: string | null; source: "person" | "sample"; at: Date };

export const lockVoice = (tx: WorkspaceTx, workspaceId: string) => tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`voice:${workspaceId}`}, 0))`);

export async function liveVoice(tx: WorkspaceTx): Promise<LiveVoice[]> {
  const rows = await tx
    .select({ id: voiceEntries.id, kind: voiceEntries.kind, text: voiceVersions.text, prefer: voiceVersions.prefer, source: voiceVersions.source, at: voiceVersions.at })
    .from(voiceEntries)
    .innerJoin(voiceVersions, and(eq(voiceVersions.workspaceId, voiceEntries.workspaceId), eq(voiceVersions.entryId, voiceEntries.id), eq(voiceVersions.version, voiceEntries.currentVersion)))
    .where(and(isNull(voiceEntries.retiredAt), isNull(voiceVersions.erasedAt)))
    .orderBy(asc(voiceEntries.createdAt));
  return rows.map((r) => ({ ...r, kind: r.kind as VoiceKind, text: r.text ?? "", source: r.source as "person" | "sample" }));
}

export async function insertVoice(
  tx: WorkspaceTx,
  workspaceId: string,
  a: { kind: VoiceKind; text: string; prefer: string | null; digest: string; userId: string; at: Date },
): Promise<string> {
  const [row] = await tx.insert(voiceEntries).values({ workspaceId, kind: a.kind, currentVersion: 1, createdAt: a.at, updatedAt: a.at }).returning({ id: voiceEntries.id });
  await tx.insert(voiceVersions).values({ workspaceId, entryId: row!.id, version: 1, text: a.text, prefer: a.prefer, source: "person", digest: a.digest, actorUserId: a.userId, at: a.at });
  return row!.id;
}

/** True when a live entry was retired; false when there was none to retire. */
export async function retireVoice(tx: WorkspaceTx, id: string, userId: string, at: Date): Promise<boolean> {
  const done = await tx
    .update(voiceEntries)
    .set({ retiredAt: at, retiredBy: userId, updatedAt: at })
    .where(and(eq(voiceEntries.id, id), isNull(voiceEntries.retiredAt)))
    .returning({ id: voiceEntries.id });
  return done.length > 0;
}
