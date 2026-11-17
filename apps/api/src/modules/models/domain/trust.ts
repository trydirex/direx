// SPDX-License-Identifier: AGPL-3.0-only
// Pure: a call's trust comes from what its parts are and whether its run is tainted. A
// caller cannot state it, and any kind not named here is untrusted.

export type Trust = "trusted" | "untrusted";

const TRUSTED: ReadonlySet<string> = new Set(["definition", "skill", "workspace_fact", "ask_user_text", "draft", "agent_lesson"]);

export const kindTrust = (kind: string): Trust => (TRUSTED.has(kind) ? "trusted" : "untrusted");

export const callTrust = (kinds: readonly string[], runTainted: boolean): Trust =>
  runTainted || kinds.some((k) => kindTrust(k) === "untrusted") ? "untrusted" : "trusted";

export type ToolClass = "read" | "effect";

/** The tools a call may offer, or the refusal. Effect tools are refused, not hidden, so the caller finds out. */
export function toolsFor<T extends { class: ToolClass }>(trust: Trust, tools: readonly T[]): readonly T[] | "effect_tool_on_untrusted" {
  if (trust === "trusted") return tools;
  return tools.some((t) => t.class === "effect") ? "effect_tool_on_untrusted" : tools;
}
