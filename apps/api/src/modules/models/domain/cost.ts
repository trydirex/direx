// SPDX-License-Identifier: AGPL-3.0-only
// Pure: what a call may cost at worst, and what it did cost. Amounts are integer
// micro-dollars; prices are integer micro-dollars per million tokens.

export type Rates = { input: bigint; output: bigint; cacheRead: bigint; cacheWrite: bigint };
/** `longContext` replaces the rates once a call's input passes `aboveInputTokens`. */
export type Price = Rates & { longContext?: { aboveInputTokens: number } & Rates };

export type Usage = { noCacheTokens: number; cacheReadTokens: number; cacheWriteTokens: number; outputTokens: number };

const PER_MILLION = 1_000_000n;

const ceilDiv = (a: bigint, b: bigint) => (a + b - 1n) / b;
const larger = (a: bigint, b: bigint) => (a > b ? a : b);

/** ponytail: bytes over 2 can undercount; flagged calls tune the divisor. A tokenizer per provider is the upgrade. */
export const estimateInputTokens = (inputBytes: number): number => Math.ceil(inputBytes / 2);

const ratesAt = (p: Price, inputTokens: number): Rates =>
  p.longContext && inputTokens > p.longContext.aboveInputTokens ? p.longContext : p;

/** Every input token at the dearer of input and cache write, plus all output, which includes reasoning. */
export function worstCaseMicros(inputBytes: number, maxOutputTokens: number, price: Price): bigint {
  const tokens = estimateInputTokens(inputBytes);
  const r = ratesAt(price, tokens);
  return ceilDiv(BigInt(tokens) * larger(r.input, r.cacheWrite) + BigInt(maxOutputTokens) * r.output, PER_MILLION);
}

export function actualMicros(u: Usage, price: Price): bigint {
  const r = ratesAt(price, u.noCacheTokens + u.cacheReadTokens + u.cacheWriteTokens);
  return ceilDiv(
    BigInt(u.noCacheTokens) * r.input +
      BigInt(u.cacheReadTokens) * r.cacheRead +
      BigInt(u.cacheWriteTokens) * r.cacheWrite +
      BigInt(u.outputTokens) * r.output,
    PER_MILLION,
  );
}
