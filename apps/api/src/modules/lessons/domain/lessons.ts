// SPDX-License-Identifier: AGPL-3.0-only
// Pure: what a lesson's words may be, and how much of an Agent's prompt lessons may take.

export const LESSON_PROPOSAL_KIND = "lesson_proposal";
/** One sentence a person types. */
export const MAX_LESSON_CHARS = 300;
/** All of one Agent's accepted lessons in one Workspace, together. */
export const LESSON_BUDGET_CHARS = 2_200;

export type LessonRefusal = "lesson_empty" | "lesson_too_long" | "lesson_budget_full" | "target_changed" | "lesson_withdrawn" | "lesson_check_unevaluated" | "lesson_check_refused";

/** The words as stored, or why they can't be. One line, so it reads as one statement. */
export function lessonText(raw: string): { ok: true; text: string } | { ok: false; reason: LessonRefusal } {
  const text = raw.replace(/\s+/g, " ").trim();
  if (!text) return { ok: false, reason: "lesson_empty" };
  if (text.length > MAX_LESSON_CHARS) return { ok: false, reason: "lesson_too_long" };
  return { ok: true, text };
}

/** Whether the live set, with one lesson's words swapped for `text` (or added), still fits. */
export function fitsBudget(live: readonly { id: string; text: string }[], text: string, replacing?: string): boolean {
  return live.filter((l) => l.id !== replacing).reduce((n, l) => n + l.text.length, text.length) <= LESSON_BUDGET_CHARS;
}
