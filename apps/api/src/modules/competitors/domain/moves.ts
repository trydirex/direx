// SPDX-License-Identifier: AGPL-3.0-only
// Pure: what a counter-move holds. Every word in it is the competitor's own, quoted from a Change, or
// a fixed phrase; nothing here is written by a model. One event (a Change and its sameAs sightings)
// is one counter-move.
import type { Source } from "./competitor";
import type { ChangeDetail } from "./diff";
import type { CounterMove } from "./labels";

/** A Fact value is at most this long [DEFAULT]; past it, the first lines (a changelog's newest) are kept. */
export const MAX_FACT_CHARS = 1000;
export const MAX_TITLE_LINE_CHARS = 60;
export const MOVE_KIND = "competitor_move";

export type Read = { id: string; readAt: string };
export type Sighting = { changeId: string; source: Source; lines: string[]; before: Read; after: Read & { url: string } };
/** The Item's moves: a Fact update is a Fact proposal, not one of these. */
export type ItemMove = Exclude<CounterMove, "fact_update">;
export type MovePayload = {
  schemaVersion: 1;
  move: ItemMove;
  competitor: { id: string; name: string };
  target: string | null;
  reason: string;
  sightings: Sighting[];
  brief: unknown;
  briefRunId: string | null;
  /** Why there's no draft (Brief or post), or the post's reason for writing none. */
  briefNote: string | null;
  /** A post move's draft and its run; absent on payloads stored before posts were drafted. */
  post?: unknown;
  postRunId?: string | null;
};

/** The Change's lines as they read on the page; removed pricing lines say so. */
export function linesOf(detail: ChangeDetail): string[] {
  if ("rewritten" in detail) return [`Page rewritten: ${detail.rewritten.added} lines added, ${detail.rewritten.removed} removed`];
  if ("part" in detail) return [`${detail.part}: ${detail.after ?? "(gone)"}`];
  return [...detail.added, ...(detail.removed ?? []).map((l) => `Removed: ${l}`)];
}

/** The first Change of an event: follow sameAs until it ends. */
export function rootOf(id: string, sameAs: ReadonlyMap<string, string | null>): string {
  const seen = new Set<string>([id]);
  let at = id;
  for (let next = sameAs.get(at); next; next = sameAs.get(at)) {
    if (seen.has(next)) throw new Error(`sameAs cycle at ${next}`);
    seen.add(next);
    at = next;
  }
  return at;
}

const day = (iso: string) => new Date(iso).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });
const plain = (s: string) => s.replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim();

/** "pricing page, read 16 Nov 2026: line; line", cut at whole lines to MAX_FACT_CHARS. */
export function factValue(source: Source, readAt: string, detail: ChangeDetail): string {
  let value = `${source} page, read ${day(readAt)}:`;
  for (const [n, line] of linesOf(detail).map(plain).entries()) {
    const next = `${value}${n ? ";" : ""} ${line}`;
    if (next.length > MAX_FACT_CHARS) break;
    value = next;
  }
  return value;
}

export const factSource = (competitor: string, source: Source, after: Sighting["after"]) => ({
  kind: "website" as const,
  label: `${competitor} ${source} page`,
  url: after.url,
  retrievedAt: after.readAt,
});

function cut(s: string, max: number): string {
  const t = plain(s);
  return t.length <= max ? t : `${t.slice(0, max - 1).trimEnd()}…`;
}

export function moveTitle(move: ItemMove, competitor: string, firstLine: string | undefined): string {
  if (move === "comparison_page") return `Update your ${competitor} comparison page`;
  return firstLine ? `Post about ${competitor}: ${cut(firstLine, MAX_TITLE_LINE_CHARS)}` : `Post about ${competitor}`;
}

export function movePayload(move: ItemMove, competitor: { id: string; name: string }, target: string | null, reason: string, first: Sighting): MovePayload {
  return { schemaVersion: 1, move, competitor, target, reason, sightings: [first], brief: null, briefRunId: null, briefNote: null, post: null, postRunId: null };
}

/** The payload with one more sighting of the same event; the same sighting twice changes nothing. */
export function addSighting(p: MovePayload, s: Sighting): MovePayload {
  return p.sightings.some((x) => x.changeId === s.changeId) ? p : { ...p, sightings: [...p.sightings, s] };
}
