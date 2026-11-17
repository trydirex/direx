// SPDX-License-Identifier: AGPL-3.0-only
import { expect, test } from "vitest";
import { norm } from "../seo/index";
import { comparisonMarkdown, comparisonProblems, type ComparisonBrief, type ComparisonEdit } from "./domain/comparison-brief";

const seen = {
  page: ["Pricing. Double charges $10 to $50 per client, and AI usage is extra.", "Contoso vs Double", "Compare Contoso and Double"],
  theirs: ["Autoclose: AI agents reconcile accounts; $500/month firm-wide add-on, waived at 10+ Scale clients", "pricing page, read 16 Nov 2026: Enterprise"],
  ours: new Map([["f1", "price (per company): $15 per QuickBooks company per month"]]),
  read: ["2026-11-09T07:00:00.000Z"],
};
const edit = (over: Partial<ComparisonEdit> = {}): ComparisonEdit => ({
  where: "Pricing",
  quote: "Double charges $10 to $50 per client",
  problem: "The page misses Autoclose's add-on price.",
  fix: "Add a line after the per-client price.",
  newText: ["Double's Autoclose is a $500/month add-on; Contoso is $15 per company."],
  theirs: ["$500/month firm-wide add-on"],
  ours: ["f1"],
  ...over,
});
const problems = (edits: ComparisonEdit[]) => comparisonProblems({ edits, cantTell: null, steered: [] }, seen, norm);

test("a clean draft passes, and quote pieces joined by ... count", () => {
  expect(problems([edit()])).toEqual([]);
  expect(problems([edit({ quote: "Double charges ... AI usage is extra" })])).toEqual([]);
  expect(problems([edit({ quote: null, newText: ["No numbers here."], ours: [] })])).toEqual([]);
});

test("a quote that isn't on our page is refused", () => {
  expect(problems([edit({ quote: "Double charges $12 per client" })])).toEqual(['Pricing: quote not on our page: "Double charges $12 per client"']);
});

test("a claim about them must carry their words", () => {
  expect(problems([edit({ theirs: ["Autoclose costs $450"] })])).toEqual(['Pricing: not their words: "Autoclose costs $450"', 'Pricing: "$500" is not in what the edit cites']);
  expect(problems([edit({ theirs: [] })])).toContain("Pricing: no words of theirs cited");
});

test("a Fact id it wasn't given is refused", () => {
  expect(problems([edit({ ours: ["made-up"] })])).toContain("Pricing: unknown Fact made-up");
});

test("every number in new text is in what the edit cites", () => {
  expect(problems([edit({ newText: ["Autoclose is a $450/month add-on."] })])).toEqual(['Pricing: "$450" is not in what the edit cites']);
  // Our price needs our Fact cited.
  expect(problems([edit({ ours: [] })])).toEqual(['Pricing: "$15" is not in what the edit cites']);
  const waived = { newText: ["Waived at 10+ Scale clients, $500/month otherwise."], ours: [] };
  expect(problems([edit(waived)])).toEqual(['Pricing: "10" is not in what the edit cites']);
  expect(problems([edit({ ...waived, theirs: ["$500/month firm-wide add-on, waived at 10+ Scale clients"] })])).toEqual([]);
});

test("one number written with or without a thousands comma is the same number", () => {
  const s = { ...seen, theirs: ["Enterprise from $1,000 a month"] };
  expect(comparisonProblems({ edits: [edit({ theirs: ["Enterprise from $1,000 a month"], newText: ["Enterprise starts at $1000."], ours: [] })], cantTell: null, steered: [] }, s, norm)).toEqual([]);
});

test("a number before a comma is the number, and the day their lines were read may be named", () => {
  expect(problems([edit({ newText: ["Autoclose, $500, is extra; Contoso is $15."] })])).toEqual([]);
  expect(problems([edit({ newText: ["Per Double's changelog (read November 9, 2026), Autoclose is $500."], ours: [] })])).toEqual([]);
  expect(problems([edit({ newText: ["As of 10 Nov 2026, Autoclose is $500."], ours: [] })])).toEqual(['Pricing: "10" is not in what the edit cites']);
});

test("limits: at most 4 edits, at most 60 words of new text per edit", () => {
  expect(problems([edit(), edit(), edit(), edit(), edit()])).toContain("5 edits, more than 4");
  expect(problems([edit({ newText: ["word ".repeat(61)], ours: [] })])).toContain("Pricing: new text over 60 words");
});

test("the Markdown copy has a row per edit, or says the page covers it", () => {
  const brief: ComparisonBrief = { edits: [edit({ fix: "Add | a line" })], cantTell: "No price for Enterprise.", steered: [] };
  const md = comparisonMarkdown(brief, "https://contoso.example/vs-double", "Double");
  expect(md).toContain("| 1 | Pricing | \"Double charges $10 to $50 per client\" | Add \\| a line |");
  expect(md).toContain("**Can't tell:** No price for Enterprise.");
  expect(comparisonMarkdown({ edits: [], cantTell: null, steered: [] }, "p", "Double")).toContain("Your page already covers this.");
});
