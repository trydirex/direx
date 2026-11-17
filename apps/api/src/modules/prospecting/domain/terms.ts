// SPDX-License-Identifier: AGPL-3.0-only
// Pure: what the terms run is given, and which of its terms may be kept. Terms go to a search vendor,
// so one holding an address, a web address or the name of someone this Workspace knows is dropped.

export type StrategyAudience = { whoFor: string; personas: readonly { name: string; notes?: string | undefined }[] };
export type FullName = { first: string; last: string };

/** The Strategy's words the run reads, as data. Personas are made-up readers, not people. */
export function termsText(s: StrategyAudience): string {
  const personas = s.personas.map((p) => `- ${p.name}${p.notes ? `: ${p.notes}` : ""}`).join("\n");
  return `Who the business is for, from its Strategy:\n${s.whoFor}${personas ? `\n\nIts personas:\n${personas}` : ""}`;
}

const WEB_ADDRESS = /https?:\/\/|www\.|\b[\p{L}\p{N}-]+(?:\.[\p{L}\p{N}-]+)*\.\p{L}{2,}\b/iu;
const words = (s: string) => ` ${s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim()} `;

/**
 * True when the text holds an email address, a web address, or a known person's first and last name as
 * whole words. A name with no last part is left out, since a lone first name matches too many terms.
 */
export function holdsPersonData(text: string, names: readonly FullName[]): boolean {
  if (text.includes("@") || WEB_ADDRESS.test(text)) return true;
  const t = words(text);
  return names.some((n) => n.first.trim() !== "" && n.last.trim() !== "" && t.includes(words(`${n.first} ${n.last}`)));
}

/** The terms that may be kept, and how many were not. An objective that fails is dropped too. */
export function keptTerms(o: { terms: readonly string[]; objective: string }, names: readonly FullName[]) {
  const terms = o.terms.filter((t) => !holdsPersonData(t, names));
  return { terms, objective: holdsPersonData(o.objective, names) ? null : o.objective, dropped: o.terms.length - terms.length };
}
