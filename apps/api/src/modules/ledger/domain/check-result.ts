// SPDX-License-Identifier: AGPL-3.0-only
// Block and hold reasons are values, never exceptions; an exception means a bug or an outage.

export type CheckResult =
  | { kind: "ok" }
  | { kind: "hold"; reason: string; detail?: string }
  | { kind: "block"; reason: string; detail?: string }
  /** Not now, but nothing needs a person: send at `at` instead, keeping the approval. Only ever later. */
  | { kind: "later"; reason: string; at: Date; detail?: string };

export const OK: CheckResult = { kind: "ok" };

// Block beats hold beats later beats ok; the first reason of the strongest kind wins. A later time
// from two checks takes the latest.
export function combine(results: CheckResult[]): CheckResult {
  const later = results.filter((r): r is Extract<CheckResult, { kind: "later" }> => r.kind === "later");
  return results.find((r) => r.kind === "block") ?? results.find((r) => r.kind === "hold") ?? later.sort((a, b) => b.at.getTime() - a.at.getTime())[0] ?? OK;
}
