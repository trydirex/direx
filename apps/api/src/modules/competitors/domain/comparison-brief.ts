// SPDX-License-Identifier: AGPL-3.0-only
// Pure: the checks a drafted comparison-page Brief passes before a person sees it, in place of a model
// claim-check. Our page is quoted as read; every claim about the competitor carries its own words; every
// number in new text is in what that edit cites. `norm` (seo's, passed in) folds case, quotes and spaces.

export const COMPARISON_LIMITS = { edits: 4, newWords: 60 };

export type ComparisonEdit = { where: string; quote: string | null; problem: string; fix: string; newText: string[]; theirs: string[]; ours: string[] };
export type ComparisonBrief = { edits: ComparisonEdit[]; cantTell: string | null; steered: string[] };
/** What the run was given: our page (text, title, meta description), the competitor's words (sighting lines and its Fact), our Facts by id. */
/** `read` holds the ISO dates their lines were read, which an edit may name. */
export type Seen = { page: string[]; theirs: string[]; ours: ReadonlyMap<string, string>; read: string[] };
export type Norm = (s: string) => string;

const NUMBER = /[$€£]?\d(?:[\d,]*\d)?(?:\.\d+)?%?/g;
const day = (iso: string) => new Date(iso).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });
const words = (s: string) => s.split(/\s+/).filter(Boolean).length;
/** `norm`, with "1,000" and "1000" as one number. */
export const foldOf = (norm: Norm) => (s: string) => norm(s).replace(/(\d),(?=\d)/g, "$1");
/** The numbers in `text` that aren't in `cited` (already folded). Shared with the post's checks. */
export const uncitedNumbers = (text: string, cited: string, fold: (s: string) => string) => (text.match(NUMBER) ?? []).filter((n) => !cited.includes(fold(n)));

/** Why the Brief can't go to a person, or an empty list. */
export function comparisonProblems(brief: ComparisonBrief, seen: Seen, norm: Norm): string[] {
  const fold = foldOf(norm);
  const page = seen.page.map(fold);
  const theirs = seen.theirs.map(fold);
  const problems: string[] = [];
  if (brief.edits.length > COMPARISON_LIMITS.edits) problems.push(`${brief.edits.length} edits, more than ${COMPARISON_LIMITS.edits}`);
  for (const e of brief.edits) {
    const at = e.where.slice(0, 40);
    if (e.quote !== null) {
      const pieces = e.quote.split(/\s*(?:\.\.\.|…)\s*/).map(fold).filter(Boolean);
      if (!pieces.length || !page.some((t) => pieces.every((p) => t.includes(p)))) problems.push(`${at}: quote not on our page: "${e.quote.slice(0, 80)}"`);
    }
    if (e.theirs.length === 0) problems.push(`${at}: no words of theirs cited`);
    for (const t of e.theirs) if (!theirs.some((s) => s.includes(fold(t)))) problems.push(`${at}: not their words: "${t.slice(0, 80)}"`);
    for (const id of e.ours) if (!seen.ours.has(id)) problems.push(`${at}: unknown Fact ${id.slice(0, 40)}`);
    if (words(e.newText.join(" ")) > COMPARISON_LIMITS.newWords) problems.push(`${at}: new text over ${COMPARISON_LIMITS.newWords} words`);
    const cited = [...e.theirs, ...e.ours.map((id) => seen.ours.get(id) ?? ""), ...seen.read.map(day)].map(fold).join(" ");
    for (const n of uncitedNumbers(e.newText.join(" "), cited, fold)) problems.push(`${at}: "${n}" is not in what the edit cites`);
  }
  return problems;
}

/** The Brief as Markdown, for copying out of Direx. */
export function comparisonMarkdown(brief: ComparisonBrief, page: string, competitor: string): string {
  const cell = (s: string) => s.replace(/\|/g, "\\|").replace(/\n+/g, " ");
  const rows = brief.edits.map((e, i) => `| ${i + 1} | ${cell(e.where)} | ${e.quote === null ? "nothing on the page" : `"${cell(e.quote)}"`} | ${cell(e.fix)} | ${cell(e.newText.join(" "))} | ${e.theirs.map((t) => `"${cell(t)}"`).join(", ")} |`);
  return [
    `**Comparison page:** ${page}`,
    `**Competitor:** ${competitor}`,
    "",
    ...(rows.length ? ["| # | Where | Your page says | Fix | New text | Their words |", "|---|---|---|---|---|---|", ...rows] : ["Your page already covers this."]),
    ...(brief.cantTell ? ["", `**Can't tell:** ${brief.cantTell}`] : []),
  ].join("\n");
}

export type BriefPage = { url: string; title: string | null; metaDescription: string | null; text: string };
export type BriefSighting = { source: string; readAt: string; lines: string[] };

/** The run's pasted text: the competitor, what's on file about them, their changed lines with read dates, and our page. */
export function comparisonInput(competitor: string, onFile: string | null, sightings: BriefSighting[], page: BriefPage): string {
  return [
    `Competitor: ${competitor}`,
    `On file about ${competitor}: ${onFile ?? "nothing"}`,
    "",
    "Changed lines:",
    ...sightings.flatMap((s) => [`- ${s.source} page, read ${day(s.readAt)}:`, ...s.lines.map((l) => `  "${l}"`)]),
    "",
    `Comparison page: ${page.url}`,
    `Title: ${page.title ?? "(none)"}`,
    `Meta description: ${page.metaDescription ?? "(none)"}`,
    "Text:",
    page.text,
  ].join("\n");
}
