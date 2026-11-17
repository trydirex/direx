// SPDX-License-Identifier: AGPL-3.0-only
import { readFileSync } from "node:fs";

// Checks a pull request against the rules in CONTRIBUTING.md and AGENTS.md ("Pull requests").
// CI runs it on the pull_request event with a read-only token. Every author: the title and the
// template's sections. Authors without write access also: a linked issue labelled `accepted`, and
// the size limit. Dependabot is skipped. Exit 0 pass, 1 a rule failed, 2 could not run.

export type Pr = { number: number; title: string; body: string | null; author_association: string; user: { login: string } };
export type PrFile = { filename: string; additions: number; deletions: number };
export type Get = <T>(path: string) => Promise<T | null>;

const WRITERS = new Set(["OWNER", "MEMBER", "COLLABORATOR"]);
const REQUIRED = ["What this changes", "Verification"];
const MAX_TITLE = 72;
const MAX_LINES = 500;
const MAX_FILES = 10;

export function titleProblems(title: string): string[] {
  const out: string[] = [];
  if (/^[\w-]+(\([^)]*\))?!?:\s/.test(title)) out.push("the title has a `type:` prefix; write one imperative sentence instead");
  else if (!/^[A-Z]/.test(title)) out.push("the title must start with a capital letter");
  if (title.length > MAX_TITLE) out.push(`the title is ${title.length} characters; keep it to ${MAX_TITLE}`);
  if (title.endsWith(".")) out.push("the title ends with a full stop");
  return out;
}

/** The text under each `## ` heading of a description, by heading. */
function sections(body: string): Map<string, string> {
  const map = new Map<string, string>();
  for (const part of body.split(/^## +/m).slice(1)) {
    const nl = part.indexOf("\n");
    map.set((nl < 0 ? part : part.slice(0, nl)).trim(), nl < 0 ? "" : part.slice(nl + 1).trim());
  }
  return map;
}

export function bodyProblems(body: string): string[] {
  const out: string[] = [];
  const s = sections(body);
  for (const name of REQUIRED) {
    if (!s.has(name)) out.push(`the description has no "## ${name}" section; copy .github/pull_request_template.md`);
    else if (!s.get(name)) out.push(`"## ${name}" is empty`);
  }
  if (/^Replace this line/m.test(body)) out.push(`the description still has a "Replace this line" placeholder`);
  return out;
}

export function linkedIssue(body: string): number | undefined {
  const m = /\b(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)\s+#(\d+)\b/i.exec(body);
  return m ? Number(m[1]) : undefined;
}

// The lockfile and drizzle's migration snapshots are generated, and one snapshot alone runs to
// thousands of lines.
const counted = (f: PrFile) => f.filename !== "bun.lock" && !f.filename.startsWith("packages/db/migrations/meta/");

export function size(files: PrFile[]): { files: number; lines: number } {
  const kept = files.filter(counted);
  return { files: kept.length, lines: kept.reduce((n, f) => n + f.additions + f.deletions, 0) };
}

async function prFiles(get: Get, repo: string, n: number): Promise<PrFile[]> {
  const all: PrFile[] = [];
  for (let page = 1; ; page++) {
    const batch = (await get<PrFile[]>(`/repos/${repo}/pulls/${n}/files?per_page=100&page=${page}`)) ?? [];
    all.push(...batch);
    if (batch.length < 100) return all;
  }
}

export async function problems(pr: Pr, repo: string, get: Get): Promise<string[]> {
  if (pr.user.login === "dependabot[bot]") return [];
  const body = pr.body ?? "";
  const out = [...titleProblems(pr.title), ...bodyProblems(body)];
  if (WRITERS.has(pr.author_association)) return out;

  const n = linkedIssue(body);
  if (n === undefined) out.push("no linked issue; start the description with `Closes #N` for an issue labelled `accepted`");
  else {
    const issue = await get<{ labels: { name: string }[]; pull_request?: unknown }>(`/repos/${repo}/issues/${n}`);
    if (!issue) out.push(`issue #${n} doesn't exist`);
    else if (issue.pull_request) out.push(`#${n} is a pull request, not an issue`);
    else if (!issue.labels.some((l) => l.name === "accepted")) {
      out.push(`issue #${n} isn't labelled \`accepted\`; only accepted issues take outside pull requests. Once it is, re-run this check`);
    }
  }
  const s = size(await prFiles(get, repo, pr.number));
  if (s.lines > MAX_LINES || s.files > MAX_FILES) {
    out.push(`${s.lines} changed lines in ${s.files} files; the limit is ${MAX_LINES} lines and ${MAX_FILES} files, not counting bun.lock and packages/db/migrations/meta/. Split the work`);
  }
  return out;
}

const github =
  (token: string): Get =>
  async <T>(path: string) => {
    const res = await fetch(`https://api.github.com${path}`, {
      headers: { authorization: `Bearer ${token}`, accept: "application/vnd.github+json" },
    });
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`GET ${path}: HTTP ${res.status}`);
    return (await res.json()) as T;
  };

if (import.meta.main) {
  const eventPath = process.env.GITHUB_EVENT_PATH;
  const token = process.env.GITHUB_TOKEN;
  if (!eventPath || !token) {
    console.error("check-pr: needs GITHUB_EVENT_PATH and GITHUB_TOKEN; CI runs it on pull_request");
    process.exit(2);
  }
  const event = JSON.parse(readFileSync(eventPath, "utf8")) as { pull_request: Pr; repository: { full_name: string } };
  try {
    const found = await problems(event.pull_request, event.repository.full_name, github(token));
    // `::error::` lines show up on the pull request's checks page, not only in the log.
    for (const p of found) console.log(`::error title=pr-policy::${p}`);
    if (!found.length) console.log("check-pr: the pull request follows CONTRIBUTING.md");
    process.exit(found.length ? 1 : 0);
  } catch (e) {
    console.error(`check-pr: ${(e as Error).message}`);
    process.exit(2);
  }
}
