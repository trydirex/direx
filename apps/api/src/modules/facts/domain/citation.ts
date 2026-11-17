// SPDX-License-Identifier: AGPL-3.0-only
// Pure: whether a draft may rely on fact_id@version.

export type Citation = "ok" | "missing" | "stale" | "retired" | "needs_decision";

export function checkCitation(cited: number, f: { currentVersion: number; retired: boolean; contested: boolean } | undefined): Citation {
  if (!f) return "missing";
  if (f.retired) return "retired";
  if (f.contested) return "needs_decision";
  return cited === f.currentVersion ? "ok" : "stale";
}
