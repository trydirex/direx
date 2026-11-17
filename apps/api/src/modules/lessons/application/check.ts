// SPDX-License-Identifier: AGPL-3.0-only
// Asks the lesson check about one sentence, and says whether its recorded eval lets it be asked at all.
// Until a passing eval is on file for the model this deployment would use, no lesson can be proposed.
import { createHash } from "node:crypto";
import { safetyGate } from "../../agents/index";
import { CHECK_CANDIDATES, type ContextPart, type Deployment, type Models } from "../../models/index";
import { judgeLesson, lessonCheck, type LessonAnswer, type LessonReason } from "../definitions/lesson-check";

export type Generate = Models["generate"];
export type Checked = { status: "passed" } | { status: "refused"; reasons: LessonReason[] } | { status: "unavailable" };

/** Self-host asks on the subscription first, cloud on Direx's key, as for the draft checks. */
export const lessonCheckCandidate = (deployment: Deployment) => (deployment === "self_host" ? CHECK_CANDIDATES.claude_code : CHECK_CANDIDATES.anthropic);

/** Reuses the injection check's signed bar, since it scores the same thing: wrong passes and answered share. */
export function lessonCheckOpen(deployment: Deployment, resultsDir?: string): boolean {
  const c = lessonCheckCandidate(deployment);
  const required = [{ kind: "injection_check" as const, id: lessonCheck.id, version: lessonCheck.version, promptDigest: lessonCheck.promptDigest }];
  return safetyGate({ required, provider: c.provider, model: c.model, language: "en", ...(resultsDir ? { resultsDir } : {}) }).offered;
}

/** The raw answer, for the module and for the real eval alike. */
export async function askLessonCheck(generate: Generate, workspaceId: string, userId: string, text: string): Promise<{ output: LessonAnswer } | { failure: string }> {
  const parts: ContextPart[] = [
    { role: "system", kind: "definition", text: lessonCheck.prompt },
    { role: "user", kind: "checked_lesson", text: `The sentence to check:\n${text}` },
  ];
  const key = createHash("sha256").update(text).digest("hex");
  const r = await generate({ workspaceId, purpose: lessonCheck.id, idempotencyKey: `lesson_check:${userId}:${key}`, parts, output: lessonCheck.output as never, actorUserId: userId });
  if (r.ok) return typeof r.output !== "string" ? { output: r.output as LessonAnswer } : { failure: "plain text, not the answer's shape" };
  return { failure: "refusal" in r ? r.refusal : `${r.errorFamily}${r.reason ? `: ${r.reason}` : ""}` };
}

export async function checkLesson(generate: Generate, workspaceId: string, userId: string, text: string): Promise<Checked> {
  const asked = await askLessonCheck(generate, workspaceId, userId, text);
  if (!("output" in asked)) return { status: "unavailable" };
  const j = judgeLesson(asked.output);
  return j.status === "malformed" ? { status: "unavailable" } : j;
}
