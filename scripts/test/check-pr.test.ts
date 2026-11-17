// SPDX-License-Identifier: AGPL-3.0-only
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "vitest";
import { bodyProblems, type Get, linkedIssue, type Pr, type PrFile, problems, size, titleProblems } from "../check-pr";

const template = readFileSync(join(import.meta.dirname, "../../.github/pull_request_template.md"), "utf8");
const filled = template
  .replace("Closes #\n", "Closes #12\n")
  .replace(/^Replace this line: what changes.*$/m, "Adds the backlinks count to the report.")
  .replace(/^Replace this line: each command.*$/m, "bun run check:task: passed");

const pr = (over: Partial<Pr> = {}): Pr => ({
  number: 7,
  title: "Add the backlinks count to the report",
  body: filled,
  user: { login: "someone" },
  head: { repo: { full_name: "someone/r" } },
  ...over,
});

/** A fake GitHub API: each path answers from the map, anything else is a 404. */
const api =
  (routes: Record<string, unknown>): Get =>
  async <T>(path: string) =>
    (routes[path] ?? null) as T | null;

const files = (list: PrFile[]) => ({ "/repos/o/r/pulls/7/files?per_page=100&page=1": list });
const accepted = { "/repos/o/r/issues/12": { labels: [{ name: "accepted" }] } };
const small = files([{ filename: "apps/api/src/a.ts", additions: 20, deletions: 5 }]);

test("a title is one capitalised sentence, at most 72 characters, with no type prefix or full stop", () => {
  expect(titleProblems("Add the backlinks count to the report")).toEqual([]);
  expect(titleProblems("feat: add the count")).toHaveLength(1);
  expect(titleProblems("fix(api)!: add the count")).toHaveLength(1);
  expect(titleProblems("add the count")).toEqual(["the title must start with a capital letter"]);
  expect(titleProblems("Add the count.")).toEqual(["the title ends with a full stop"]);
  expect(titleProblems(`A${"a".repeat(72)}`)).toEqual(["the title is 73 characters; keep it to 72"]);
});

test("the template as shipped fails until its placeholders are replaced, and passes once filled", () => {
  expect(bodyProblems(template)).toEqual([`the description still has a "Replace this line" placeholder`]);
  expect(bodyProblems(filled)).toEqual([]);
});

test("a description without the template's sections, or with one left empty, fails", () => {
  expect(bodyProblems("Fixes the thing")).toEqual([
    `the description has no "## What this changes" section; copy .github/pull_request_template.md`,
    `the description has no "## Verification" section; copy .github/pull_request_template.md`,
  ]);
  expect(bodyProblems("## What this changes\n\nA fix.\n\n## Verification\n\n## AI use (optional)\n")).toEqual([`"## Verification" is empty`]);
});

test("the linked issue comes from a closing keyword, and the bare template line links nothing", () => {
  expect(linkedIssue("Closes #12")).toBe(12);
  expect(linkedIssue("this fixes #3 for good")).toBe(3);
  expect(linkedIssue("Closes #\n")).toBeUndefined();
  expect(linkedIssue("See #12")).toBeUndefined();
});

test("the lockfile and migration snapshots don't count toward the size", () => {
  expect(
    size([
      { filename: "bun.lock", additions: 900, deletions: 100 },
      { filename: "packages/db/migrations/meta/0146_snapshot.json", additions: 18000, deletions: 0 },
      { filename: "packages/db/migrations/0146_add.sql", additions: 12, deletions: 0 },
    ]),
  ).toEqual({ files: 1, lines: 12 });
});

test("an outside PR on an accepted issue within the limits passes", async () => {
  expect(await problems(pr(), "o/r", api({ ...accepted, ...small }))).toEqual([]);
});

test("an outside PR needs a linked issue that exists, is an issue and is labelled accepted", async () => {
  const body = (n: string) => filled.replace("Closes #12", `Closes #${n}`);
  expect(await problems(pr({ body: body("") }), "o/r", api(small))).toEqual([
    "no linked issue; start the description with `Closes #N` for an issue labelled `accepted`",
  ]);
  expect(await problems(pr({ body: body("99") }), "o/r", api(small))).toEqual(["issue #99 doesn't exist"]);
  expect(await problems(pr(), "o/r", api({ ...small, "/repos/o/r/issues/12": { labels: [], pull_request: {} } }))).toEqual([
    "#12 is a pull request, not an issue",
  ]);
  expect(await problems(pr(), "o/r", api({ ...small, "/repos/o/r/issues/12": { labels: [{ name: "idea" }] } }))).toEqual([
    "issue #12 isn't labelled `accepted`; only accepted issues take outside pull requests. Once it is, re-run this check",
  ]);
});

test("an outside PR over 500 lines or 10 files fails, reading every page of files", async () => {
  const many = Array.from({ length: 100 }, (_, i) => ({ filename: `docs/${i}.md`, additions: 1, deletions: 0 }));
  const routes = {
    ...accepted,
    "/repos/o/r/pulls/7/files?per_page=100&page=1": many,
    "/repos/o/r/pulls/7/files?per_page=100&page=2": [{ filename: "docs/last.md", additions: 450, deletions: 0 }],
  };
  expect(await problems(pr(), "o/r", api(routes))).toEqual([
    "550 changed lines in 101 files; the limit is 500 lines and 10 files, not counting bun.lock and packages/db/migrations/meta/. Split the work",
  ]);
});

const permission = (p: string) => ({ "/repos/o/r/collaborators/someone/permission": { permission: p } });

test("a writer's PR is held to the title and template but needs no issue and has no size limit", async () => {
  const body = "## What this changes\n\nA fix.\n\n## Verification\n\nbun run check:task: passed\n";
  expect(await problems(pr({ body }), "o/r", api(permission("write")))).toEqual([]);
  expect(await problems(pr({ title: "fix: things", body: null }), "o/r", api(permission("admin")))).toHaveLength(3);
});

test("an org member or collaborator who can only read is held to the issue and size rules", async () => {
  const body = "## What this changes\n\nA fix.\n\n## Verification\n\nbun run check:task: passed\n";
  expect(await problems(pr({ body }), "o/r", api({ ...permission("read"), ...small }))).toEqual([
    "no linked issue; start the description with `Closes #N` for an issue labelled `accepted`",
  ]);
});

test("a PR from a branch in this repository is a writer's, even when a private org member shows as CONTRIBUTOR", async () => {
  const body = "## What this changes\n\nA fix.\n\n## Verification\n\nbun run check:task: passed\n";
  expect(await problems(pr({ head: { repo: { full_name: "o/r" } }, body }), "o/r", api({}))).toEqual([]);
  expect(await problems(pr({ head: { repo: null }, body }), "o/r", api(small))).toEqual([
    "no linked issue; start the description with `Closes #N` for an issue labelled `accepted`",
  ]);
});

test("Dependabot is skipped", async () => {
  expect(await problems(pr({ user: { login: "dependabot[bot]" }, title: "Bump hono", body: null }), "o/r", api({}))).toEqual([]);
});
