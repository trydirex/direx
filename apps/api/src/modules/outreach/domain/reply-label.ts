// SPDX-License-Identifier: AGPL-3.0-only
// Pure: what a model's label on a reply may say. A label only orders the queue and picks the alert, so a
// label with no words of the sender's behind it is dropped to "unlabelled", never guessed.
export const REPLY_LABELS = ["interested", "question", "not_now", "referral", "wrong_person", "no"] as const;
export type ReplyLabel = (typeof REPLY_LABELS)[number];
export type LabelAnswer = { label: ReplyLabel; quote: string };
export type LabelReading = { label: ReplyLabel; quote: string } | { label: "unlabelled" };

const norm = (s: string) => s.normalize("NFKC").replace(/\s+/g, " ").trim().toLowerCase();

export function readLabel(a: LabelAnswer | null, words: string): LabelReading {
  const q = a ? norm(a.quote) : "";
  return a && q && norm(words).includes(q) ? { label: a.label, quote: a.quote } : { label: "unlabelled" };
}
