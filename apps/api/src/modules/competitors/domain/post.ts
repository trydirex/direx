// SPDX-License-Identifier: AGPL-3.0-only
// Pure: the checks a drafted counter-post passes before a person sees it, and the run's pasted text. The
// competitor's words are quoted as read; every number and link in the post is in what it cites. Whether it
// names anyone else is left to the prompt and the eval: Direx has no list of names to check against.
import { foldOf, uncitedNumbers, type BriefSighting, type Norm } from "./comparison-brief";

export const POST_LIMITS = { chars: 280 };

export type Citation = { factId: string; version: number };
/** An empty `text` is "no post worth writing", and says why in `cantTell`. */
export type CounterPost = { text: string; theirs: string[]; citations: Citation[]; cantTell: string | null; steered: string[] };
/** What the run was given: the competitor's words (sighting lines and its Fact), and our Facts by id. */
export type PostSeen = { theirs: string[]; ours: ReadonlyMap<string, { version: number; text: string }> };

const LINK = /\bhttps?:\/\/[^\s)]+|\bwww\.[^\s)]+/gi;

/** Why the post can't go to a person, or an empty list. */
export function postProblems(post: CounterPost, seen: PostSeen, norm: Norm): string[] {
  const fold = foldOf(norm);
  const theirs = seen.theirs.map(fold);
  const problems: string[] = [];
  const text = post.text.trim();
  if (!text) {
    if (!post.cantTell) problems.push("no post and no reason");
    return problems;
  }
  if (text.length > POST_LIMITS.chars) problems.push(`post is ${text.length} characters, more than ${POST_LIMITS.chars}`);
  if (post.theirs.length === 0) problems.push("no words of theirs cited");
  for (const t of post.theirs) if (!theirs.some((s) => s.includes(fold(t)))) problems.push(`not their words: "${t.slice(0, 80)}"`);
  const facts: string[] = [];
  for (const c of post.citations) {
    const f = seen.ours.get(c.factId);
    if (!f || f.version !== c.version) problems.push(`unknown Fact ${c.factId.slice(0, 40)} version ${c.version}`);
    else facts.push(f.text);
  }
  const cited = [...post.theirs, ...facts].map(fold).join(" ");
  for (const n of uncitedNumbers(text, cited, fold)) problems.push(`"${n}" is not in what the post cites`);
  const factText = facts.join(" ").toLowerCase();
  for (const l of text.match(LINK) ?? []) if (!factText.includes(l.toLowerCase())) problems.push(`link not given by a cited Fact: ${l.slice(0, 80)}`);
  return problems;
}

const day = (iso: string) => new Date(iso).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });

/** The run's pasted text: the competitor, what's on file about them, and their changed lines with read dates. */
export function postInput(competitor: string, onFile: string | null, sightings: BriefSighting[]): string {
  return [
    `Competitor: ${competitor}`,
    `On file about ${competitor}: ${onFile ?? "nothing"}`,
    "",
    "Changed lines:",
    ...sightings.flatMap((s) => [`- ${s.source} page, read ${day(s.readAt)}:`, ...s.lines.map((l) => `  "${l}"`)]),
  ].join("\n");
}
