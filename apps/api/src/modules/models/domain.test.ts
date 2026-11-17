// SPDX-License-Identifier: AGPL-3.0-only
import { expect, test } from "vitest";
import {
  budgetChangeAllowed,
  budgetDecision,
  DEFAULT_BUDGET_MICROS,
  SAFETY_DAILY_CALLS,
  safetyAllowed,
  thresholdsCrossed,
  withinRunCap,
} from "./domain/budget";
import { actualMicros, estimateInputTokens, type Price, worstCaseMicros } from "./domain/cost";
import { type Candidate, checkRoutes, isPinned } from "./domain/routes-check";
import { callTrust, kindTrust, toolsFor } from "./domain/trust";
import { RATE_CARDS } from "./domain/rates/cards";
import { routesFor } from "./purposes";

const read = { class: "read" as const, name: "lookup" };
const effect = { class: "effect" as const, name: "send" };

test("any kind not listed is untrusted", () => {
  for (const k of ["definition", "skill", "workspace_fact", "ask_user_text", "draft", "agent_lesson"]) expect(kindTrust(k)).toBe("trusted");
  for (const k of ["inbound_message", "web_page", "plugin_result", "mcp_result", "upload", "crm_record", "untrusted_draft", "untrusted_model_output", "new_kind"])
    expect(kindTrust(k)).toBe("untrusted");
});

test("one untrusted part or a tainted run makes the call untrusted", () => {
  expect(callTrust(["definition", "draft"], false)).toBe("trusted");
  expect(callTrust(["definition", "inbound_message"], false)).toBe("untrusted");
  expect(callTrust(["definition"], true)).toBe("untrusted");
});

test("an untrusted call refuses an effect tool and keeps read tools", () => {
  expect(toolsFor("untrusted", [read, effect])).toBe("effect_tool_on_untrusted");
  expect(toolsFor("untrusted", [read])).toEqual([read]);
  expect(toolsFor("trusted", [read, effect])).toEqual([read, effect]);
});

const price: Price = {
  input: 3_000_000n,
  output: 15_000_000n,
  cacheRead: 300_000n,
  cacheWrite: 3_750_000n,
  longContext: { aboveInputTokens: 200_000, input: 6_000_000n, output: 22_500_000n, cacheRead: 600_000n, cacheWrite: 7_500_000n },
};

test("the worst case prices input at the cache-write rate, plus all output", () => {
  expect(estimateInputTokens(101)).toBe(51);
  // 1,000 tokens at $3.75 per million, 100 at $15: 3,750 + 1,500 micro-dollars.
  expect(worstCaseMicros(2_000, 100, price)).toBe(5_250n);
});

test("the worst case uses the long-context tier the input lands in", () => {
  // 200,001 tokens is past the tier: $7.50 per million for input, no output.
  expect(worstCaseMicros(400_002, 0, price)).toBe(1_500_008n);
});

test("real usage never beats the reservation when the estimate holds, even at the dearest tier", () => {
  const tokens = 250_000;
  const reserved = worstCaseMicros(tokens * 2, 4_000, price);
  for (const split of [
    { noCacheTokens: tokens, cacheReadTokens: 0, cacheWriteTokens: 0 },
    { noCacheTokens: 0, cacheReadTokens: tokens, cacheWriteTokens: 0 },
    { noCacheTokens: 0, cacheReadTokens: 0, cacheWriteTokens: tokens },
  ]) {
    expect(actualMicros({ ...split, outputTokens: 4_000 }, price)).toBeLessThanOrEqual(reserved);
  }
});

test("actual cost rounds up and charges each token kind at its own rate", () => {
  expect(actualMicros({ noCacheTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 0 }, { input: 1n, output: 0n, cacheRead: 0n, cacheWrite: 0n })).toBe(1n);
  expect(actualMicros({ noCacheTokens: 1_000, cacheReadTokens: 1_000, cacheWriteTokens: 1_000, outputTokens: 1_000 }, price)).toBe(3_000n + 300n + 3_750n + 15_000n);
});

const limit = { budgetMicros: 100n, reservationMicros: 10n, stepDownMicros: 1n };

test("cloud: normal up to the budget, step down past it, stop past twice the budget", () => {
  const d = (spentMicros: bigint, stepDownMicros: bigint | null = 1n) =>
    budgetDecision({ ...limit, deployment: "cloud", spentMicros, stepDownMicros });
  expect(d(90n)).toBe("normal");
  expect(d(91n)).toBe("step_down");
  expect(d(199n)).toBe("step_down");
  expect(d(200n)).toBe("budget_stop");
  expect(d(91n, null)).toBe("budget_stop");
});

test("self-host stops at the budget, with or without a cheaper route", () => {
  const d = (spentMicros: bigint) => budgetDecision({ ...limit, deployment: "self_host", spentMicros });
  expect(d(90n)).toBe("normal");
  expect(d(91n)).toBe("budget_stop");
});

test("safety calls have their own daily limit", () => {
  expect(safetyAllowed(SAFETY_DAILY_CALLS - 1)).toBe(true);
  expect(safetyAllowed(SAFETY_DAILY_CALLS)).toBe(false);
});

