// SPDX-License-Identifier: AGPL-3.0-only
// What a writer may know from a list row: a first name and a company, each one short line. Code does
// this, not a model, and nothing else in the row (the address included) reaches the writer.

const MAX_CHARS = 80;

function clean(value: string | null | undefined): string | null {
  const line = (value ?? "").replace(/[\p{Cc}\p{Cf}]/gu, " ").replace(/\s+/g, " ").trim();
  const short = Array.from(line).slice(0, MAX_CHARS).join("").trim();
  return short || null;
}

export type ListValues = { firstName: string | null; company: string | null };

export const cleanListValues = (row: { firstName?: string | null; company?: string | null }): ListValues => ({ firstName: clean(row.firstName), company: clean(row.company) });
