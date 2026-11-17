// SPDX-License-Identifier: AGPL-3.0-only
// The one-click rewrites a person can ask for on an email waiting for approval, as the words the
// writer gets. A person's own words go to the writer as they typed them.

export const REWRITE_PRESETS = {
  shorter: "Make it about half as long: cut whole sentences that add nothing, rather than joining or trimming them. Keep the facts, the links and what you ask them to do.",
  longer: "Make it a little longer, with one more concrete detail from the brief or the quotes. Add no new claims.",
  casual: "Make it more casual and warmer, like a note from one person to another. Keep the facts and links.",
  formal: "Make it more formal and polished. Keep the facts and links.",
  again: "Write a different version with the same aim and the same facts.",
} as const;

export type RewritePreset = keyof typeof REWRITE_PRESETS;

/** "Not like this": why a person turned an email down, as the words the writer gets. Each one is recorded against its step. */
export const REJECT_REASONS = {
  salesy: "It's too salesy. Make it lower-key, with no hard sell or hype.",
  long: "It's too long. Cut it to what matters.",
  facts: "Some of what it says is wrong.",
  voice: "It doesn't sound like us. Follow the Tone on Brand more closely.",
  audience: "It's written for the wrong reader. Write it for who buys from us.",
} as const;

export type RejectReason = keyof typeof REJECT_REASONS;

/**
 * The instruction for a preset, or for a reason with the person's optional words after it, or the person's own
 * words alone. A preset never goes with a reason or words.
 */
export function rewriteInstruction(a: { preset?: RewritePreset; reason?: RejectReason; instruction?: string }): string | null {
  const own = a.instruction?.trim();
  if (a.preset) return a.reason || own ? null : REWRITE_PRESETS[a.preset];
  if (a.reason) return own ? `${REJECT_REASONS[a.reason]} ${own}` : REJECT_REASONS[a.reason];
  return own || null;
}