test("the run cap counts what the run already spent or holds", () => {
  expect(withinRunCap({ capMicros: 100n, spentOnRunMicros: 90n, reservationMicros: 10n })).toBe(true);
  expect(withinRunCap({ capMicros: 100n, spentOnRunMicros: 91n, reservationMicros: 10n })).toBe(false);
});

test("a threshold is crossed once, and one step can cross both", () => {
  expect(thresholdsCrossed(79n, 80n, 100n)).toEqual([80]);
  expect(thresholdsCrossed(80n, 90n, 100n)).toEqual([]);
  expect(thresholdsCrossed(99n, 100n, 100n)).toEqual([100]);
  expect(thresholdsCrossed(10n, 150n, 100n)).toEqual([80, 100]);
  expect(thresholdsCrossed(100n, 150n, 100n)).toEqual([]);
});

test("cloud may only lower the budget; self-host takes any finite positive value", () => {
  expect(budgetChangeAllowed("cloud", DEFAULT_BUDGET_MICROS.cloud)).toBe(true);
  expect(budgetChangeAllowed("cloud", DEFAULT_BUDGET_MICROS.cloud + 1n)).toBe(false);
  expect(budgetChangeAllowed("self_host", DEFAULT_BUDGET_MICROS.cloud * 100n)).toBe(true);
  expect(budgetChangeAllowed("self_host", 0n)).toBe(false);
});

const good: Candidate = { provider: "anthropic", model: "model-20260101", maxOutputTokens: 100, price, evalRef: "evals/x" };
const reasons = (deployment: "cloud" | "self_host", purpose: string, route: Parameters<typeof checkRoutes>[1][string]) =>
  checkRoutes(deployment, { [purpose]: route }).map((i) => i.reason);

test("an id is pinned by a date in it or a documented source", () => {
  expect(isPinned({ model: "model-20260101" })).toBe(true);
  expect(isPinned({ model: "model-2026-01-01" })).toBe(true);
  expect(isPinned({ model: "model-latest" })).toBe(false);
  expect(isPinned({ model: "model-5-5" })).toBe(false);
  expect(isPinned({ model: "model-5-5", pinSource: "https://example.test/ids" })).toBe(true);
});

test("good routes pass on both deployments", () => {
  expect(reasons("cloud", "draft.email", { candidates: [good], stepDown: [good] })).toEqual([]);
  expect(reasons("self_host", "draft.email", { candidates: [good] })).toEqual([]);
});

test("cloud refuses each thing the contract and the eval gate forbid, naming it", () => {
  expect(reasons("cloud", "p", { candidates: [] })).toEqual(["no_candidates"]);
  expect(reasons("cloud", "p", { candidates: [{ ...good, provider: "openrouter" }] })).toEqual(["uncontracted_provider"]);
  expect(reasons("cloud", "p", { candidates: [{ ...good, model: "model-latest" }] })).toEqual(["unpinned"]);
  expect(reasons("cloud", "p", { candidates: [{ ...good, price: null }] })).toEqual(["no_price"]);
  expect(reasons("cloud", "p", { candidates: [{ ...good, evalRef: null }] })).toEqual(["no_eval"]);
  expect(reasons("cloud", "p", { candidates: [good], stepDown: [{ ...good, provider: "openrouter" }] })).toEqual(["uncontracted_provider"]);
  expect(reasons("cloud", "p", { candidates: [good], stepDown: [{ ...good, evalRef: null }] })).toEqual(["step_down_no_eval"]);
});

test("connection_test needs no eval on cloud, but the rest of the contract holds", () => {
  expect(reasons("cloud", "connection_test", { candidates: [{ ...good, evalRef: null }] })).toEqual([]);
  expect(reasons("cloud", "connection_test", { candidates: [{ ...good, evalRef: null, model: "model-latest" }] })).toEqual(["unpinned"]);
});

test("self-host allows aliases, OpenRouter and unpriced models, except for safety purposes", () => {
  const loose: Candidate = { provider: "openrouter", model: "vendor/model", maxOutputTokens: 100, price: null, evalRef: null };
  expect(reasons("self_host", "draft.email", { candidates: [loose] })).toEqual([]);
  expect(reasons("self_host", "optout_detect", { candidates: [loose] })).toEqual(["safety_unpinned", "safety_no_eval"]);
});

test("the shipped routes boot on both deployments", () => {
  expect(checkRoutes("cloud", routesFor("cloud"))).toEqual([]);
  expect(checkRoutes("self_host", routesFor("self_host"))).toEqual([]);
});

test("every rate card names where its price was read and when", () => {
  for (const card of Object.values(RATE_CARDS)) {
    expect(card.source).toMatch(/^https:\/\//);
    expect(card.readOn).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  }
});

test("every priced candidate's price comes from a card; only OpenRouter is unpriced", () => {
  const cards = Object.values(RATE_CARDS).map((c) => c.price);
  for (const c of routesFor("self_host").connection_test!.candidates) {
    if (c.provider === "openrouter") expect(c.price).toBeNull();
    else expect(cards).toContain(c.price);
  }
});

test("a safety purpose may not have a step-down on either deployment", () => {
  for (const d of ["cloud", "self_host"] as const) expect(reasons(d, "claim_check", { candidates: [good], stepDown: [good] })).toEqual(["safety_step_down"]);
});
