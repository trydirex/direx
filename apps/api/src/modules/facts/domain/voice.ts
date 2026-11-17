// SPDX-License-Identifier: AGPL-3.0-only
// Pure: what a Voice entry may hold (ADR 0022). An example is a passage that sounds like the
// Workspace; a swap is a word to avoid and the word to use instead. Neither is ever a source for
// what a draft claims.

export const MAX_EXAMPLES = 5;
export const MAX_EXAMPLE_CHARS = 600;
export const MAX_SWAPS = 30;
export const MAX_SWAP_CHARS = 40;

export type VoiceRefusal =
  | "voice_empty"
  | "voice_too_long"
  | "voice_has_email"
  | "voice_has_phone"
  | "voice_examples_full"
  | "voice_swaps_full"
  | "voice_swap_same"
  | "voice_swap_exists";

const tidy = (s: string) => s.replace(/\s+/g, " ").trim();
const EMAIL = /[^\s@<>()]+@[^\s@<>()]+\.[a-z]{2,}/i;
// Seven or more digits, allowing the spaces, dots, dashes and brackets phone numbers are written with.
const PHONE = /(?:\+?\d[\s().-]*){7,}/;

/** An example's words as stored, or why they can't be. A pasted passage keeps its line breaks. */
export function exampleText(raw: string): { ok: true; text: string } | { ok: false; reason: VoiceRefusal } {
  const text = raw.trim();
  if (!text) return { ok: false, reason: "voice_empty" };
  if (text.length > MAX_EXAMPLE_CHARS) return { ok: false, reason: "voice_too_long" };
  if (EMAIL.test(text)) return { ok: false, reason: "voice_has_email" };
  if (PHONE.test(text)) return { ok: false, reason: "voice_has_phone" };
  return { ok: true, text };
}

/** A swap's two words as stored, or why they can't be. */
export function swapWords(avoid: string, prefer: string): { ok: true; avoid: string; prefer: string } | { ok: false; reason: VoiceRefusal } {
  const a = tidy(avoid);
  const p = tidy(prefer);
  if (!a || !p) return { ok: false, reason: "voice_empty" };
  if (a.length > MAX_SWAP_CHARS || p.length > MAX_SWAP_CHARS) return { ok: false, reason: "voice_too_long" };
  if (a.toLowerCase() === p.toLowerCase()) return { ok: false, reason: "voice_swap_same" };
  return { ok: true, avoid: a, prefer: p };
}

/**
 * Whether one more entry of a kind still fits beside the live ones, counted after the write. A swap
 * whose avoided word is already avoided is a duplicate, in any letter case.
 */
export function fits(live: readonly { kind: "example" | "swap"; text: string }[], next: { kind: "example" | "swap"; text: string }): VoiceRefusal | null {
  const same = live.filter((e) => e.kind === next.kind);
  if (next.kind === "swap" && same.some((e) => e.text.toLowerCase() === next.text.toLowerCase())) return "voice_swap_exists";
  if (next.kind === "example" && same.length >= MAX_EXAMPLES) return "voice_examples_full";
  if (next.kind === "swap" && same.length >= MAX_SWAPS) return "voice_swaps_full";
  return null;
}
