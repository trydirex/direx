// SPDX-License-Identifier: AGPL-3.0-only
// Pure: which of the agent's moments become clips. Each is snapped to word edges, then checked; a
// moment that fails is dropped with why, never the whole run.
import type { Word } from "./transcript";

/** Whether a cited Fact version may be relied on, as the facts module answers it. */
export type Citation = "ok" | "missing" | "stale" | "retired" | "needs_decision";

export type Moment = { startMs: number; endMs: number; title: string; caption: string; citations: string[]; measureKey: string | null; why: string };
export type Dropped = { moment: Moment; reason: string };

/** [DEFAULT] Facebook Reels takes at most 90 s; under 20 s rarely carries a point. */
export const MIN_CLIP_MS = 20_000;
export const MAX_CLIP_MS = 90_000;
/** [DEFAULT] More than this from one video crowds a week's posts. */
export const MAX_CLIPS = 8;

const CITATION = /^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})@(\d{1,9})$/;

/** "fact_id@version" as its two parts, or null when it isn't shaped that way, so it never reaches a query. */
export function parseCitation(c: string): { id: string; version: number } | null {
  const m = CITATION.exec(c);
  return m ? { id: m[1]!, version: Number(m[2]) } : null;
}

const CITATION_REASON: Record<Exclude<Citation, "ok">, string> = {
  missing: "isn't a Fact in this Workspace",
  stale: "has changed since that version",
  retired: "was retired",
  needs_decision: "is waiting on a person's decision",
};

/** Moved out to the edges of the words it cuts through, so no clip starts or ends mid-word. */
export function snap(m: Moment, words: readonly Word[]): Moment {
  const inside = words.filter((w) => w.endMs > m.startMs && w.startMs < m.endMs);
  if (!inside.length) return m;
  return { ...m, startMs: Math.min(m.startMs, inside[0]!.startMs), endMs: Math.max(m.endMs, inside.at(-1)!.endMs) };
}

/**
 * Kept in the agent's order: a moment must sit inside the video, last 20 to 90 s, back a current Fact
 * or a plan measure with every citation valid, and not overlap one already kept. At most 8 are kept.
 */
export function checkMoments(moments: readonly Moment[], c: { durationMs: number; words: readonly Word[]; citations: ReadonlyMap<string, Citation>; measures: ReadonlySet<string> }): { kept: Moment[]; dropped: Dropped[] } {
  const kept: Moment[] = [];
  const dropped: Dropped[] = [];
  for (const raw of moments) {
    const m = snap(raw, c.words);
    const reason = problem(m, c) ?? (kept.some((k) => m.startMs < k.endMs && k.startMs < m.endMs) ? "overlaps a moment already kept" : null) ?? (kept.length >= MAX_CLIPS ? `more than ${MAX_CLIPS} moments` : null);
    if (reason) dropped.push({ moment: raw, reason });
    else kept.push(m);
  }
  return { kept, dropped };
}

function problem(m: Moment, c: { durationMs: number; citations: ReadonlyMap<string, Citation>; measures: ReadonlySet<string> }): string | null {
  if (m.startMs < 0 || m.endMs > c.durationMs || m.endMs <= m.startMs) return "falls outside the video";
  const length = m.endMs - m.startMs;
  if (length < MIN_CLIP_MS) return `is shorter than ${MIN_CLIP_MS / 1000} s`;
  if (length > MAX_CLIP_MS) return `is longer than ${MAX_CLIP_MS / 1000} s`;
  if (!m.citations.length && !m.measureKey) return "backs no Fact or goal";
  for (const cited of m.citations) {
    const result = c.citations.get(cited) ?? "missing";
    if (result !== "ok") return `cites ${cited}, which ${CITATION_REASON[result]}`;
  }
  if (m.measureKey && !c.measures.has(m.measureKey)) return `names ${m.measureKey}, which isn't a measure in the plan`;
  return null;
}
