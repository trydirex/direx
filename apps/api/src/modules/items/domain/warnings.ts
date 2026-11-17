// SPDX-License-Identifier: AGPL-3.0-only
// Pure: what an Item warns about, as a code a rule can read and the words a person reads.

export const WARNING_CODES = [
  // Where the text came from, not that it is wrong.
  "untrusted_source",
  "recipient_detail",
  "not_based_on_site",
  // The text itself.
  "uncited_number",
  "banned_claim",
  "unsupported_claim",
  "possible_injection",
  "check_unavailable",
  // Needs a person's decision.
  "price_conflict",
  "foreign_link",
  "reply_prefix",
  "unsupported_promise",
  "newsletter_subscriber",
  // Everything else.
  "changed_since_drafted",
  "run_incomplete",
  "opt_out_question",
  "unspecified",
] as const;

export type WarningCode = (typeof WARNING_CODES)[number];
export type Warning = { code: WarningCode; text: string };

export const warn = (code: WarningCode, text: string): Warning => ({ code, text });

/** Only these may be ignored by a rule that covers text no person read. */
export const EXEMPT_PROVENANCE: ReadonlySet<WarningCode> = new Set(["untrusted_source", "recipient_detail", "not_based_on_site"]);

export const blocking = (ws: readonly Warning[]): Warning[] => ws.filter((w) => !EXEMPT_PROVENANCE.has(w.code));

export const sameWarning = (a: Warning, b: Warning) => a.code === b.code && a.text === b.text;
