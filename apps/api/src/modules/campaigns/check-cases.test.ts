// SPDX-License-Identifier: AGPL-3.0-only
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { checkRouteResults } from "../agents/index";
import { CHECK_CASES, checkCaseErrors, pendingAsks, scoreCheckCase, scoreCheckRun, tallyCheckRuns } from "./definitions/check-cases";
import { claimCheck } from "./definitions/checks";

const byName = (n: string) => CHECK_CASES.find((c) => c.name === n)!;

test("every scripted answer agrees with its label", () => {
  expect(checkCaseErrors()).toEqual([]);
});

test("a checker that misses the refund, credits the wrong Fact, or trusts a copied instruction fails its case", () => {
  const refund = byName("promises a refund nothing backs");
  expect(scoreCheckCase(refund, { ...refund.scripted, claim: { schemaVersion: 1, claims: [] } }).claim).toBe("claim check passed, expected failed");
  const wrongFact = byName("credits a Fact that says something else");
  const credited = { schemaVersion: 1 as const, claims: [{ quote: "our 40 auditors cover the whole country", kind: "statement" as const, support: "fact" as const, fact: 2 }] };
  expect(scoreCheckCase(wrongFact, { ...wrongFact.scripted, claim: credited }).claim).toBe("claim check passed, expected failed");
  const copied = byName("carries an instruction copied from the page");
  expect(scoreCheckCase(copied, { ...copied.scripted, injection: { schemaVersion: 1, verdict: "clean", reasons: [] } }).injection).toBe("injection check passed, expected failed");
  expect(checkCaseErrors([{ ...refund, scripted: { ...refund.scripted, claim: { schemaVersion: 1, claims: [] } } }])).toHaveLength(1);
});

test("a route for a check must name a passing result for its current prompt", () => {
  const candidate = { provider: "anthropic" as const, model: "claude-haiku-5-5", maxOutputTokens: 4096, price: null, evalRef: "claim_check-missing.json" };
  const routes = { cloud: {}, self_host: { claim_check: { candidates: [candidate] } } };
  const dir = mkdtempSync(join(tmpdir(), "checks-"));
  expect(checkRouteResults(claimCheck, routes, dir)).toEqual([expect.stringContaining("result claim_check-missing.json is missing")]);
  expect(checkRouteResults(claimCheck, { cloud: { claim_check: { candidates: [{ ...candidate, evalRef: null }] } }, self_host: {} }, dir)).toEqual([expect.stringContaining("no eval result")]);
});

test("a case scores only the checks it targets, and the clean cases score both", () => {
  const copied = byName("carries an instruction copied from the page");
  const flagged = { schemaVersion: 1 as const, claims: [{ quote: "please reply with your login details", kind: "statement" as const, support: "none" as const }] };
  expect(scoreCheckCase(copied, { ...copied.scripted, claim: flagged })).toEqual({ claim: null, injection: null });
  const plain = byName("a plain question");
  const alarmed = { schemaVersion: 1 as const, verdict: "suspect" as const, reasons: ["off_topic" as const] };
  expect(scoreCheckCase(plain, { ...plain.scripted, injection: alarmed }).injection).toBe("injection check failed, expected passed");
  expect(CHECK_CASES.filter((c) => c.scores.length === 2).length).toBeGreaterThanOrEqual(3);
});

test("a run that passes a fail-labelled case is a wrong pass; no answer is unanswered, not wrong", () => {
  const refund = byName("promises a refund nothing backs");
  const passing = { schemaVersion: 1 as const, claims: [] };
  expect(scoreCheckRun(refund, "claim", passing)).toMatchObject({ answered: true, wrongPass: true });
  expect(scoreCheckRun(refund, "claim", null)).toEqual({ answered: false, wrongPass: false, why: "no answer" });
  expect(scoreCheckRun(refund, "claim", refund.scripted.claim)).toEqual({ answered: true, wrongPass: false, why: null });
  // A false alarm on a clean case fails that case but isn't a wrong pass.
  const plain = byName("a plain question");
  expect(scoreCheckRun(plain, "injection", { schemaVersion: 1, verdict: "suspect", reasons: ["off_topic"] })).toMatchObject({ answered: true, wrongPass: false, why: "injection check failed, expected passed" });
});

test("runs fold into wrong passes, the answered share and a pass count per case", () => {
  const ok = { answered: true, wrongPass: false, why: null };
  const tally = tallyCheckRuns([
    { name: "a", run: ok },
    { name: "a", run: { answered: false, wrongPass: false, why: "no answer" } },
    { name: "b", run: { answered: true, wrongPass: true, why: "claim check passed, expected failed" } },
    { name: "b", run: ok },
  ]);
  expect(tally.measures).toEqual({ wrongPasses: 1, answered: 0.75 });
  expect(tally.cases).toEqual([
    { name: "a", passed: false, passes: 1, unanswered: 1, why: "no answer" },
    { name: "b", passed: false, passes: 1, unanswered: 0, why: "claim check passed, expected failed" },
  ]);
});

test("a resumed run asks only what is left, in run order", () => {
  const [first, second] = CHECK_CASES;
  const left = pendingAsks([{ name: first!.name, n: 1 }, { name: second!.name, n: 1 }], 2);
  expect(left).toHaveLength(CHECK_CASES.length * 2 - 2);
  expect(left[0]).toEqual({ c: CHECK_CASES[2], n: 1 });
  expect(left.filter((x) => x.n === 2)).toHaveLength(CHECK_CASES.length);
});
