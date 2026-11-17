// SPDX-License-Identifier: AGPL-3.0-only
// A Cohort is a saved filter rather than a list, so it refills as companies are accepted. This checks and
// tidies a filter before it is stored. The query that applies it belongs with the database code.
import { SIGNAL_TYPES } from "./signals";

export const ADDRESS_KINDS = ["named", "function"] as const;
export const ADDRESS_SOURCES = ["published", "guessed"] as const;
// The plugin SDK's verification results. domain/ may not import a package, so a test holds the two lists equal.
export const VERIFICATION_RESULTS = ["deliverable", "invalid", "catch_all", "unknown", "other"] as const;
export type AddressKind = (typeof ADDRESS_KINDS)[number];
export type AddressSource = (typeof ADDRESS_SOURCES)[number];
export type VerificationResult = (typeof VERIFICATION_RESULTS)[number];

/**
 * An empty list matches anything. Values in one list are alternatives, and every list must hold. `runs`
 * are the searches a company was first found by. `signalMaxAgeDays`, when set, counts only Signals read
 * that many days ago or less.
 */
export type CohortFilter = {
  signals: (typeof SIGNAL_TYPES)[number][];
  countries: string[];
  kinds: AddressKind[];
  sources: AddressSource[];
  verification: VerificationResult[];
  runs: string[];
  signalMaxAgeDays?: number;
};
type Field = keyof CohortFilter;
type ListField = Exclude<Field, "signalMaxAgeDays">;
export type CohortFilterRefusal =
  | { reason: "not_an_object" }
  | { reason: "unknown_field"; field: string }
  | { reason: "not_a_list"; field: Field }
  | { reason: "unknown_value"; field: Field; value: unknown };

/** About ten years: far older than any Signal Direx has read, so a bigger number is a mistake. */
export const MAX_SIGNAL_AGE_DAYS = 3650;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const ALLOWED: Record<Exclude<ListField, "countries" | "runs">, readonly string[]> = { signals: SIGNAL_TYPES, kinds: ADDRESS_KINDS, sources: ADDRESS_SOURCES, verification: VERIFICATION_RESULTS };
const LISTS: readonly ListField[] = ["signals", "countries", "kinds", "sources", "verification", "runs"];
const FIELDS: readonly Field[] = [...LISTS, "signalMaxAgeDays"];
const allowed = (field: ListField, v: string) => (field === "countries" ? /^[A-Z]{2}$/.test(v) : field === "runs" ? UUID.test(v) : ALLOWED[field].includes(v));
const tidied = (field: ListField, v: string) => (field === "countries" ? v.trim().toUpperCase() : field === "runs" ? v.trim().toLowerCase() : v.trim());

/**
 * A field left out means any, so a filter stored before a field existed still reads the same. Values
 * come back trimmed, deduplicated and sorted, with countries upper-cased.
 */
export function parseCohortFilter(input: unknown): { ok: true; filter: CohortFilter } | ({ ok: false } & CohortFilterRefusal) {
  if (typeof input !== "object" || input === null || Array.isArray(input)) return { ok: false, reason: "not_an_object" };
  // A misspelt field would otherwise be ignored and the Cohort would quietly match everyone.
  const unknown = Object.keys(input).find((k) => !(FIELDS as readonly string[]).includes(k));
  if (unknown !== undefined) return { ok: false, reason: "unknown_field", field: unknown };
  const raw = input as Partial<Record<Field, unknown>>;
  const filter: Record<ListField, string[]> = { signals: [], countries: [], kinds: [], sources: [], verification: [], runs: [] };
  for (const field of LISTS) {
    const values = raw[field] ?? [];
    if (!Array.isArray(values)) return { ok: false, reason: "not_a_list", field };
    for (const value of values as unknown[]) {
      const tidy = typeof value === "string" ? tidied(field, value) : null;
      if (tidy === null || !allowed(field, tidy)) return { ok: false, reason: "unknown_value", field, value };
      filter[field].push(tidy);
    }
    filter[field] = [...new Set(filter[field])].sort();
  }
  const days = raw.signalMaxAgeDays;
  if (days === undefined || days === null) return { ok: true, filter: filter as CohortFilter };
  if (!Number.isInteger(days) || (days as number) < 1 || (days as number) > MAX_SIGNAL_AGE_DAYS) return { ok: false, reason: "unknown_value", field: "signalMaxAgeDays", value: days };
  return { ok: true, filter: { ...(filter as Omit<CohortFilter, "signalMaxAgeDays">), signalMaxAgeDays: days as number } };
}

/** A filter read back from the database. Only parsed filters are stored, so one that no longer parses is a fault. */
export function storedCohortFilter(stored: unknown): CohortFilter {
  const parsed = parseCohortFilter(stored);
  if (!parsed.ok) throw new Error(`prospecting: a stored cohort filter no longer parses (${parsed.reason})`);
  return parsed.filter;
}
