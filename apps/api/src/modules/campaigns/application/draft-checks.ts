// SPDX-License-Identifier: AGPL-3.0-only
// Runs the claim and injection checks on one draft. A check that can't run, or whose answer Direx
// can't confirm, comes back unavailable: the draft still reaches a person, and no rule can cover it.
import { warn, type Warning } from "../../items";
import type { ContextPart, Models } from "../../models";
import { createHash } from "node:crypto";
import { judgeClaims, judgeInjection, type CheckRecord, type ClaimAnswer, type ClaimJudgement, type InjectionAnswer, type InjectionJudgement } from "../domain/checks";
import { claimCheck, injectionCheck, type DraftCheck } from "../definitions/checks";

export type Generate = Pick<Models, "generate">["generate"];
export type ToCheck = {
  /** The writer run's id, so a retried sink asks the same question under the same key. */
  key: string;
  userId: string;
  subject: string;
  text: string;
  facts: readonly { id: string; text: string }[];
  details: readonly string[];
};
/** The exact words a check read. Any edit changes it, so old results stop counting. */
export const textDigest = (subject: string, text: string): string => createHash("sha256").update(`${subject}\n${text}`).digest("hex");

/** What a rule that covers unread text asks: did every check pass on exactly these words? */
export const checksPassed = (r: CheckRecord | null, subject: string, text: string): boolean =>
  r !== null &&
  r.textDigest === textDigest(subject, text) &&
  r.links === "passed" &&
  r.subject === "passed" &&
  r.claim.status === "passed" &&
  r.injection.status === "passed";

type Unavailable = { status: "unavailable" };
export type Checked<J> = { judgement: J | Unavailable; callId: string | null; routeHash: string | null };
export type ModelChecks = { claim: Checked<ClaimJudgement>; injection: Checked<InjectionJudgement> };

const UNAVAILABLE = { judgement: { status: "unavailable" }, callId: null, routeHash: null } as const;

/** One check's raw answer, for the sink and for the real-key eval alike. */
export async function askCheck<T>(generate: Generate, workspaceId: string, check: DraftCheck, d: ToCheck): Promise<{ output: T; callId: string; routeHash: string } | { callId: string | null; failure: string }> {
  const parts: ContextPart[] = [
    { role: "system", kind: "definition", text: check.prompt },
    { role: "user", kind: "workspace_fact", text: d.facts.length ? `The business's Facts, numbered:\n${d.facts.map((f, i) => `${i + 1}. ${f.text}`).join("\n")}` : "The business has no Facts." },
    { role: "user", kind: "recipient_detail", text: d.details.length ? `Details about the recipient, numbered:\n${d.details.map((q, i) => `${i + 1}. ${q}`).join("\n")}` : "There are no details about the recipient." },
    { role: "user", kind: "checked_draft", text: `The email to check:\nSubject: ${d.subject}\n\n${d.text}` },
  ];
  const r = await generate({ workspaceId, purpose: check.id, idempotencyKey: `checks:${d.key}:${textDigest(d.subject, d.text)}:${check.id}`, parts, output: check.output as never, actorUserId: d.userId });
  if (r.ok) return typeof r.output !== "string" ? { output: r.output as T, callId: r.callId, routeHash: r.routeHash } : { callId: r.callId, failure: "plain text, not the answer's shape" };
  return { callId: r.callId, failure: "refusal" in r ? r.refusal : `${r.errorFamily}${r.reason ? `: ${r.reason}` : ""}` };
}

export async function modelChecks(generate: Generate | undefined, workspaceId: string, d: ToCheck): Promise<ModelChecks> {
  if (!generate) return { claim: UNAVAILABLE, injection: UNAVAILABLE };
  const [claim, injection] = await Promise.all([askCheck<ClaimAnswer>(generate, workspaceId, claimCheck, d), askCheck<InjectionAnswer>(generate, workspaceId, injectionCheck, d)]);
  const judged = <A, J>(r: { output: A; callId: string; routeHash: string } | { callId: string | null }, judge: (a: A) => J | { status: "malformed" }): Checked<J> => {
    if (!("output" in r)) return { judgement: { status: "unavailable" }, callId: r.callId, routeHash: null };
    const j = judge(r.output);
    const isMalformed = (x: J | { status: "malformed" }): x is { status: "malformed" } => (x as { status: string }).status === "malformed";
    return { judgement: isMalformed(j) ? { status: "unavailable" } : j, callId: r.callId, routeHash: r.routeHash };
  };
  return {
    claim: judged(claim, (a: ClaimAnswer) => judgeClaims(a, `${d.subject}\n${d.text}`, d.facts.length, d.details.length)),
    injection: judged(injection, judgeInjection),
  };
}

const NOT_RUN = {
  claim: "Direx couldn't run its claim check on this draft. Read every claim yourself before approving.",
  injection: "Direx couldn't check whether this draft was steered by the recipient's website. Read it closely before approving.",
} as const;

/** The checks' results as warnings, and the ones that need a person's decision before anything is sent. */
export function checkWarnings(c: ModelChecks, subjectRefused: boolean): { warnings: Warning[]; decisions: Warning[] } {
  const warnings: Warning[] = [];
  const decisions: Warning[] = [];
  if (subjectRefused) decisions.push(warn("reply_prefix", "The subject starts like a reply or a forward, but this is a first email"));
  const claim = c.claim.judgement;
  if (claim.status === "unavailable") warnings.push(warn("check_unavailable", NOT_RUN.claim));
  if (claim.status === "failed") {
    for (const f of claim.findings) {
      if (f.code === "unsupported_promise") decisions.push(warn("unsupported_promise", `A promise or price nothing backs: "${f.quote}"`));
      else warnings.push(warn("unsupported_claim", `A claim nothing backs: "${f.quote}"`));
    }
  }
  const injection = c.injection.judgement;
  if (injection.status === "unavailable") warnings.push(warn("check_unavailable", NOT_RUN.injection));
  if (injection.status === "failed") decisions.push(warn("possible_injection", `This may have been steered by the recipient's website (${injection.reasons.join(", ").replaceAll("_", " ")})`));
  return { warnings, decisions };
}

const statusOf = (j: { status: string }) => (j.status === "passed" ? "passed" : j.status === "failed" ? "failed" : "unavailable");

export const checkRecord = (c: ModelChecks, a: { subject: string; text: string; linksFound: boolean; subjectRefused: boolean }): CheckRecord => ({
  schemaVersion: 1,
  textDigest: textDigest(a.subject, a.text),
  links: a.linksFound ? "failed" : "passed",
  subject: a.subjectRefused ? "failed" : "passed",
  claim: { status: statusOf(c.claim.judgement), callId: c.claim.callId, routeHash: c.claim.routeHash },
  injection: { status: statusOf(c.injection.judgement), callId: c.injection.callId, routeHash: c.injection.routeHash },
});
