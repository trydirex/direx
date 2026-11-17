// SPDX-License-Identifier: AGPL-3.0-only
// Pure: which words of a per-Person draft differ from its step's skeleton, and what a reviewer's edit
// changed. What is highlighted comes from this comparison, never from the writer's own account of what
// it personalised, because a steered writer could hide text in a sentence it calls generic.

import { merge, stepFields, type MergeValues, type StepUrls } from "./merge";

export type Span = { text: string; kind: "same" | "added" };
export type EditPhrases = { removed: string[]; added: string[] };
export type Skeleton = { subject: string; text: string };

const SENDER = /\{\{\s*senderName\s*\}\}/g;

/**
 * A step's template as the per-Person writer's skeleton. A line with a step's link goes, since Direx adds
 * that line after the writer. The sender's name is filled in; the recipient's fields stay, because their
 * values come from a list Direx can't vouch for and so reach the writer only as data.
 */
export function skeletonOf(template: unknown, senderName: string): Skeleton | null {
  const t = template as { subject?: unknown; text?: unknown } | null;
  if (typeof t?.subject !== "string" || typeof t.text !== "string") return null;
  const text = t.text
    .split("\n")
    .filter((line) => !stepFields(line).length)
    .join("\n")
    .trim();
  return text ? { subject: t.subject.replace(SENDER, senderName), text: text.replace(SENDER, senderName) } : null;
}

const words = (text: string): string[] => text.split(/\s+/).filter(Boolean);
const normal = (text: string): string[] =>
  words(text)
    .map((w) => w.toLowerCase().replace(/[^\p{L}\p{N}$%]/gu, ""))
    .filter(Boolean);

/** For each word of `a` and of `b`, whether it is in their longest common subsequence. */
function common(a: readonly string[], b: readonly string[]): [boolean[], boolean[]] {
  // ponytail: O(n*m) table, fine at a few hundred words a draft; switch to Myers if drafts grow long
  const n = a.length;
  const m = b.length;
  const len = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--)
    for (let j = m - 1; j >= 0; j--) len[i]![j] = a[i] === b[j] ? len[i + 1]![j + 1]! + 1 : Math.max(len[i + 1]![j]!, len[i]![j + 1]!);
  const inA = new Array<boolean>(n).fill(false);
  const inB = new Array<boolean>(m).fill(false);
  for (let i = 0, j = 0; i < n && j < m; ) {
    if (a[i] === b[j]) {
      inA[i++] = true;
      inB[j++] = true;
    } else if (len[i + 1]![j]! >= len[i]![j + 1]!) i++;
    else j++;
  }
  return [inA, inB];
}

/** The draft split into runs that match the skeleton word for word and runs that don't. Joining the texts gives back the draft. */
export function compareToSkeleton(skeleton: string, draft: string): Span[] {
  const tokens = draft.match(/\s+|\S+/g) ?? [];
  const [, kept] = common(words(skeleton), words(draft));
  const spans: Span[] = [];
  let lead = "";
  let w = 0;
  for (const token of tokens) {
    const last = spans.at(-1);
    if (/^\s/.test(token)) {
      if (last) last.text += token;
      else lead += token;
      continue;
    }
    const kind = kept[w++] ? "same" : "added";
    if (last?.kind === kind) last.text += token;
    else {
      spans.push({ text: lead + token, kind });
      lead = "";
    }
  }
  return spans;
}

/** A draft against its step's email filled in for this Person; null when the step has no email or the Person lacks a field it needs. */
export function spansAgainst(template: unknown, values: MergeValues, urls: StepUrls, draft: string): Span[] | null {
  const text = (template as { text?: unknown } | null)?.text;
  if (typeof text !== "string") return null;
  const filled = merge(text, values, urls);
  return filled.ok ? compareToSkeleton(filled.text, draft) : null;
}

const runs = (list: readonly string[], kept: readonly boolean[]): string[] => {
  const out: string[] = [];
  let run: string[] = [];
  const flush = () => {
    if (run.length >= 2) out.push(run.join(" "));
    run = [];
  };
  list.forEach((w, i) => (kept[i] ? flush() : run.push(w)));
  flush();
  return [...new Set(out)];
};

/** The phrases of two or more words an edit removed and added, lowercased and without punctuation, so the same edit on two drafts matches. */
export function editPhrases(before: string, after: string): EditPhrases {
  const a = normal(before);
  const b = normal(after);
  const [inA, inB] = common(a, b);
  return { removed: runs(a, inA), added: runs(b, inB) };
}

/** Words removed plus words added between two texts. */
export function editDistance(a: string, b: string): number {
  const x = words(a);
  const y = words(b);
  const [inX] = common(x, y);
  const kept = inX.filter(Boolean).length;
  return x.length + y.length - 2 * kept;
}
