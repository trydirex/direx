// SPDX-License-Identifier: AGPL-3.0-only
import { expect, test } from "vitest";
import { compareToSkeleton, editDistance, editPhrases, skeletonOf, spansAgainst } from "./domain/skeleton";
import { SKELETON_TEMPLATE, skeletonDrift, tallyDrift } from "./evals";

const sam = { firstName: "Sam", company: "Leeds Bakes" };
const kept = "Hi Sam,\n\nWe do the bookkeeping for small shops, so every filing goes in on time and nothing waits on you.\n\nWould a short call next week help?";

test("a draft that keeps the skeleton and adds one sentence is within the bar", () => {
  const draft = kept.replace("Hi Sam,", "Hi Sam,\n\nI saw Leeds Bakes opened a second shop.");
  const d = skeletonDrift(SKELETON_TEMPLATE.text, sam, draft);
  expect(d.kept).toBe(1);
  expect(d.addedSentences).toBe(1);
  expect(tallyDrift([{ drafted: true, ...d }]).passed).toBe(true);
});

test("a rewritten draft keeps little of the skeleton and fails the bar", () => {
  const d = skeletonDrift(SKELETON_TEMPLATE.text, sam, "Hello Sam. Your sourdough is great. Bakeries need books. We can help. Call me?");
  expect(d.kept).toBeLessThan(0.3);
  expect(tallyDrift([{ drafted: true, ...d }, { drafted: false, kept: 0, addedSentences: 0 }]).passed).toBe(false);
});

test("a skeleton keeps the recipient's fields, fills the sender and drops the step's link line", () => {
  const template = { schemaVersion: 1, subject: "{{company}} and audits", text: "Hi {{firstName}},\nWe audit firms.\n{{steps.page.url}}\n{{senderName}}", citations: [] };
  expect(skeletonOf(template, "Dominik")).toEqual({ subject: "{{company}} and audits", text: "Hi {{firstName}},\nWe audit firms.\nDominik" });
});

test("spans compare a draft with the step's email filled in for that Person", () => {
  const template = { subject: "s", text: "Hi {{firstName}}, we audit {{company}}.\n{{steps.page.url}}" };
  expect(spansAgainst(template, { firstName: "Kim", company: "Acme" }, { page: "https://x.test/p" }, "Hi Kim, we audit Acme. You bake.\nhttps://x.test/p")).toEqual([
    { text: "Hi Kim, we audit Acme. ", kind: "same" },
    { text: "You bake.\n", kind: "added" },
    { text: "https://x.test/p", kind: "same" },
  ]);
  // A Person without a first name can't be compared, rather than compared against a half-filled email.
  expect(spansAgainst(template, { company: "Acme" }, { page: "https://x.test/p" }, "Hi, we audit Acme.")).toBeNull();
  expect(spansAgainst(null, {}, {}, "Hi")).toBeNull();
});

test("no template, or one without text, is no skeleton", () => {
  expect(skeletonOf(null, "Dominik")).toBeNull();
  expect(skeletonOf({ subject: "s", text: "{{steps.page.url}}" }, "Dominik")).toBeNull();
});

const skeleton = "Hi Ana, we audit small firms. A yearly audit costs $4,500. Worth a call?";
const added = (draft: string) =>
  compareToSkeleton(skeleton, draft)
    .filter((s) => s.kind === "added")
    .map((s) => s.text.trim());

test("a draft identical to the skeleton is one dimmed span", () => {
  expect(compareToSkeleton(skeleton, skeleton)).toEqual([{ text: skeleton, kind: "same" }]);
});

test("spans put the draft back together exactly", () => {
  const draft = "Hi Ana,  we saw your hiring post.\nWe audit small firms. Worth a call?";
  expect(
    compareToSkeleton(skeleton, draft)
      .map((s) => s.text)
      .join(""),
  ).toBe(draft);
});

test("an inserted sentence is highlighted and the rest is dimmed", () => {
  const draft = "Hi Ana, I saw you are hiring two accountants. We audit small firms. A yearly audit costs $4,500. Worth a call?";
  expect(added(draft)).toEqual(["I saw you are hiring two accountants. We"]);
});

test("one changed word inside a sentence that looks generic is highlighted", () => {
  const draft = "Hi Ana, we audit small firms. A yearly audit costs $450. Worth a call?";
  expect(added(draft)).toEqual(["$450."]);
});

test("a moved sentence is highlighted, never hidden", () => {
  const draft = "Worth a call? Hi Ana, we audit small firms. A yearly audit costs $4,500.";
  expect(added(draft).join(" ")).toContain("Worth a call?");
});

test("an empty skeleton highlights the whole draft", () => {
  expect(compareToSkeleton("", "Anything at all")).toEqual([{ text: "Anything at all", kind: "added" }]);
});

test("edit phrases ignore case and punctuation and drop single words", () => {
  expect(editPhrases("We help you GROW revenue, fast. Thanks", "We help you. Thanks a lot")).toEqual({
    removed: ["grow revenue fast"],
    added: ["a lot"],
  });
});

test("the same edit on two drafts gives the same phrases", () => {
  const one = editPhrases("Hi Ana, I hope this finds you well. We audit firms.", "Hi Ana, we audit firms.");
  const two = editPhrases("Hi Bo, I hope this finds you well! We audit firms.", "Hi Bo, we audit firms.");
  expect(one.removed).toEqual(["i hope this finds you well"]);
  expect(two.removed).toEqual(one.removed);
});

test("edit distance counts words removed plus words added", () => {
  expect(editDistance("a b c", "a b c")).toBe(0);
  expect(editDistance("a b c", "a x c")).toBe(2);
  expect(editDistance("", "a b")).toBe(2);
});
