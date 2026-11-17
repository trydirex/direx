// SPDX-License-Identifier: AGPL-3.0-only
// How far a per-Person draft strays from its step's skeleton. The review page highlights what differs,
// so this is only worth building on if drafts keep most of the skeleton and add a sentence or two.
import { merge } from "../domain/merge";
import { compareToSkeleton, editDistance } from "../domain/skeleton";

/** The step's email the eval writes from. No numbers, so the claim check has nothing to hold. */
export const SKELETON_TEMPLATE = {
  subject: "Bookkeeping for {{company}}",
  text: "Hi {{firstName}},\n\nWe do the bookkeeping for small shops, so every filing goes in on time and nothing waits on you.\n\nWould a short call next week help?",
  citations: [],
};

export type DriftRun = { drafted: boolean; kept: number; addedSentences: number };

const words = (t: string) => t.split(/\s+/).filter(Boolean).length;

/** The share of the skeleton's words the draft kept, in order, and how many sentences it added. */
export function skeletonDrift(skeleton: string, person: { firstName: string; company: string }, draft: string): Omit<DriftRun, "drafted"> {
  const filled = merge(skeleton, person);
  const base = filled.ok ? filled.text : skeleton;
  const total = words(base);
  const common = (total + words(draft) - editDistance(base, draft)) / 2;
  const added = compareToSkeleton(base, draft)
    .filter((s) => s.kind === "added")
    .map((s) => s.text)
    .join(" ");
  return { kept: total ? common / total : 1, addedSentences: (added.match(/[.!?](\s|$)/g) ?? []).length };
}

/** The bar: 90% of runs drafted, kept 80% of the skeleton and added at most 2 sentences. */
export function tallyDrift(runs: readonly DriftRun[]): { passed: boolean; measures: Record<string, number> } {
  const good = runs.filter((r) => r.drafted && r.kept >= 0.8 && r.addedSentences <= 2).length;
  const share = runs.length ? good / runs.length : 0;
  return { passed: share >= 0.9, measures: { runs: runs.length, withinBar: good, share, drafted: runs.filter((r) => r.drafted).length } };
}
