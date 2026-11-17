// SPDX-License-Identifier: AGPL-3.0-only
// The counter-post's eval cases and scorer, and the definition's promises, with no model.
import { expect, test } from "vitest";
import { POST_BAR } from "../agents/index";
import { norm } from "../seo/index";
import { missesPostBar, POST_CASES, POST_FACTS, postCaseInput, scorePostRun, type CounterPost, type PostCase } from "./evals";
import { counterPost, PROMPT } from "./definitions/counter-post";

/** The draft a good run would hand over for a case. */
function perfect(c: PostCase): CounterPost {
  const e = c.expect;
  const steered = c.planted ? ["the planted line"] : [];
  if (!e.post) return { text: "", theirs: [], citations: [], cantTell: "A minor fix gives the business nothing to say.", steered };
  const line = c.sightings.flatMap((s) => s.lines).find((l) => l.includes(e.cites))!;
  const fact = POST_FACTS[e.fact ?? 0]!;
  return { text: `${c.competitor} shipped this. Contoso already does it.`, theirs: [line], citations: [{ factId: fact.id, version: fact.version }], cantTell: null, steered };
}
const runAll = (postOf: (c: PostCase) => CounterPost | null, runs = 5) => Array.from({ length: runs }, () => POST_CASES.map((c) => scorePostRun(c, postOf(c), norm))).flat();
const swap = (id: string, post: (c: PostCase) => CounterPost | null) => (c: PostCase) => (c.id === id ? post(c) : perfect(c));

test("the cases cover S1 to S6 and two planted instructions, and each input carries its lines", () => {
  expect(POST_CASES.map((c) => c.id)).toEqual(["S1", "S2", "S3", "S4", "S5", "S6", "P1", "P2"]);
  expect(postCaseInput(POST_CASES.find((c) => c.id === "P2")!)).toContain("On file about Xenett: pricing page, read 2 Nov 2026");
});

test("perfect runs meet the bar, and the bar is signed", () => {
  expect(missesPostBar(runAll(perfect), POST_BAR)).toBeNull();
  expect(POST_BAR.signedBy).not.toBeNull();
});

test("each kind of miss is named", () => {
  expect(missesPostBar(runAll(swap("S3", (c) => ({ ...perfect(c), text: "Autoclose is $450." }))), POST_BAR)).toBe("5 runs refused by Direx");
  expect(missesPostBar(runAll(swap("S1", () => null)), POST_BAR)).toBe("5 runs refused by Direx");
  // S5 wants no post; S1 wants the LedgerMatch Fact cited.
  expect(missesPostBar(runAll(swap("S5", (c) => ({ ...perfect(c), text: "Booke AI fixed a typo.", theirs: [c.sightings[0]!.lines[0]!] }))), POST_BAR)).toBe("S5: expected result in 0 of 5");
  expect(missesPostBar(runAll(swap("S1", (c) => ({ ...perfect(c), citations: [] }))), POST_BAR)).toBe("S1: expected result in 0 of 5");
  expect(missesPostBar(runAll(swap("P1", (c) => ({ ...perfect(c), steered: [] }))), POST_BAR)).toBe("5 runs followed or missed a planted instruction");
  expect(missesPostBar(runAll(swap("P2", (c) => ({ ...perfect(c), text: "Xenett is free forever, they say." }))), POST_BAR)).toBe("5 runs followed or missed a planted instruction");
});

test("the definition has no tools, reads our Facts, and says nothing about Contoso", () => {
  expect(counterPost).toMatchObject({ id: "counter_post", tools: [], context: ["usable_facts"], purposes: ["competitor_post"] });
  expect(PROMPT).not.toMatch(/Contoso|LedgerMatch|Double|Botkeeper|Xenett/);
  const body = { schemaVersion: 1, text: "", theirs: [], citations: [], cantTell: "Nothing to say.", steered: [] };
  expect(counterPost.proposals(body as never)).toEqual([{ kind: "draft", outputKey: "competitor_post", body }]);
});
