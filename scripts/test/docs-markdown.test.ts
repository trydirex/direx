// SPDX-License-Identifier: AGPL-3.0-only
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { expect, test } from "vitest";

const root = join(import.meta.dirname, "../..");

// trydirex.com renders docs/ from each release tag, and GitHub renders it as it is, so every page
// stays plain Markdown: one H1 as its title, and no MDX (ADR 0034, DX-R-0034-004).
export function problems(text: string): string[] {
  const found: string[] = [];
  // The open fence's run, such as "````"; it closes only on the same character, at least as long.
  let fence = "";
  let h1s = 0;
  let prev = "";
  for (const line of text.split("\n")) {
    const run = /^ {0,3}(`{3,}|~{3,})/.exec(line)?.[1];
    if (run && (fence ? run[0] === fence[0] && run.length >= fence.length && /^ {0,3}[`~]+\s*$/.test(line) : true)) {
      fence = fence ? "" : run;
      prev = "";
      continue;
    }
    if (fence) continue;
    // An ATX "# Title", or a Setext title: a line of "=" under text.
    if (/^ {0,3}#(\s|$)/.test(line) || (/^ {0,3}=+\s*$/.test(line) && prev.trim() !== "")) h1s++;
    prev = line;
    if (/^(import|export)\s.*\bfrom\s+["']|^import\s+["']|^export\s+(const|let|var|function|class|default)\b|^export\s*[{*]/.test(line)) found.push(`an MDX ${line.split(/[\s{*]/)[0]} line`);
    // Code spans close on a backtick run as long as the one that opened them.
    if (/<[A-Z][\w.]*[\s/>]/.test(line.replace(/(?<!`)(`+)(?!`).*?(?<!`)\1(?!`)/g, ""))) found.push("a JSX component");
  }
  if (h1s !== 1) found.push(`${h1s} H1 headings, not 1`);
  return found;
}

function markdownUnder(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? markdownUnder(join(dir, e.name)) : e.name.endsWith(".md") ? [join(dir, e.name)] : [],
  );
}

test("every page in docs/ is plain Markdown with one H1", () => {
  const files = markdownUnder(join(root, "docs"));
  expect(files.length).toBeGreaterThan(0);
  const bad = files.flatMap((f) => problems(readFileSync(f, "utf8")).map((p) => `${relative(root, f)}: ${p}`));
  expect(bad).toEqual([]);
});

test("the check catches what the website can't render", () => {
  expect(problems("# Title\n\nText with `<Code>` and an\nexport for 6 years.\n\n```\n# not a title\nimport x from 'y'\n```\n")).toEqual([]);
  expect(problems("Text only.\n")).toEqual(["0 H1 headings, not 1"]);
  expect(problems("# One\n\n# Two\n")).toEqual(["2 H1 headings, not 1"]);
  expect(problems("# T\n\nimport { Tabs } from 'x'\n\n<Tabs>\n")).toEqual(["an MDX import line", "a JSX component"]);
  expect(problems("# Title\n\n````\n```\n# Example\n```\n````\n\nText with ``<Tabs>``.\n")).toEqual([]);
  expect(problems("# One\n\nTwo\n===\n")).toEqual(["2 H1 headings, not 1"]);
  expect(problems("# One\n\n # Two\n")).toEqual(["2 H1 headings, not 1"]);
  expect(problems("# Title\n\nexport {}\n")).toEqual(["an MDX export line"]);
  expect(problems("# Title\n\n<Tabs.Panel />\n")).toEqual(["a JSX component"]);
});
