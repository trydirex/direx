// SPDX-License-Identifier: AGPL-3.0-only
import { expect, test } from "vitest";
import { labelInput, labelsProblem, type ChangeForLabel, type EarlierAnswer, type LabelOut } from "./domain/labels";

const at = new Date("2026-11-16T07:00:00Z");
const DOUBLE = "c-double";
const XENETT = "c-xenett";
const autoclose: ChangeForLabel = { id: "ch1", competitorId: DOUBLE, competitor: "Double", source: "changelog", at, detail: { added: ["Autoclose: AI agents reconcile accounts"] } };
const addOn: ChangeForLabel = { id: "ch2", competitorId: DOUBLE, competitor: "Double", source: "pricing", at, detail: { added: ["Autoclose $500 per month"], removed: ["Even more from Double"] } };
const headline: ChangeForLabel = { id: "ch3", competitorId: XENETT, competitor: "Xenett", source: "landing", at, detail: { part: "headline", before: "Close faster", after: null } };
const redesign: ChangeForLabel = { id: "ch4", competitorId: XENETT, competitor: "Xenett", source: "pricing", at, detail: { rewritten: { added: 40, removed: 35 } } };
const earlier: EarlierAnswer = { id: "old1", competitorId: DOUBLE, competitor: "Double", source: "changelog", at: new Date("2026-10-29T07:00:00Z"), kind: "comparison_page", reason: "Autoclose prices reconciliation" };

const label = (changeId: string, over: Partial<LabelOut> = {}): LabelOut => ({ changeId, label: "noise", kind: null, sameAs: null, reason: "minor", ...over });

test("the input names each Change with its lines, landing values and rewrite counts, then the earlier answers", () => {
  const text = labelInput([autoclose, addOn, headline, redesign], [earlier]);
  expect(text).toContain("New Changes to label (4):");
  expect(text).toContain('Change ch1\nDouble, changelog, 2026-11-16\nLines added:\n  "Autoclose: AI agents reconcile accounts"');
  expect(text).toContain('Lines added:\n  "Autoclose $500 per month"\nLines removed:\n  "Even more from Double"');
  expect(text).toContain('Landing headline was "Close faster", now missing.');
  expect(text).toContain("Page rewritten: 40 lines added, 35 removed (lines not kept).");
  expect(text).toContain("Earlier answers, for sameAs only:\nChange old1: Double, changelog, 2026-10-29, labelled answer (comparison_page): Autoclose prices reconciliation");
  expect(labelInput([{ ...autoclose, detail: { added: [], removed: ["Gone"] } }], [])).toContain('Lines removed:\n  "Gone"\n\nNo earlier answers.');
});

test("labels for every Change, with sightings of one event pointing back, pass (D1, D2)", () => {
  const labels = [
    label("ch1", { label: "answer", kind: "comparison_page", sameAs: "old1", reason: "Autoclose, seen in October" }),
    label("ch2", { label: "answer", kind: "comparison_page", sameAs: "ch1", reason: "The same add-on on the pricing page" }),
    label("ch3"),
    label("ch4", { label: "answer", kind: "fact_update", reason: "Pricing page redesigned; a person looks" }),
  ];
  expect(labelsProblem(labels, [autoclose, addOn, headline, redesign], [earlier])).toBeNull();
});

test("an output Direx can't store is refused with the reason", () => {
  const given = [autoclose, headline];
  const ok = [label("ch1"), label("ch3")];
  const swap = (i: number, l: LabelOut) => ok.map((x, j) => (j === i ? l : x));
  expect(labelsProblem([...ok, label("other")], given, [])).toBe("labelled other, which it wasn't given");
  expect(labelsProblem([label("ch1"), label("ch1")], given, [])).toBe("labelled ch1 twice");
  expect(labelsProblem([label("ch1")], given, [])).toBe("no label for ch3");
  expect(labelsProblem(swap(0, label("ch1", { kind: "post" })), given, [])).toBe("ch1: noise with kind post");
  expect(labelsProblem(swap(0, label("ch1", { label: "answer" })), given, [])).toBe("ch1: answer with kind null");
  expect(labelsProblem(swap(0, label("ch1", { reason: " " })), given, [])).toBe("ch1: reason must be 1 to 200 characters");
  expect(labelsProblem(swap(0, label("ch1", { reason: "x".repeat(201) })), given, [])).toBe("ch1: reason must be 1 to 200 characters");
  expect(labelsProblem(swap(0, label("ch1", { sameAs: "old1" })), given, [earlier])).toBe("ch1: sameAs on noise");
  const answer = { label: "answer" as const, kind: "post" as const };
  expect(labelsProblem(swap(0, label("ch1", { ...answer, sameAs: "ch1" })), given, [])).toBe("ch1: sameAs itself");
  expect(labelsProblem(swap(0, label("ch1", { ...answer, sameAs: "nope" })), given, [])).toBe("ch1: sameAs nope, not an earlier sighting from the same competitor");
  expect(labelsProblem(swap(1, label("ch3", { ...answer, sameAs: "old1" })), given, [earlier])).toBe("ch3: sameAs old1, not an earlier sighting from the same competitor");
});
