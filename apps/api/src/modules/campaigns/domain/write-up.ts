// SPDX-License-Identifier: AGPL-3.0-only
// Pure checks for a Campaign's write-up (spec 2026-11-20 campaign-write-up): when one is due, and
// whether what the model wrote keeps to what it was given. The sink refuses a write-up that fails
// any of them, so a person never reads a number Direx wasn't given or a winner it can't back.
import type { CampaignStatus } from "./lifecycle";

/** Ledger and Item states nothing more happens to. `held` can still clear, so it isn't one. */
export const ENDED_STATES: ReadonlySet<string> = new Set(["sent", "blocked", "cancelled", "applied"]);

/** Days after the end a write-up waits for Held steps before it's written anyway (spec Q1). */
export const SETTLE_GRACE_DAYS = 14;
export const MAX_WORDS = 120;
export const MAX_SUGGESTIONS = 3;

/**
 * What decides whether a write-up is due. `states` are the Campaign's email Actions and posts. DMs
 * are sent by hand and marked by a person, so an unmarked one can't hold the write-up back; a
 * marked one still counts as something that went out.
 */
export type DueInput = { status: CampaignStatus; endsOn: string; states: readonly string[]; sentDms: number };

export const settled = (states: readonly string[]): boolean => states.every((s) => ENDED_STATES.has(s));
export const wentOut = (states: readonly string[], sentDms: number): boolean => sentDms > 0 || states.includes("sent");

const days = (from: string, to: string) => Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000);

/** Ended, something went out, and every step settled or the grace days have passed. */
export function dueForWriteUp(c: DueInput, today: string): boolean {
  if (c.status !== "ended" || !wentOut(c.states, c.sentDms)) return false;
  return settled(c.states) || days(c.endsOn, today) >= SETTLE_GRACE_DAYS;
}

export type Suggestion = { assumption: string; because: string; readingIds: string[] };
export type WriteUpOutput = { schemaVersion: 1; paragraph: string; cites: string[]; suggestions: Suggestion[] };

/** What the model was given, as the checks need it. */
export type Brief = {
  text: string;
  readingIds: ReadonlySet<string>;
  /** True when some outcome kind has two rows with enough outcomes to compare. */
  comparable: boolean;
  /** The Strategy's current assumptions. */
  assumptions: readonly string[];
};

// ponytail: digits only. A number spelled out ("twelve") passes; the prompt asks for digits, and
// the evals hold it to that. Add a words-to-number pass if real write-ups spell them.
// Numbers can't start inside labels like "B2B". "-1,200" keeps its sign, but "2026-11" is two numbers.
const NUMBER = /(?<![\w.])-?(?:\d[\d,]*(?:\.\d+)?|\.\d+)/g;
// Reading ids are UUIDs; their digits are no number anyone was given.
const UUID = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi;
const numbersIn = (text: string) => (text.replace(UUID, " ").match(NUMBER) ?? [])
  .map((n) => n.replaceAll(",", "").replace(/^(-?)\./, (_, sign: string) => `${sign}0.`));

/** The numbers in `text` that appear nowhere in the brief. Dates, counts and readings all count. */
export function numbersOutsideBrief(text: string, brief: string): string[] {
  const given = new Set(numbersIn(brief));
  return [...new Set(numbersIn(text).filter((n) => !given.has(n)))];
}

// Overlaps say who was reached, never what caused a result (result-overlaps spec).
const CREDIT = /\b(thanks to|because of|due to|from this campaign|drove|driven by|led to|resulted in|caused|generated|produced|brought in|earned|attributed to|credit)\b/i;
export const creditPhrase = (text: string): string | null => text.match(CREDIT)?.[0] ?? null;

// A winner needs a comparison; "too few to compare" gives none.
const WINNER = /\b(better|best|worse|worst|outperform\w*|beat|beats|won|winner|wins|(?:more|most|less|least)\s+(?:effective|successful)|stronger|strongest|weaker|weakest|works? best)\b/i;
// "no channel is judged better" says the opposite of a winner (real eval, 2026-11-20): a negation in
// the few words before the winner word cancels it only within the same clause.
const NEGATED = /\b(no|not|never|neither|nor|none|cannot|can't|isn't|aren't|wasn't|weren't|without)\b(?:\W+\w+){0,4}\W*$/i;
const CLAUSE_BOUNDARY = /[.!?;,:…—–\r\n]|\b(?:but|whereas)\b/i;
export function claimsWinner(text: string, comparable: boolean): boolean {
  if (comparable) return false;
  for (const m of text.matchAll(new RegExp(WINNER.source, "gi"))) {
    const clause = text.slice(0, m.index).split(CLAUSE_BOUNDARY).at(-1)!;
    if (!NEGATED.test(clause)) return true;
  }
  return false;
}

const same = (a: string, b: string) => a.trim().toLowerCase().replace(/\s+/g, " ") === b.trim().toLowerCase().replace(/\s+/g, " ");
const words = (text: string) => text.trim().split(/\s+/).filter(Boolean).length;

/** Why the output can't be shown, or null when it keeps to the brief. */
export function writeUpProblem(o: WriteUpOutput, brief: Brief): string | null {
  if (words(o.paragraph) > MAX_WORDS) return `too_long:${words(o.paragraph)}`;
  if (o.suggestions.length > MAX_SUGGESTIONS) return `too_many_suggestions:${o.suggestions.length}`;
  const texts = [o.paragraph, ...o.suggestions.flatMap((s) => [s.assumption, s.because])];
  for (const t of texts) {
    const invented = numbersOutsideBrief(t, brief.text);
    if (invented.length) return `number_not_in_brief:${invented[0]}`;
    const credit = creditPhrase(t);
    if (credit) return `credit:${credit.toLowerCase()}`;
    if (claimsWinner(t, brief.comparable)) return "winner_without_comparison";
    // Ids belong under cites; a person reads the paragraph (seen in the real eval, 2026-11-20).
    if ([...brief.readingIds].some((id) => t.includes(id))) return "reading_id_in_text";
  }
  for (const id of [...o.cites, ...o.suggestions.flatMap((s) => s.readingIds)]) if (!brief.readingIds.has(id)) return `unknown_reading:${id}`;
  for (const s of o.suggestions) {
    if (!s.readingIds.length) return "suggestion_without_reading";
    if (brief.assumptions.some((a) => same(a, s.assumption))) return "repeats_assumption";
  }
  return null;
}
