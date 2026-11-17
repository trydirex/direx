// SPDX-License-Identifier: AGPL-3.0-only
import { expect, test } from "vitest";
import { checksPassed, textDigest } from "./application/draft-checks";
import { judgeClaims, judgeInjection, type Claim, type CheckRecord } from "./domain/checks";

const draft = "Hi Kim, a yearly audit costs $4,500. You run 3 stores in Leeds. We refund you if it doesn't help.";
const facts = 1;
const answer = (claims: Claim[]) => ({ schemaVersion: 1 as const, claims });
const price: Claim = { quote: "a yearly audit costs $4,500", kind: "price", support: "fact", fact: 1 };
const stores: Claim = { quote: "You run 3 stores in Leeds", kind: "statement", support: "recipient_detail", detail: 1 };

test("every claim backed by a Fact or a checked quote passes", () => {
  expect(judgeClaims(answer([price, stores]), "Hi Kim, a yearly audit costs $4,500. You run 3 stores in Leeds.", facts, 1)).toEqual({ status: "passed" });
});

test("a promise or price nothing backs needs a decision; another unbacked claim only warns", () => {
  const refund: Claim = { quote: "We refund you if it doesn't help", kind: "promise", support: "none" };
  const vague: Claim = { quote: "Hi Kim", kind: "statement", support: "none" };
  expect(judgeClaims(answer([price, stores, refund, vague]), draft, facts, 1)).toEqual({
    status: "failed",
    findings: [
      { code: "unsupported_promise", quote: "We refund you if it doesn't help" },
      { code: "unsupported_claim", quote: "Hi Kim" },
    ],
  });
});

test.each([
  ["a quote that isn't in the draft", [price, stores, { quote: "Free shipping", kind: "promise", support: "none" } as Claim], 1],
  ["a Fact that isn't usable", [{ ...price, fact: 2 }, stores], 1],
  ["a Fact claim with no Fact", [{ ...price, fact: undefined }, stores], 1],
  ["a detail past the last one", [price, stores], 0],
  ["no claims for a draft with numbers", [], 1],
  ["a number left out", [stores], 1],
])("%s is malformed, never a pass", (_, claims, details) => {
  expect(judgeClaims(answer(claims as Claim[]), draft, facts, details as number)).toEqual({ status: "malformed" });
});

test("an injection answer is believed only with its reasons", () => {
  expect(judgeInjection({ schemaVersion: 1, verdict: "clean", reasons: [] })).toEqual({ status: "passed" });
  expect(judgeInjection({ schemaVersion: 1, verdict: "suspect", reasons: ["disguised_contact"] })).toEqual({ status: "failed", reasons: ["disguised_contact"] });
  expect(judgeInjection({ schemaVersion: 1, verdict: "suspect", reasons: [] })).toEqual({ status: "malformed" });
});

const passed = { status: "passed" as const, callId: "c", routeHash: "r" };
const record = (over: Partial<CheckRecord> = {}): CheckRecord => ({ schemaVersion: 1, textDigest: textDigest("Hi", draft), links: "passed", subject: "passed", claim: passed, injection: passed, ...over });

test("checks pass only when all four passed on these exact words", () => {
  expect(checksPassed(record(), "Hi", draft)).toBe(true);
  expect(checksPassed(record(), "Hi", `${draft} `)).toBe(false);
  expect(checksPassed(record(), "Hello", draft)).toBe(false);
  expect(checksPassed(null, "Hi", draft)).toBe(false);
  expect(checksPassed(record({ links: "failed" }), "Hi", draft)).toBe(false);
  expect(checksPassed(record({ subject: "failed" }), "Hi", draft)).toBe(false);
  expect(checksPassed(record({ claim: { ...passed, status: "unavailable" } }), "Hi", draft)).toBe(false);
  expect(checksPassed(record({ injection: { ...passed, status: "failed" } }), "Hi", draft)).toBe(false);
});

test("a source sent as null counts as not given, so a detail claim with fact null still passes", () => {
  const withNull: Claim = { ...stores, fact: null };
  expect(judgeClaims(answer([price, withNull]), "Hi Kim, a yearly audit costs $4,500. You run 3 stores in Leeds.", facts, 1)).toEqual({ status: "passed" });
  expect(judgeClaims(answer([{ ...price, fact: null }, stores]), "Hi Kim, a yearly audit costs $4,500. You run 3 stores in Leeds.", facts, 1)).toEqual({ status: "malformed" });
});
