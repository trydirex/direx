// SPDX-License-Identifier: AGPL-3.0-only
import { expect, test } from "vitest";
import { norm } from "../seo/index";
import { postInput, postProblems, type CounterPost } from "./domain/post";

const FACT = "7c1e4b20-3a5d-4f6e-8b9c-0d1e2f3a4b00";
const seen = {
  theirs: ["GL Rec, All Clients: every account from every client on one page", "Autoclose is a $1,500/month add-on"],
  ours: new Map([[FACT, { version: 2, text: "Contoso costs a flat $15 per QuickBooks company per month. See https://contoso.example/pricing" }]]),
};
const post = (o: Partial<CounterPost> = {}): CounterPost => ({ text: "Xenett now shows every client on one page. Contoso has done that from $15 a company.", theirs: ["every client on one page"], citations: [{ factId: FACT, version: 2 }], cantTell: null, steered: [], ...o });
const problems = (o: Partial<CounterPost> = {}) => postProblems(post(o), seen, norm);

test("a post quoting their words and citing a known Fact for its number passes", () => {
  expect(problems()).toEqual([]);
  expect(problems({ text: "Autoclose costs $1500 a month.", theirs: ["Autoclose is a $1,500/month add-on"], citations: [] })).toEqual([]);
});

test("each refusal names what failed", () => {
  expect(problems({ text: "x".repeat(281) })).toEqual(["post is 281 characters, more than 280"]);
  expect(problems({ theirs: [] })).toEqual(["no words of theirs cited"]);
  expect(problems({ theirs: ["every client, instantly"] })).toEqual(['not their words: "every client, instantly"']);
  expect(problems({ citations: [{ factId: FACT, version: 1 }] })[0]).toMatch(/^unknown Fact .* version 1$/);
  expect(problems({ text: "From $12 a company." })).toEqual(['"$12" is not in what the post cites']);
  expect(problems({ text: "See https://evil.example now." })).toEqual(["link not given by a cited Fact: https://evil.example"]);
  expect(problems({ text: "Pricing: https://contoso.example/pricing" })).toEqual([]);
});

test("no post needs a reason", () => {
  expect(problems({ text: "", theirs: [], citations: [], cantTell: "A minor fix nobody asked about." })).toEqual([]);
  expect(problems({ text: " ", cantTell: null })).toEqual(["no post and no reason"]);
});

test("the input names the competitor, what's on file and each line with its read date", () => {
  expect(postInput("Xenett", null, [{ source: "changelog", readAt: "2026-11-09T07:00:00.000Z", lines: ["GL Rec"] }])).toBe(
    ["Competitor: Xenett", "On file about Xenett: nothing", "", "Changed lines:", "- changelog page, read 9 Nov 2026:", '  "GL Rec"'].join("\n"),
  );
});
