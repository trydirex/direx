// SPDX-License-Identifier: AGPL-3.0-only
// Pure: what a model's reading of a reply may decide. An opt-out counts only with the sender's own words
// to show for it; anything less is a person's call, because a missed opt-out costs more than a wrong one.
export type OptOutAnswer = { answer: "opt_out" | "not_opt_out" | "unsure"; quote: string | null };
export type OptOutReading = { decided: "opted_out"; quote: string } | { decided: "not_opt_out" } | { decided: "person" };

const norm = (s: string) => s.normalize("NFKC").replace(/\s+/g, " ").trim().toLowerCase();

export function readOptOut(a: OptOutAnswer | null, words: string): OptOutReading {
  if (!a || a.answer === "unsure") return { decided: "person" };
  if (a.answer === "not_opt_out") return { decided: "not_opt_out" };
  const q = a.quote ? norm(a.quote) : "";
  return q && norm(words).includes(q) ? { decided: "opted_out", quote: a.quote! } : { decided: "person" };
}
