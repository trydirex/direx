// SPDX-License-Identifier: AGPL-3.0-only
// Purposes and their candidates, as data. Callers name a purpose and never a model.
import type { Deployment } from "./domain/budget";
import { RATE_CARDS } from "./domain/rates/cards";
import { CONNECTION_TEST, type Candidate, type Route } from "./domain/routes-check";

const TEST_MAX_OUTPUT_TOKENS = 16;
const EXTRACT_MAX_OUTPUT_TOKENS = 4096;
const PLAN_MAX_OUTPUT_TOKENS = 8192;
const BRAND_EXTRACT = "brand_extract";
const RECIPIENT_READ = "recipient_read";
const PLAN_DRAFT = "plan_draft";
const CAMPAIGN_DRAFT = "campaign_draft";
const SEO_BRIEF = "seo_brief";
const CLIP_PICK = "clip_pick";
const ASK = "ask";
const ANTHROPIC_PIN_SOURCE = "https://platform.claude.com/docs/en/about-claude/models/overview";

const HAIKU: Candidate = {
  provider: "anthropic",
  model: "claude-haiku-5-5",
  maxOutputTokens: TEST_MAX_OUTPUT_TOKENS,
  price: RATE_CARDS["claude-haiku-5-5"].price,
  evalRef: null,
  pinSource: ANTHROPIC_PIN_SOURCE,
};

/**
 * The draft checks' candidates, each listed in a route only once its own real-key eval is recorded
 * (`bun run eval --purpose claim_check --provider ...`), since a safety route won't boot without one.
 * Self-host tries the subscription first, then an API key; cloud has only Direx's key.
 */
export const CHECK_CANDIDATES = {
  claude_code: { provider: "claude_code", model: "claude-haiku-5-5", maxOutputTokens: EXTRACT_MAX_OUTPUT_TOKENS, price: null, evalRef: null, pinSource: ANTHROPIC_PIN_SOURCE },
  anthropic: { ...HAIKU, maxOutputTokens: EXTRACT_MAX_OUTPUT_TOKENS },
} as const satisfies Record<string, Candidate>;
/** The claim check runs on Sonnet: on Haiku it answered too few runs to meet its bar. */
export const CLAIM_CHECK_MODEL = { claude_code: "claude-sonnet-5-5" } as const;

/**
 * Cloud keeps to models whose provider documents them as pinned, which today is Anthropic alone.
 * It has no brand_extract, plan_draft or campaign_draft route until a real-key eval is recorded, since it refuses to boot on one
 * without; a run there is refused with no_route.
 */
