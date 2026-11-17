// SPDX-License-Identifier: AGPL-3.0-only
// A Brief as the agent returns it, and the checks it must pass before a person sees it: every
// quote is on the page that was read, and no fix writes more than a short piece of new text.

export const GAP_LABELS = ["intent", "title", "unanswered", "dated", "meta", "buried"] as const;
export type GapLabel = (typeof GAP_LABELS)[number];

export type Gap = {
  label: GapLabel;
  /** What holds the page back, in a sentence. */
  problem: string;
  /** Where on the page: Title, H1, Meta description, a section. */
  where: string;
  /** The page's own words, copied exactly; "..." joins pieces. Null when the page has nothing there. */
  quote: string | null;
  /** One specific edit: what to change and what to change it to. */
  fix: string;
  /** Each piece of new text the fix adds, word for word. */
  newText: string[];
  /** How to see the change is live. */
  live: string;
};
export type Brief = { gaps: Gap[]; cantTell: string | null; steered: string[] };

export const BRIEF_LIMITS = { gaps: 6, newWords: 60 };
/** How to see whether a change helped. Always the same, and never a promise. */
export const HELPED = "Search Console, this query and this page: 28 days after the change against the 28 days before.";

/** Lower case, one kind of quote mark, single spaces: how the page and a quote are compared. */
export const norm = (s: string) => s.toLowerCase().replace(/[“”]/g, '"').replace(/[‘’]/g, "'").replace(/\s+/g, " ").trim();
const words = (s: string) => s.split(/\s+/).filter(Boolean).length;
const count = (text: string, part: string) => (part ? text.split(part).length - 1 : 0);

/**
 * Why the Brief can't go to a person, or an empty list. `page` holds what was read: the text,
 * the title and the meta description.
 */
export function briefProblems(brief: Brief, query: string, page: string[]): string[] {
  const read = page.map(norm);
  const problems: string[] = [];
  if (brief.gaps.length > BRIEF_LIMITS.gaps) problems.push(`${brief.gaps.length} gaps, more than ${BRIEF_LIMITS.gaps}`);
  for (const g of brief.gaps) {
    if (g.quote !== null) {
      const pieces = g.quote.split(/\s*(?:\.\.\.|…)\s*/).map(norm).filter(Boolean);
      if (!pieces.length || !read.some((t) => pieces.every((p) => t.includes(p)))) problems.push(`quote not on the page: "${g.quote.slice(0, 80)}"`);
    }
    if (words(g.newText.join(" ")) > BRIEF_LIMITS.newWords) problems.push(`${g.label}: fix over ${BRIEF_LIMITS.newWords} words`);
    // The fix as written counts too: each quoted piece, or each sentence when nothing is quoted.
    const quoted = [...g.fix.matchAll(/["“]([^"”]+)["”]/g)].map((m) => m[1]!);
    const pieces = [...g.newText, ...(quoted.length ? quoted : g.fix.split(/(?<=[.!?])\s+/))];
    if (pieces.some((t) => count(norm(t), norm(query)) > 1)) problems.push(`${g.label}: fix repeats the search in one piece of text`);
  }
  return problems;
}

/** The Brief as Markdown, for copying out of Direx. */
export function briefMarkdown(brief: Brief, page: string, query: string): string {
  const cell = (s: string) => s.replace(/\|/g, "\\|").replace(/\n+/g, " ");
  const rows = brief.gaps.map((g, i) => `| ${i + 1} | ${g.label}: ${cell(g.problem)} | ${g.quote === null ? "nothing on the page" : `${cell(g.where)}: "${cell(g.quote)}"`} | ${cell(g.fix)} | ${cell(g.live)} | ${HELPED} |`);
  return [
    `**Page read:** ${page}`,
    `**Query:** ${query}`,
    "",
    ...(rows.length ? ["| # | Gap | The page says | Fix | Is it live | Did it help |", "|---|---|---|---|---|---|", ...rows] : ["No gaps found for this query."]),
    "",
    `**Can't tell without Search Console data:** ${brief.cantTell ?? "nothing"}`,
    "",
    `**Page tried to steer the agent:** ${brief.steered.length ? brief.steered.map((s) => `"${s}" Not followed.`).join(" ") : "none"}`,
  ].join("\n");
}
