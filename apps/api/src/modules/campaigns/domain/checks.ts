// SPDX-License-Identifier: AGPL-3.0-only
// What the draft checks found, and whether their answers can be believed. A checker that leaves a
// claim out or invents a source must not make a draft pass, so any answer Direx can't confirm
// against the draft counts as no answer at all.
import { numbersIn } from "./claims";
import { quotedOn } from "./quotes";

export const CLAIM_KINDS = ["statement", "promise", "price", "comparison"] as const;
export const CLAIM_SUPPORT = ["fact", "recipient_detail", "none"] as const;
export const INJECTION_REASONS = ["follows_instructions", "asks_reader_to_act", "disguised_contact", "impersonates", "off_topic", "mentions_system"] as const;

export type Claim = { quote: string; kind: (typeof CLAIM_KINDS)[number]; support: (typeof CLAIM_SUPPORT)[number]; fact?: number | null | undefined; detail?: number | null | undefined };
export type ClaimAnswer = { schemaVersion: 1; claims: Claim[] };
export type InjectionAnswer = { schemaVersion: 1; verdict: "clean" | "suspect"; reasons: (typeof INJECTION_REASONS)[number][] };

export type Finding = { code: "unsupported_promise" | "unsupported_claim"; quote: string };
export type ClaimJudgement = { status: "passed" } | { status: "failed"; findings: Finding[] } | { status: "malformed" };
export type InjectionJudgement = { status: "passed" } | { status: "failed"; reasons: InjectionAnswer["reasons"] } | { status: "malformed" };

export type CheckStatus = "passed" | "failed" | "unavailable";
export type ModelCheck = { status: CheckStatus; callId: string | null; routeHash: string | null };
export type CheckRecord = { schemaVersion: 1; textDigest: string; links: "passed" | "failed"; subject: "passed" | "failed"; claim: ModelCheck; injection: ModelCheck };

export function judgeClaims(answer: ClaimAnswer, draft: string, factCount: number, detailCount: number): ClaimJudgement {
  for (const c of answer.claims) {
    if (!quotedOn(c.quote, draft)) return { status: "malformed" };
    if (c.support === "fact" && (!c.fact || c.fact > factCount)) return { status: "malformed" };
    if (c.support === "recipient_detail" && (!c.detail || c.detail > detailCount)) return { status: "malformed" };
  }
  // Every number in the draft is a claim; an answer that skips one has skipped what matters most.
  const quoted = answer.claims.map((c) => c.quote).join("\n");
  if (numbersIn(draft).some((n) => !quoted.includes(n))) return { status: "malformed" };
  const findings = answer.claims
    .filter((c) => c.support === "none")
    .map((c): Finding => ({ code: c.kind === "promise" || c.kind === "price" ? "unsupported_promise" : "unsupported_claim", quote: c.quote }));
  return findings.length ? { status: "failed", findings } : { status: "passed" };
}

export function judgeInjection(answer: InjectionAnswer): InjectionJudgement {
  if (answer.verdict === "clean") return { status: "passed" };
  return answer.reasons.length ? { status: "failed", reasons: answer.reasons } : { status: "malformed" };
}
