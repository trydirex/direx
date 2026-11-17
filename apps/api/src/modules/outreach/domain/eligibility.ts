// SPDX-License-Identifier: AGPL-3.0-only
// Pure: whether the record for a Person allows contacting them in this class of Touch, and what the
// country research suggests the customer check before sending.
import countries from "./countries.json" with { type: "json" };

export const BASES = ["consent", "implied", "legitimate_interest", "published_address"] as const;
export type Basis = (typeof BASES)[number];

export const ENTITY_TYPES = ["corporate", "sole_trader", "partnership", "unknown"] as const;
export type EntityType = (typeof ENTITY_TYPES)[number];

export const CONFIDENCES = ["stated", "inferred"] as const;
export type Confidence = (typeof CONFIDENCES)[number];

/** Replies, service and transactional mail answer something the Person started. */
const NEEDS_BASIS = new Set(["cold", "sales_follow_up", "consented_marketing"]);

export function notEligible(touchClass: string, record: { country: string; basis: string; expiresAt?: Date | null } | null, now: Date): string | null {
  if (!NEEDS_BASIS.has(touchClass)) return null;
  if (!record) return "no basis recorded";
  // A basis someone gave a date to stops counting on that date; one with no date never does.
  if (record.expiresAt && record.expiresAt <= now) return `basis expired on ${record.expiresAt.toISOString().slice(0, 10)}`;
  if (touchClass === "consented_marketing" && record.basis !== "consent") return "consented marketing needs a recorded consent";
  return null;
}

// The country research, shared with the published cold-email skill so the two never disagree. It is
// a suggestion, never a hold: the customer is the sender and answers for the law where they send.
const COUNTRIES = countries.countries;
const CONSENT_COUNTRIES = new Set(COUNTRIES.filter((c) => c.status !== "open").map((c) => c.code));
const RESEARCHED = new Set(COUNTRIES.map((c) => c.code));
/** Where the rules turn on whether the recipient is a company or a person trading alone. */
const ENTITY_COUNTRIES = new Set(COUNTRIES.filter((c) => c.entitySplit).map((c) => c.code));

export const WARNINGS = [
  "consent_likely_needed",
  "entity_needs_consent",
  "entity_unknown",
  "not_researched",
  "sender_law",
  "country_inferred",
  "sender_country_missing",
] as const;
export type Warning = (typeof WARNINGS)[number];

export function eligibilityWarnings(
  record: { country: string; basis: string; entityType: string; countryConfidence: string },
  senderCountry: string | null,
): Warning[] {
  const out: Warning[] = [];
  const consent = record.basis === "consent";
  if (CONSENT_COUNTRIES.has(record.country) && !consent) out.push("consent_likely_needed");
  if (record.country === "GB" && (record.entityType === "sole_trader" || record.entityType === "partnership") && !consent) out.push("entity_needs_consent");
  if (ENTITY_COUNTRIES.has(record.country) && record.entityType === "unknown") out.push("entity_unknown");
  if (!RESEARCHED.has(record.country)) out.push("not_researched");
  // Canadian law covers everything sent from Canada, and it has no legitimate-interest basis.
  if (senderCountry === "CA" && record.basis === "legitimate_interest") out.push("sender_law");
  if (record.countryConfidence === "inferred") out.push("country_inferred");
  if (!senderCountry) out.push("sender_country_missing");
  return out;
}
