// SPDX-License-Identifier: AGPL-3.0-only
// Whether a site's robots.txt lets Direx read a page, read the way RFC 9309 says. Strict: when the
// answer isn't clear, the page isn't read. The file must be fetched under the same name Direx reads
// pages with, since some sites refuse robots.txt to other names and that refusal would read as a no.

type Rule = { allow: boolean; pattern: string };
type Group = { agents: string[]; rules: Rule[] };
/** `read: false` means read nothing on the site. */
export type Robots = { read: false } | { read: true; groups: Group[] };

/** What fetching robots.txt gave: a body, or a failure with the HTTP status when there was one. */
export type RobotsAnswer = { ok: true; html: string; truncated: boolean } | { ok: false; status?: number };

const NOTHING: Robots = { read: false };
const EVERYTHING: Robots = { read: true, groups: [] };

export function robotsFrom(answer: RobotsAnswer): Robots {
  if (!answer.ok) {
    const s = answer.status;
    // A missing file allows everything. 401 and 403 say keep out; 429, 5xx and no answer say nothing clear.
    if (s !== undefined && s >= 400 && s < 500 && s !== 401 && s !== 403 && s !== 429) return EVERYTHING;
    return NOTHING;
  }
  // Rules past the cut could be the ones that apply.
  if (answer.truncated) return NOTHING;
  return parse(answer.html);
}

function parse(text: string): Robots {
  const body = text.replace(/^﻿/, "");
  // A site that answers every address with its app shell has no robots.txt.
  if (body.trimStart().startsWith("<")) return EVERYTHING;
  const groups: Group[] = [];
  let current: Group | null = null;
  let inRules = false;
  for (const raw of body.split(/\r\n|\r|\n/)) {
    const m = /^\s*([A-Za-z-]+)\s*:\s*(.*?)\s*$/.exec(raw.replace(/#.*/, ""));
    if (!m) continue;
    const [key, value] = [m[1]!.toLowerCase(), m[2]!];
    if (key === "user-agent") {
      if (!current || inRules) groups.push((current = { agents: [], rules: [] }));
      inRules = false;
      current.agents.push(value.toLowerCase());
    } else if (key === "allow" || key === "disallow") {
      // A rule before any user-agent line names no one, so it's unclear whom it keeps out.
      if (!current) return NOTHING;
      inRules = true;
      // An empty Disallow allows everything, which is what having no rule does.
      if (value) current.rules.push({ allow: key === "allow", pattern: value });
    }
  }
  return { read: true, groups };
}

/** `path` is the path and query of the page, starting with "/". */
export function allowed(robots: Robots, agent: string, path: string): boolean {
  if (!robots.read) return false;
  if (path === "/robots.txt") return true;
  const named = robots.groups.filter((g) => g.agents.includes(agent.toLowerCase()));
  const rules = (named.length ? named : robots.groups.filter((g) => g.agents.includes("*"))).flatMap((g) => g.rules);
  let best: Rule | null = null;
  for (const rule of rules) {
    if (!matches(rule.pattern, path)) continue;
    // The longest pattern wins, and an Allow wins a tie.
    if (!best || rule.pattern.length > best.pattern.length || (rule.pattern.length === best.pattern.length && rule.allow)) best = rule;
  }
  return best?.allow ?? true;
}

/**
 * `*` is any run of characters and a final `$` ends the path; otherwise a pattern is a prefix. A
 * two-pointer match, not a regular expression, so a hostile file can't make it take forever.
 */
function matches(pattern: string, path: string): boolean {
  const p = pattern.endsWith("$") ? pattern.slice(0, -1) : `${pattern}*`;
  let [i, j, star, mark] = [0, 0, -1, 0];
  while (j < path.length) {
    if (p[i] === "*") {
      star = i++;
      mark = j;
    } else if (i < p.length && p[i] === path[j]) {
      i++;
      j++;
    } else if (star >= 0) {
      i = star + 1;
      j = ++mark;
    } else return false;
  }
  while (p[i] === "*") i++;
  return i === p.length;
}
