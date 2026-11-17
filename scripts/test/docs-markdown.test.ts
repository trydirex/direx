// SPDX-License-Identifier: AGPL-3.0-only
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { expect, test } from "vitest";

const root = join(import.meta.dirname, "../..");

function withoutCodeSpans(text: string): string {
  let prose = "";
  for (let i = 0; i < text.length;) {
    // Escapes apply in prose; inside a code span, even a backslash cannot escape its closer.
    if (text[i] === "\\") {
      prose += text.slice(i, i + 2);
      i += 2;
      continue;
    }
    if (text[i] !== "`") {
      prose += text[i++];
      continue;
    }
    const run = /^`+/.exec(text.slice(i))![0];
    const candidates = /`+/g;
    candidates.lastIndex = i + run.length;
    let close: RegExpExecArray | null;
    while ((close = candidates.exec(text)) && close[0].length !== run.length) { /* seek an equal run */ }
    if (close) i = close.index + run.length;
    else {
      prose += run;
      i += run.length;
    }
  }
  return prose;
}

// trydirex.com renders docs/ from each release tag, and GitHub renders it as it is, so every page
// stays plain Markdown: one H1 as its title, and no MDX (ADR 0034, DX-R-0034-004).
export function problems(text: string): string[] {
  const found: string[] = [];
  // The open fence's run, such as "````"; it closes only on the same character, at least as long.
  let fence = "";
  let h1s = 0;
  let paragraph: string[] = [];
  const listIndents: number[] = [];
  const checkParagraph = () => {
    // Code spans can cross soft line breaks, but cannot cross paragraph/block boundaries.
    const prose = withoutCodeSpans(paragraph.join("\n"));
    if (/<[A-Z][\w.]*[\s/>]/.test(prose)) found.push("a JSX component");
    paragraph = [];
  };
  for (const raw of text.split("\n")) {
    // Tabs advance to four-column stops before measuring container indentation.
    let line = raw.replace(/^[ \t]+/, (prefix) => {
      let width = 0;
      for (const char of prefix) width += char === "\t" ? 4 - width % 4 : 1;
      return " ".repeat(width);
    });
    if (line.trim()) {
      const indent = /^ */.exec(line)![0].length;
      while (listIndents.length && indent < listIndents.at(-1)!) listIndents.pop();
      line = line.slice(listIndents.at(-1) ?? 0);
      if (!fence && !/^ {0,3}(?:(?:\* *){3,}|(?:- *){3,}|(?:_ *){3,})$/.test(line)) {
        const marker = /^ {0,3}(?:[-+*]|\d{1,9}[.)])(?: {1,4}(?=\S)| (?= +\S)| *$)/.exec(line);
        if (marker) {
          checkParagraph();
          listIndents.push((listIndents.at(-1) ?? 0) + marker[0].length);
          line = line.slice(marker[0].length);
        }
      }
    }
    const opener = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
    const run = opener?.[1];
    if (fence) {
      if (run && run[0] === fence[0] && run.length >= fence.length && /^[ \t\r]*$/.test(opener![2]!)) fence = "";
      continue;
    }
    if (run && (run[0] === "~" || !opener![2]!.includes("`"))) {
      checkParagraph();
      fence = run;
      continue;
    }
    if (!line.trim()) {
      checkParagraph();
      continue;
    }
    // Indented code cannot interrupt a paragraph; indented paragraph continuations are prose.
    if (/^( {4}| {0,3}\t)/.test(line) && paragraph.length === 0) continue;
    const atx = /^ {0,3}#{1,6}(\s|$)/.test(line);
    const setext = paragraph.length > 0 && /^ {0,3}(=+|-+)[ \t\r]*$/.test(line);
    if (/^ {0,3}#(\s|$)/.test(line) || (setext && line.trim().startsWith("="))) h1s++;
    // Headings and other block starts cannot supply paragraph text for a Setext underline.
    const block = atx || setext || /^ {0,3}(>|[-+*]\s|\d+[.)]\s|(?:\* *){3,}$|(?:- *){3,}$|(?:_ *){3,}$)/.test(line);
    if (block) checkParagraph();
    if (/^(import|export)\s.*\bfrom\s+["']|^import\s+["']|^export\s+(const|let|var|function|class|default)\b|^export\s*[{*]/.test(line)) found.push(`an MDX ${line.split(/[\s{*]/)[0]} line`);
    paragraph.push(line);
    if (block) checkParagraph();
  }
  checkParagraph();
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

test("invalid backtick fence info does not hide headings", () => {
  expect(problems("# Title\n\n```inline```\n\n# Second\n")).toEqual(["2 H1 headings, not 1"]);
  expect(problems("# Title\n\n~~~ info `allowed`\n<Tabs />\n~~~\n")).toEqual([]);
  expect(problems("# Title\n\n```js\n<Tabs />\n``` trailing\n<Tabs />\n```\n")).toEqual([]);
});

test("indented code is literal, while paragraph continuations remain prose", () => {
  expect(problems("# Title\n\n    <Tabs />\n\n\t<Tabs />\n")).toEqual([]);
  expect(problems("# Title\n\n    ```\n\n# Second\n")).toEqual(["2 H1 headings, not 1"]);
  expect(problems("# Title\n\nParagraph\n    <Tabs />\n")).toEqual(["a JSX component"]);
  expect(problems("# Title\n\n    <Tabs />\n\n<Tabs />\n")).toEqual(["a JSX component"]);
});

test("Setext underlines require paragraph text", () => {
  expect(problems("# Title\n===\n")).toEqual([]);
  expect(problems("Title\n===\n")).toEqual([]);
  expect(problems("# Title\n\n## Section\n===\n")).toEqual([]);
  expect(problems("# Title\n\n---\n===\n")).toEqual([]);
  expect(problems("# Title\n\nSection\n---\n===\n")).toEqual([]);
  expect(problems("# Title\n\n* * *\n===\n")).toEqual([]);
});

test("JSX checks exclude complete multiline code spans within a paragraph", () => {
  expect(problems("# Title\n\n`example\n<Tabs>\n`\n")).toEqual([]);
  expect(problems("# Title\n\n``example\n`<Tabs>`\n``\n")).toEqual([]);
  expect(problems("# Title\n\n`example\n<Tabs>\n")).toEqual(["a JSX component"]);
  expect(problems("# Title\n\n`example\n\n<Tabs>\n`\n")).toEqual(["a JSX component"]);
  expect(problems("# Title\n\n`example\n<Tabs>\n` <Other />\n")).toEqual(["a JSX component"]);
  expect(problems("# Title\n\n`example\n\n```\n`\n```\n<Tabs />\n")).toEqual(["a JSX component"]);
});

test("escaped opening backticks do not hide JSX", () => {
  expect(problems("# Title\n\n" + "\\" + "`<Tabs />`\n")).toEqual(["a JSX component"]);
  expect(problems("# Title\n\n" + "\\".repeat(2) + "`<Tabs />`\n")).toEqual([]);
  expect(problems("# Title\n\n" + "\\".repeat(3) + "`<Tabs />`\n")).toEqual(["a JSX component"]);
  expect(problems("# Title\n\n`<Tabs />" + "\\" + "`\n")).toEqual([]);
  expect(problems("# Title\n\n" + "\\" + "`literal `<Tabs />`\n")).toEqual([]);
  expect(problems("# Title\n\n" + "\\" + "``<Tabs />`\n")).toEqual([]);
});

test("indented code is measured inside list containers", () => {
  expect(problems("# Title\n\n- Item\n\n    <Tabs />\n")).toEqual(["a JSX component"]);
  expect(problems("# Title\n\n- Item\n\n      <Tabs />\n")).toEqual([]);
  expect(problems("# Title\n\n10. Item\n\n      <Tabs />\n")).toEqual(["a JSX component"]);
  expect(problems("# Title\n\n10. Item\n\n        <Tabs />\n")).toEqual([]);
  expect(problems("# Title\n\n- Item\n  - Nested\n\n      <Tabs />\n")).toEqual(["a JSX component"]);
  expect(problems("# Title\n\n- Item\n  - Nested\n\n        <Tabs />\n")).toEqual([]);
  expect(problems("# Title\n\n- Item\n\nParagraph\n\n    <Tabs />\n")).toEqual([]);
  expect(problems("# Title\n\n- Item\n\n\t<Tabs />\n")).toEqual(["a JSX component"]);
  expect(problems("# Title\n\n- Item\n\n  ```\n  <Tabs />\n  ```\n")).toEqual([]);
});