export function routesFor(deployment: Deployment): Record<string, Route> {
  if (deployment === "cloud") return { [CONNECTION_TEST]: { candidates: [HAIKU] } };
  return {
    [PLAN_DRAFT]: {
      candidates: [
        { ...HAIKU, maxOutputTokens: PLAN_MAX_OUTPUT_TOKENS },
        { provider: "openai", model: "gpt-6-luna", maxOutputTokens: PLAN_MAX_OUTPUT_TOKENS, price: RATE_CARDS["gpt-6-luna"].price, evalRef: null },
        { provider: "google", model: "gemini-3.1-flash-lite", maxOutputTokens: PLAN_MAX_OUTPUT_TOKENS, price: RATE_CARDS["gemini-3.1-flash-lite"].price, evalRef: null },
      ],
    },
    [CAMPAIGN_DRAFT]: {
      candidates: [
        { ...HAIKU, maxOutputTokens: PLAN_MAX_OUTPUT_TOKENS },
        { provider: "openai", model: "gpt-6-luna", maxOutputTokens: PLAN_MAX_OUTPUT_TOKENS, price: RATE_CARDS["gpt-6-luna"].price, evalRef: null },
        { provider: "google", model: "gemini-3.1-flash-lite", maxOutputTokens: PLAN_MAX_OUTPUT_TOKENS, price: RATE_CARDS["gemini-3.1-flash-lite"].price, evalRef: null },
      ],
    },
    [BRAND_EXTRACT]: {
      candidates: [
        { ...HAIKU, maxOutputTokens: EXTRACT_MAX_OUTPUT_TOKENS },
        { provider: "openai", model: "gpt-6-luna", maxOutputTokens: EXTRACT_MAX_OUTPUT_TOKENS, price: RATE_CARDS["gpt-6-luna"].price, evalRef: null },
        { provider: "google", model: "gemini-3.1-flash-lite", maxOutputTokens: EXTRACT_MAX_OUTPUT_TOKENS, price: RATE_CARDS["gemini-3.1-flash-lite"].price, evalRef: null },
      ],
    },
    // Quoting a page is extraction too, so it starts on the same cheap candidates as Brand.
    [RECIPIENT_READ]: {
      candidates: [
        { ...HAIKU, maxOutputTokens: EXTRACT_MAX_OUTPUT_TOKENS },
        { provider: "openai", model: "gpt-6-luna", maxOutputTokens: EXTRACT_MAX_OUTPUT_TOKENS, price: RATE_CARDS["gpt-6-luna"].price, evalRef: null },
        { provider: "google", model: "gemini-3.1-flash-lite", maxOutputTokens: EXTRACT_MAX_OUTPUT_TOKENS, price: RATE_CARDS["gemini-3.1-flash-lite"].price, evalRef: null },
      ],
    },
    // A Brief quotes one page, as a recipient read does, and Direx checks every quote before a person sees it.
    // Passed every case of the page-brief skill on the subscription, 2026-11-06.
    [SEO_BRIEF]: {
      candidates: [
        { ...CHECK_CANDIDATES.claude_code, evalRef: "seo_brief-v1-claude_code-claude-haiku-5-5.json" },
        { ...HAIKU, maxOutputTokens: EXTRACT_MAX_OUTPUT_TOKENS },
        { provider: "openai", model: "gpt-6-luna", maxOutputTokens: EXTRACT_MAX_OUTPUT_TOKENS, price: RATE_CARDS["gpt-6-luna"].price, evalRef: null },
      ],
    },
    // Picking moments reads a transcript and cites Facts, which code checks before anything is cut. The
    // subscription comes first, as for a Brief. Passed every case of its eval on the subscription, 2026-11-07.
    [CLIP_PICK]: {
      candidates: [
        { ...CHECK_CANDIDATES.claude_code, maxOutputTokens: PLAN_MAX_OUTPUT_TOKENS, evalRef: "clip_picker-v1-claude_code-claude-haiku-5-5.json" },
        { ...HAIKU, maxOutputTokens: PLAN_MAX_OUTPUT_TOKENS },
      ],
    },
    // Ask answers from the Workspace's own records and only proposes; the subscription comes first, as for a Brief.
    // On Sonnet: on Haiku it slipped in a few runs of every 50, a new way each time (2026-11-10).
    // Passed every case of its eval on the subscription on Sonnet, 5 runs, 2026-11-10.
    [ASK]: {
      candidates: [
        { ...CHECK_CANDIDATES.claude_code, model: "claude-sonnet-5-5", maxOutputTokens: EXTRACT_MAX_OUTPUT_TOKENS, evalRef: "ask-v3-claude_code-claude-sonnet-5-5.json" },
        { ...HAIKU, maxOutputTokens: EXTRACT_MAX_OUTPUT_TOKENS },
      ],
    },
    // The change classifier labels a Workspace's competitor Changes and only labels. Passed CHANGE_BAR on
    // the subscription on Sonnet, 5 runs, 2026-11-12; Haiku missed it, so there is no step-down.
    competitor_change: { candidates: [{ ...CHECK_CANDIDATES.claude_code, model: "claude-sonnet-5-5", maxOutputTokens: EXTRACT_MAX_OUTPUT_TOKENS, evalRef: "change_classifier-v1-claude_code-claude-sonnet-5-5.json" }] },
    // The comparison-page Brief drafts edits a person copies out; Direx checks every quote and number first.
    // On Sonnet: against the live comparison pages, Haiku copied numbers from the page into its edits in 3 runs of 45.
    // Passed COMPARISON_BAR on the subscription on Sonnet, 5 runs (45 of 45), 2026-11-13.
    competitor_brief: { candidates: [{ ...CHECK_CANDIDATES.claude_code, model: "claude-sonnet-5-5", maxOutputTokens: EXTRACT_MAX_OUTPUT_TOKENS, evalRef: "comparison_brief-v1-claude_code-claude-sonnet-5-5.json" }] },
    // The counter-post drafts one post a person copies out; Direx checks its quotes, numbers, links and Facts first.
    // Passed POST_BAR on the subscription on Haiku, 5 runs (39 of 40), 2026-11-13.
    competitor_post: { candidates: [{ ...CHECK_CANDIDATES.claude_code, maxOutputTokens: EXTRACT_MAX_OUTPUT_TOKENS, evalRef: "counter_post-v1-claude_code-claude-haiku-5-5.json" }] },
    // The draft checks passed every labelled case on the subscription, 2026-11-02. Safety purposes: no step-down, no override.
    injection_check: { candidates: [{ ...CHECK_CANDIDATES.claude_code, evalRef: "injection_check-v1-claude_code-claude-haiku-5-5.json" }] },
    // The lesson check passed every labelled sentence on the subscription, 2026-11-07. Same safety terms.
    lesson_check: { candidates: [{ ...CHECK_CANDIDATES.claude_code, evalRef: "lesson_check-v1-claude_code-claude-haiku-5-5.json" }] },
    optout_detect: { candidates: [{ ...CHECK_CANDIDATES.claude_code, evalRef: "optout_detect-v1-claude_code-claude-haiku-5-5.json" }] },
    // The reply desk's label passed REPLY_LABEL_BAR on its synthetic set on the subscription, 3 runs, 2026-11-18.
    // It only orders the queue and picks the alert; a failure leaves the reply unlabelled, never unseen.
    reply_label: { candidates: [{ ...CHECK_CANDIDATES.claude_code, evalRef: "reply_label-v2-claude_code-claude-haiku-5-5.json" }] },
    // The Voice check (ADR 0022) passed its eval on the subscription, 5 runs, 2026-11-13. Same safety terms.
    voice_check: { candidates: [{ ...CHECK_CANDIDATES.claude_code, evalRef: "voice_check-v1-claude_code-claude-haiku-5-5.json" }] },
    // The sentence behind each number on Home. Passed WHY_BAR on the subscription on Haiku, 5 runs, 2026-11-12.
    result_why: { candidates: [{ ...CHECK_CANDIDATES.claude_code, evalRef: "result_why-v1-claude_code-claude-haiku-5-5.json" }] },
    claim_check: { candidates: [{ ...CHECK_CANDIDATES.claude_code, model: CLAIM_CHECK_MODEL.claude_code, evalRef: "claim_check-v4-claude_code-claude-sonnet-5-5.json" }] },
    [CONNECTION_TEST]: {
      candidates: [
        HAIKU,
        { provider: "openai", model: "gpt-6-luna", maxOutputTokens: TEST_MAX_OUTPUT_TOKENS, price: RATE_CARDS["gpt-6-luna"].price, evalRef: null },
        { provider: "google", model: "gemini-3.1-flash-lite", maxOutputTokens: TEST_MAX_OUTPUT_TOKENS, price: RATE_CARDS["gemini-3.1-flash-lite"].price, evalRef: null },
        { provider: "openrouter", model: "anthropic/claude-haiku-5-5", maxOutputTokens: TEST_MAX_OUTPUT_TOKENS, price: null, evalRef: null },
      ],
    },
  };
}
