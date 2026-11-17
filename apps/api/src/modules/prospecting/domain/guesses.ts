// SPDX-License-Identifier: AGPL-3.0-only
// Pure: the addresses Direx may guess for a named person with no published address, and what each
// verification answer means for the next guess. A guess is only ever kept once it verifies deliverable.

export type GuessPattern = "first" | "first.last";
export type Guess = { email: string; pattern: GuessPattern };
/** What follows one guess's verification result. */
export type AfterGuess = "keep" | "next" | "stop_person" | "stop_domain";

/** People per company Direx guesses for. */
export const MAX_GUESSED_PEOPLE = 2;
/** Canada's published-address exception needs a published address, so a guess is never used there. */
export const NO_GUESS_COUNTRY = "CA";

/** A name part as a local part: accents dropped, lowercased, letters and digits only. */
function localPart(part: string): string {
  return part
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "");
}

/**
 * `first@` and then `first.last@`, in the order they are tried. Only `first@` when there is no last
 * name, and nothing when the first name leaves no letters to use.
 */
export function guessesFor(first: string, last: string, domain: string): Guess[] {
  const f = localPart(first);
  if (!f) return [];
  const l = localPart(last);
  return [{ email: `${f}@${domain}`, pattern: "first" as const }, ...(l ? [{ email: `${f}.${l}@${domain}`, pattern: "first.last" as const }] : [])];
}

/**
 * Only an invalid answer leads to the next pattern. A catch-all domain answers yes to anything, so it
 * ends guessing at that domain; an unknown or any other answer ends it for that person.
 */
export function afterGuess(result: string): AfterGuess {
  if (result === "deliverable") return "keep";
  if (result === "invalid") return "next";
  if (result === "catch_all") return "stop_domain";
  return "stop_person";
}

export const mayGuessIn = (country: string | null): boolean => country !== NO_GUESS_COUNTRY;

export const fullName = (p: { first: string; last: string }) => `${p.first} ${p.last}`.trim();

/** The people addresses are guessed for: those with no published address, kept or not, since a person already chose for them. */
export function peopleToGuess<P extends { first: string; last: string }>(people: readonly P[], addresses: readonly { source: string; name: string | null }[]): P[] {
  const published = new Set(addresses.flatMap((a) => (a.source === "published" && a.name ? [a.name.toLowerCase()] : [])));
  return people.filter((p) => !published.has(fullName(p).toLowerCase())).slice(0, MAX_GUESSED_PEOPLE);
}
