// SPDX-License-Identifier: AGPL-3.0-only
// Pure: what the change classifier is shown for a week's Changes, and the checks on what it answers.
// The lines come from competitor pages, so the text is untrusted; only the Change lines go in, never
// a whole snapshot.
import type { Source } from "./competitor";
import type { ChangeDetail } from "./diff";

export const LABELS = ["answer", "noise"] as const;
export type Label = (typeof LABELS)[number];
/** `ranking_brief` waits for competitor-rankings; the database already allows it. */
export const COUNTER_MOVES = ["fact_update", "comparison_page", "post"] as const;
export type CounterMove = (typeof COUNTER_MOVES)[number];
export const MAX_REASON_CHARS = 200;

export type ChangeForLabel = { id: string; competitorId: string; competitor: string; source: Source; at: Date; detail: ChangeDetail };
export type EarlierAnswer = { id: string; competitorId: string; competitor: string; source: Source; at: Date; kind: string; reason: string };
export type LabelOut = { changeId: string; label: Label; kind: CounterMove | null; sameAs: string | null; reason: string };

const day = (d: Date) => d.toISOString().slice(0, 10);
const quoted = (lines: string[]) => lines.map((l) => `  "${l}"`).join("\n");

function describe(d: ChangeDetail): string {
  if ("rewritten" in d) return `Page rewritten: ${d.rewritten.added} lines added, ${d.rewritten.removed} removed (lines not kept).`;
  if ("part" in d) return `Landing ${d.part} was ${d.before === null ? "missing" : `"${d.before}"`}, now ${d.after === null ? "missing" : `"${d.after}"`}.`;
  return [d.added.length ? `Lines added:\n${quoted(d.added)}` : "", d.removed?.length ? `Lines removed:\n${quoted(d.removed)}` : ""].filter(Boolean).join("\n");
}

/** The week's new Changes, one block each, then the answers of the last weeks that a new one may be a sighting of. */
export function labelInput(changes: ChangeForLabel[], earlier: EarlierAnswer[]): string {
  const blocks = changes.map((c) => `Change ${c.id}\n${c.competitor}, ${c.source}, ${day(c.at)}\n${describe(c.detail)}`);
  const before = earlier.map((a) => `Change ${a.id}: ${a.competitor}, ${a.source}, ${day(a.at)}, labelled answer (${a.kind}): ${a.reason}`);
  return [`New Changes to label (${changes.length}):`, ...blocks, before.length ? `Earlier answers, for sameAs only:\n${before.join("\n")}` : "No earlier answers."].join("\n\n");
}

/**
 * Why the classifier's labels can't be stored, or null. One label per Change it was given, no other
 * ids, a kind exactly on an answer, and sameAs only on an answer, naming an earlier answer or another
 * Change of this week, from the same competitor.
 */
export function labelsProblem(labels: LabelOut[], changes: ChangeForLabel[], earlier: EarlierAnswer[]): string | null {
  const given = new Map(changes.map((c) => [c.id, c.competitorId]));
  const owner = new Map([...earlier.map((a) => [a.id, a.competitorId] as const), ...given]);
  const seen = new Set<string>();
  for (const l of labels) {
    if (!given.has(l.changeId)) return `labelled ${l.changeId}, which it wasn't given`;
    if (seen.has(l.changeId)) return `labelled ${l.changeId} twice`;
    seen.add(l.changeId);
    if ((l.label === "answer") !== (l.kind !== null)) return `${l.changeId}: ${l.label} with kind ${l.kind}`;
    if (!l.reason.trim() || l.reason.length > MAX_REASON_CHARS) return `${l.changeId}: reason must be 1 to ${MAX_REASON_CHARS} characters`;
    if (l.sameAs === null) continue;
    if (l.label !== "answer") return `${l.changeId}: sameAs on noise`;
    if (l.sameAs === l.changeId) return `${l.changeId}: sameAs itself`;
    if (owner.get(l.sameAs) !== given.get(l.changeId)) return `${l.changeId}: sameAs ${l.sameAs}, not an earlier sighting from the same competitor`;
  }
  const missed = changes.filter((c) => !seen.has(c.id));
  return missed.length ? `no label for ${missed.map((c) => c.id).join(", ")}` : null;
}
