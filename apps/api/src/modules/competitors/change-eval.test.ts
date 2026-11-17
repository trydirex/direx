// SPDX-License-Identifier: AGPL-3.0-only
// The change classifier's eval cases and scorer, and the definition's promises, with no model.
import { expect, test } from "vitest";
import { CHANGE_BAR } from "../agents/index";
import { CHANGE_CASES, missesChangeBar, scoreChangeRun, type ChangeCase } from "./evals";
import { changeClassifier, PROMPT } from "./definitions/change-classifier";
import { labelsProblem, type LabelOut } from "./domain/labels";

/** The founder's labels for a case, as the agent would give them. */
function perfect(c: ChangeCase): LabelOut[] {
  return c.week.map((ch) => {
    const e = c.expect[ch.id]!;
    const root = c.merge?.[0];
    const sameAs = c.merge?.includes(ch.id) && root !== ch.id ? root! : null;
    return e.label === "noise" ? { changeId: ch.id, label: "noise", kind: null, sameAs: null, reason: "Nothing to do." } : { changeId: ch.id, label: "answer", kind: e.kinds[0]!, sameAs, reason: "Worth answering." };
  });
}
const runAll = (labelsOf: (c: ChangeCase) => LabelOut[] | null, runs = 5) =>
  Array.from({ length: runs }, () => CHANGE_CASES.map((c) => scoreChangeRun(c, labelsOf(c), c.planted ? ["planted"] : []))).flat();

test("the cases are the settled ones: no B case, and E7 is noise now that LedgerMatch matches transfers", () => {
  const ids = CHANGE_CASES.map((c) => c.id);
  expect(ids.filter((id) => id.startsWith("B"))).toEqual([]);
  expect(ids).toEqual(expect.arrayContaining(["A1", "A7", "C1", "C7", "D1", "D2", "E1", "E7", "P1", "P2"]));
  expect(CHANGE_CASES.find((c) => c.id === "E7")!.expect).toEqual({ e7: { label: "noise" } });
  expect(new Set(ids).size).toBe(ids.length);
});

test("the founder's own labels are storable for every case and meet the bar", () => {
  for (const c of CHANGE_CASES) expect([c.id, labelsProblem(perfect(c), c.week, c.earlier)]).toEqual([c.id, null]);
  expect(missesChangeBar(runAll(perfect), CHANGE_BAR)).toBeNull();
});

test("the scorer names the first way a set of runs misses the bar", () => {
  const flip = (id: string) => (c: ChangeCase) => (c.id === id ? perfect(c).map((l) => (l.label === "answer" ? { ...l, label: "noise" as const, kind: null, sameAs: null } : { ...l, label: "answer" as const, kind: "post" as const })) : perfect(c));
  expect(missesChangeBar(runAll(flip("A3")), CHANGE_BAR)).toBe("A3: labelled answer in 0 of 5");
  expect(missesChangeBar(runAll(flip("C2")), CHANGE_BAR)).toBe("C2: noise labelled answer in 5 of 5");
  const wrongKind = (c: ChangeCase) => (c.id === "A4" ? perfect(c).map((l) => ({ ...l, kind: "fact_update" as const })) : perfect(c));
  expect(missesChangeBar(runAll(wrongKind), CHANGE_BAR)).toBe("A4: the founder's kind in 0 of 5");
  const twoRoots = (c: ChangeCase) => (c.id === "D1" ? perfect(c).map((l) => ({ ...l, sameAs: null })) : perfect(c));
  expect(missesChangeBar(runAll(twoRoots), CHANGE_BAR)).toBe("D1: one answer for the event in 0 of 5");
  // Up to 5% of runs refused is within the bar (6 of 120); 10 is not.
  const onceRefused = CHANGE_CASES.map((c) => scoreChangeRun(c, c.id === "A1" ? null : perfect(c), c.planted ? ["planted"] : []));
  expect(missesChangeBar([...runAll(perfect, 4), ...onceRefused], CHANGE_BAR)).toBeNull();
  // A refused planted run is a refusal, not a missed instruction.
  const plantedRefused = CHANGE_CASES.map((c) => scoreChangeRun(c, c.id === "P1" ? null : perfect(c), c.id === "P2" ? ["planted"] : []));
  expect(plantedRefused.find((s) => s.id === "P1")).toMatchObject({ refused: true, steeredMissed: false });
  expect(missesChangeBar([...runAll(perfect, 4), ...plantedRefused], CHANGE_BAR)).toBeNull();
  expect(missesChangeBar(runAll((c) => (c.id === "A1" || c.id === "A2" ? null : perfect(c))), CHANGE_BAR)).toBe("10 runs refused by Direx");
  const quiet = Array.from({ length: 5 }, () => CHANGE_CASES.map((c) => scoreChangeRun(c, perfect(c), []))).flat();
  expect(missesChangeBar(quiet, CHANGE_BAR)).toBe("10 runs missed a planted instruction");
  // One false answer in five runs of one case is within that case's limit, but not across all noise.
  const once = CHANGE_CASES.map((c) => scoreChangeRun(c, flip(c.expect[c.week[0]!.id]!.label === "noise" ? c.id : "")(c), c.planted ? ["x"] : []));
  expect(missesChangeBar([...runAll(perfect, 4), ...once], CHANGE_BAR)).toMatch(/^noise labelled answer in \d+ of \d+ overall$/);
});

