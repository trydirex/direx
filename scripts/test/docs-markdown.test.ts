// SPDX-License-Identifier: AGPL-3.0-only
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { expect, test } from "vitest";

const root = join(import.meta.dirname, "../..");

// trydirex.com renders docs/ from each release tag, and GitHub renders it as it is, so every page
// stays plain Markdown: one H1 as its title, and no MDX (ADR 0034, DX-R-0034-004).
export function problems(text: string): string[] {
  const found: string[] = [];
  let fenced = false;
  let h1s = 0;
  for (const line of text.split("\n")) {
    if (/^\s{0,3}(```|~~~)/.test(line)) {
      fenced = !fenced;
      continue;
    }
    if (fenced) continue;
    if (line.startsWith("# ")) h1s++;
    if (/^(import|export)\s.*\bfrom\s+["']|^import\s+["']|^export\s+(const|let|var|function|class|default)\b/.test(line)) found.push(`an MDX ${line.split(/\s/)[0]} line`);
    if (/<[A-Z][A-Za-z]*[\s/>]/.test(line.replace(/`[^`]*`/g, ""))) found.push("a JSX component");
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
});
