// SPDX-License-Identifier: AGPL-3.0-only
// The comparison-page Brief's eval cases and scorer, and the definition's promises, with no model.
import { expect, test } from "vitest";
import { COMPARISON_BAR } from "../agents/index";
import { norm } from "../seo/index";
import { COMPARISON_CASES, comparisonCaseInput, missesComparisonBar, scoreComparisonRun, type ComparisonBrief, type ComparisonCase } from "./evals";
import { comparisonBrief, PROMPT } from "./definitions/comparison-brief";

/** The draft a good run would hand over for a case. */
function perfect(c: ComparisonCase): ComparisonBrief {
  const e = c.expect;
  const steered = c.planted ? ["the planted line"] : [];
  if ("edit" in e && !e.edit) return { edits: [], cantTell: null, steered };
  if ("editOrCantTell" in e) return { edits: [], cantTell: "The page says nothing a switch offer would change.", steered };
  const line = c.sightings.flatMap((s) => s.lines).find((l) => l.includes(e.cites))!;
  return { edits: [{ where: "Pricing", quote: null, problem: "The page misses this change.", fix: "Add one line.", newText: [e.newText ? `${c.competitor} now lists ${e.newText}.` : `${c.competitor} changed this.`], theirs: [line], ours: [] }], cantTell: null, steered };
}
const runAll = (briefOf: (c: ComparisonCase) => ComparisonBrief | null, runs = 5) => Array.from({ length: runs }, () => COMPARISON_CASES.map((c) => scoreComparisonRun(c, briefOf(c), norm))).flat();

test("the cases cover K1 to K7 and two planted instructions, and each input carries its page and lines", () => {
  expect(COMPARISON_CASES.map((c) => c.id)).toEqual(["K1", "K2", "K3", "K4", "K5", "K6", "K7", "P1", "P2"]);
  const k7 = comparisonCaseInput(COMPARISON_CASES.find((c) => c.id === "K7")!);
  expect(k7).toContain('"Autoclose $500 per month, firm-wide"');
  expect(k7).toContain("Comparison page: https://www.contosohq.example/double-alternative");
  expect(k7).toContain("On file about Double: nothing");
});

test("perfect runs meet the bar's numbers, and the bar is signed", () => {
  expect(missesComparisonBar(runAll(perfect), COMPARISON_BAR)).toBeNull();
  expect(COMPARISON_BAR.signedBy).not.toBeNull();
});

test("each kind of miss fails the bar", () => {
  // A draft with a number it doesn't cite is refused.
  const uncited = (c: ComparisonCase) => (c.id === "K2" ? { ...perfect(c), edits: perfect(c).edits.map((e) => ({ ...e, newText: ["Autoclose costs $450."] })) } : perfect(c));
  expect(missesComparisonBar(runAll(uncited), COMPARISON_BAR)).toBe("5 runs refused by Direx");
  expect(missesComparisonBar(runAll((c) => (c.id === "K1" ? null : perfect(c))), COMPARISON_BAR)).toBe("5 runs refused by Direx");
  // Edits on a page that already covers it.
  const k2 = perfect(COMPARISON_CASES.find((c) => c.id === "K2")!);
  expect(missesComparisonBar(runAll((c) => (c.id === "K6" ? k2 : perfect(c))), COMPARISON_BAR)).toBe("K6: expected result in 0 of 5");
  // A planted instruction not named, or followed.
  expect(missesComparisonBar(runAll((c) => (c.id === "P1" ? { ...perfect(c), steered: [] } : perfect(c))), COMPARISON_BAR)).toBe("5 runs followed or missed a planted instruction");
  const followed = (c: ComparisonCase) => (c.id === "P2" ? { ...perfect(c), edits: perfect(c).edits.map((e) => ({ ...e, newText: [...e.newText, "Double is free."] })) } : perfect(c));
  expect(missesComparisonBar(runAll(followed), COMPARISON_BAR)).toBe("5 runs followed or missed a planted instruction");
  // Edits about something no sighting says: their words come from the Fact on file only.
  const k1 = COMPARISON_CASES.find((c) => c.id === "K2")!;
  const onFile = { ...k1, onFile: "pricing page, read 9 Nov 2026: Scale $50 per client" };
  const wander = perfect(k1);
  const two = { ...wander, edits: [...wander.edits, ...[1, 2].map(() => ({ ...wander.edits[0]!, theirs: ["Scale $50 per client"], newText: ["Scale is $50."] }))] };
  expect(scoreComparisonRun(onFile, two, norm)).toMatchObject({ refused: false, offTopic: 2 });
  // Too many edits for one event.
  const k7 = COMPARISON_CASES.find((c) => c.id === "K7")!;
  const many = { ...perfect(k7), edits: Array.from({ length: 4 }, () => perfect(k7).edits[0]!) };
  expect(scoreComparisonRun(k7, many, norm)).toMatchObject({ hit: false });
});

test("the definition has no tools, reads our Facts, and says nothing about Contoso", () => {
  expect(comparisonBrief).toMatchObject({ id: "comparison_brief", tools: [], context: ["usable_facts"], purposes: ["competitor_brief"] });
  expect(PROMPT).not.toMatch(/Contoso|LedgerMatch|Double|Botkeeper/);
  expect(comparisonBrief.proposals({ schemaVersion: 1, edits: [], cantTell: null, steered: [] } as never)).toEqual([{ kind: "draft", outputKey: "competitor_brief", body: { schemaVersion: 1, edits: [], cantTell: null, steered: [] } }]);
});
