// SPDX-License-Identifier: AGPL-3.0-only
// One CSV row as a Person to add. A wrong value refuses the row, so nothing half-true is stored. A
// missing eligibility field doesn't: the Person is added and left out of drafts until it's recorded.
import { normaliseWebsite } from "./website";

const MAX_NAME = 200;
const MAX_WEBSITE = 2048;
export const MAX_EVIDENCE = 1000;
const MAX_SCOPE = 500;
export const ELIGIBILITY_FIELDS = ["country", "basis", "evidence"] as const;

export type RowRefusal = "no_email" | "bad_website" | "bad_country" | "bad_basis" | "bad_entity_type" | "bad_expiry" | "too_long";
export type Eligibility<Basis extends string, Entity extends string> = {
  country: string;
  basis: Basis;
  evidence: string;
  entityType: Entity | undefined;
  scope: string | null;
  expiresAt: Date | null;
};
export type PersonRow<Basis extends string, Entity extends string = string> = {
  email: string;
  firstName: string | null;
  company: string | null;
  website: string | null;
  eligibility: Eligibility<Basis, Entity> | null;
  missing: string[];
  /** What the row gave towards a record when it isn't whole, so a missing part can be filled from elsewhere. */
  given: { country: string; basis: Basis | null; evidence: string; entityType: Entity | undefined };
};

/** A calendar date as midnight UTC, or null when it isn't one (2026-13-01 and 2026-02-30 aren't). */
function dateOf(value: string): Date | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const d = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().startsWith(value) ? d : null;
}

export function readRow<Basis extends string, Entity extends string>(
  values: Record<string, string>,
  vocab: { bases: readonly Basis[]; entityTypes: readonly Entity[] },
): { ok: true; row: PersonRow<Basis, Entity> } | { ok: false; reason: RowRefusal } {
  const isBasis = (value: string): value is Basis => (vocab.bases as readonly string[]).includes(value);
  const isEntity = (value: string): value is Entity => (vocab.entityTypes as readonly string[]).includes(value);
  const email = values.email ?? "";
  if (!email) return { ok: false, reason: "no_email" };
  const firstName = values.first_name || null;
  const company = values.company || null;
  const given = values.website || null;
  const evidence = values.evidence ?? "";
  const scope = values.scope || null;
  if ((firstName?.length ?? 0) > MAX_NAME || (company?.length ?? 0) > MAX_NAME || (given?.length ?? 0) > MAX_WEBSITE || evidence.length > MAX_EVIDENCE || (scope?.length ?? 0) > MAX_SCOPE) return { ok: false, reason: "too_long" };

  const website = given && normaliseWebsite(given);
  if (given && !website) return { ok: false, reason: "bad_website" };
  const country = (values.country ?? "").toUpperCase();
  if (country && !/^[A-Z]{2}$/.test(country)) return { ok: false, reason: "bad_country" };
  const basis = values.basis ?? "";
  if (basis && !isBasis(basis)) return { ok: false, reason: "bad_basis" };
  const entity = values.entity_type ?? "";
  if (entity && !isEntity(entity)) return { ok: false, reason: "bad_entity_type" };
  const expires = values.expires ?? "";
  const expiresAt = expires ? dateOf(expires) : null;
  if (expires && !expiresAt) return { ok: false, reason: "bad_expiry" };

  const missing = ELIGIBILITY_FIELDS.filter((f) => !values[f]);
  const eligibility = !missing.length && isBasis(basis) ? { country, basis, evidence, entityType: entity && isEntity(entity) ? entity : undefined, scope, expiresAt } : null;
  const partial = { country, basis: isBasis(basis) ? basis : null, evidence, entityType: entity && isEntity(entity) ? entity : undefined };
  return { ok: true, row: { email, firstName, company, website: website || null, eligibility, missing, given: partial } };
}
