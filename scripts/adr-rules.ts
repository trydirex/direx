// SPDX-License-Identifier: AGPL-3.0-only
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

// Prints the `adr-rules` whose `applies_to` matches the files this branch changed, so a reviewer
// reads the rules before the diff. The ADRs live in the workspace repo, not here: pass
// --decisions <dir>, or it reads ../../.agent/System/decisions. Paths given as arguments replace
// the git diff. Exit 0 printed, 2 could not run.

export type AdrRule = { id: string; rule: string; appliesTo: string; verify: string; adr: string; status: string };

const PREFIX = "repositories/direx/";

export function parseRules(adr: string, markdown: string): AdrRule[] {
  const status = /^- \*\*Status\*\*: (.*)$/m.exec(markdown)?.[1] ?? "unknown";
  const rules: AdrRule[] = [];
  for (const block of markdown.matchAll(/```adr-rules\n([\s\S]*?)```/g)) {
    for (const record of block[1]!.split(/\n\s*\n/)) {
      const kv = Object.fromEntries([...record.matchAll(/^(\w+): (.*)$/gm)].map((m) => [m[1], m[2]!]));
      if (kv.id && kv.applies_to && kv.applies_to !== "none") rules.push({ id: kv.id, rule: kv.rule ?? "", appliesTo: kv.applies_to, verify: kv.verify ?? "", adr, status });
    }
  }
  return rules;
}

/**
 * Rules from ADRs not superseded whose glob matches at least one path (paths relative to the
 * workspace root), the narrowest glob first, since `repositories/direx/**` matches every change.
 */
export function matchingRules(rules: AdrRule[], paths: string[]): AdrRule[] {
  return rules
    .filter((r) => !r.status.startsWith("superseded") && paths.some((p) => new Bun.Glob(r.appliesTo).match(p)))
    .sort((a, b) => depth(b.appliesTo) - depth(a.appliesTo));
}

// How many directories the glob names before its first wildcard or brace list.
const depth = (glob: string) => glob.split(/[*{]/)[0]!.split("/").length;

function changedFiles(): string[] {
  const git = (args: string[]) => execFileSync("git", args, { encoding: "utf8" });
  const base = git(["merge-base", process.env.DIREX_BASE ?? "origin/main", "HEAD"]).trim();
  const lines = `${git(["diff", "--name-only", base, "--"])}\n${git(["ls-files", "--others", "--exclude-standard"])}`;
  return [...new Set(lines.split("\n").filter(Boolean))];
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  const at = args.indexOf("--decisions");
  const dir = at >= 0 ? args.splice(at, 2)[1]! : join(import.meta.dir, "../../../.agent/System/decisions");
  if (!existsSync(dir)) {
    console.error(`adr-rules: ${dir} not found; pass --decisions <dir> pointing at the workspace's .agent/System/decisions`);
    process.exit(2);
  }
  const paths = (args.length ? args : changedFiles()).map((p) => (p.startsWith(PREFIX) ? p : PREFIX + p));
  const rules = readdirSync(dir)
    .filter((f) => /^\d{4}-.*\.md$/.test(f))
    .flatMap((f) => parseRules(f.replace(/\.md$/, ""), readFileSync(join(dir, f), "utf8")));
  const hits = matchingRules(rules, paths);
  console.log(`${hits.length} rules apply to ${paths.length} changed files`);
  for (const r of hits) console.log(`\n${r.id} (${r.adr}) applies_to ${r.appliesTo}\n  ${r.rule}\n  verify: ${r.verify}`);
}