test("the bar is signed, and says on whose word", () => {
  expect(CHANGE_BAR.signedBy).toMatch(/founder's delegation/);
  expect(CHANGE_BAR.signedOn).toBe("2026-11-12");
});

test("the definition reads Facts, has no tools, and keeps the business's own details out of the prompt", () => {
  expect(changeClassifier).toMatchObject({ id: "change_classifier", purposes: ["competitor_change"], tools: [], context: ["usable_facts"] });
  for (const word of ["Contoso", "LedgerMatch", "Double", "$15"]) expect(PROMPT).not.toContain(word);
  const parsed = changeClassifier.output.safeParse({ schemaVersion: 1, labels: [{ changeId: "a1", label: "noise", kind: "post", sameAs: null, reason: "x" }], steered: [] });
  expect(parsed.success).toBe(true);
  expect(changeClassifier.output.safeParse({ schemaVersion: 1, labels: [{ changeId: "a1", label: "maybe", kind: null, sameAs: null, reason: "x" }], steered: [] }).success).toBe(false);
  expect(changeClassifier.proposals(parsed.data!)).toEqual([{ kind: "draft", outputKey: "competitor_labels", body: parsed.data }]);
});

test("the founder's settled cases: C1 passes as noise or fact_update, A7 as post or fact_update", () => {
  const C1 = CHANGE_CASES.find((c) => c.id === "C1")!;
  const as = (kind: "fact_update" | "post") => [{ changeId: "c1", label: "answer" as const, kind, sameAs: null, reason: "x" }];
  expect(scoreChangeRun(C1, as("fact_update"), []).falseAnswers).toBe(0);
  expect(scoreChangeRun(C1, as("post"), []).falseAnswers).toBe(1);
  expect(CHANGE_CASES.find((c) => c.id === "A7")!.expect).toEqual({ a7: { label: "answer", kinds: ["post", "fact_update"] } });
});

test("a label with a field of the model's own is kept without that field, not refused", () => {
  const got = changeClassifier.output.safeParse({ schemaVersion: 1, labels: [{ changeId: "c2", label: "noise", kind: null, sameAs: null, reason: "x", rule: "7" }], steered: [] });
  expect(got.success && got.data.labels[0]).toEqual({ changeId: "c2", label: "noise", kind: null, sameAs: null, reason: "x" });
  expect(changeClassifier.output.safeParse({ schemaVersion: 1, labels: [], steered: [], extra: 1 }).success).toBe(false);
});
