// SPDX-License-Identifier: AGPL-3.0-only
// What providers charge, copied from their own pages. Standard tier, integer micro-dollars
// per million tokens. These give estimates, never invoices.
import type { Price } from "../cost";

export type RateCard = { source: string; readOn: string; price: Price };

const ANTHROPIC = "https://platform.claude.com/docs/en/about-claude/pricing";
const OPENAI = "https://developers.openai.com/api/docs/pricing";
const GOOGLE = "https://ai.google.dev/gemini-api/docs/pricing";
const READ_ON = "2026-10-30";

export const RATE_CARDS = {
  // Cache write is the 5-minute rate, the default when a call sets no longer lifetime.
  "claude-haiku-5-5": {
    source: ANTHROPIC,
    readOn: READ_ON,
    price: {
      input: 100_000n,
      output: 500_000n,
      cacheRead: 10_000n,
      cacheWrite: 125_000n,
      longContext: { aboveInputTokens: 100_000, input: 500_000n, output: 2_500_000n, cacheRead: 50_000n, cacheWrite: 625_000n },
    },
  },
  // Cache write is the page's "30m write" column.
  "gpt-6-luna": {
    source: OPENAI,
    readOn: READ_ON,
    price: {
      input: 100_000n,
      output: 500_000n,
      cacheRead: 10_000n,
      cacheWrite: 125_000n,
      longContext: { aboveInputTokens: 272_000, input: 200_000n, output: 750_000n, cacheRead: 20_000n, cacheWrite: 250_000n },
    },
  },
  // ponytail: the page lists no cache-write rate, only hourly storage, so this is the input rate and storage is not counted. Fine while no call uses Google's context cache.
  "gemini-3.1-flash-lite": {
    source: GOOGLE,
    readOn: READ_ON,
    price: { input: 250_000n, output: 1_500_000n, cacheRead: 25_000n, cacheWrite: 250_000n },
  },
} as const satisfies Record<string, RateCard>;
