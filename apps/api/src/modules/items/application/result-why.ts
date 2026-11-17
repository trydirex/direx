// SPDX-License-Identifier: AGPL-3.0-only
// Asks for the sentence behind each of Home's numbers. Outreach calls it for replies and opt-outs; the route
// in models/purposes.ts rests on a run that met WHY_BAR.
import { createHash } from "node:crypto";
import type { ContextPart, Models } from "../../models/index";
import { resultWhy, type WhyAnswer, type WhyResult } from "../definitions/result-why";

export type Generate = Models["generate"];

/** The raw answer, for the module and for the real eval alike. */
export async function askResultWhy(generate: Generate, workspaceId: string, userId: string, results: readonly WhyResult[], nonce = ""): Promise<{ output: WhyAnswer } | { failure: string }> {
  const text = `${JSON.stringify({ results }, null, 2)}${nonce}`;
  const parts: ContextPart[] = [
    { role: "system", kind: "definition", text: resultWhy.prompt },
    { role: "user", kind: "home_results", text },
  ];
  const key = createHash("sha256").update(text).digest("hex");
  const r = await generate({ workspaceId, purpose: resultWhy.id, idempotencyKey: `result_why:${userId}:${key}`, parts, output: resultWhy.output as never, actorUserId: userId });
  if (r.ok) return typeof r.output !== "string" ? { output: r.output as WhyAnswer } : { failure: "plain text, not the answer's shape" };
  return { failure: "refusal" in r ? r.refusal : `${r.errorFamily}${r.reason ? `: ${r.reason}` : ""}` };
}
