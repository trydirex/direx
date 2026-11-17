// SPDX-License-Identifier: AGPL-3.0-only
// Voice (ADR 0022): example passages and word swaps, saved by someone who may approve. A pasted example
// passes the code checks, then the voice check; until that check has a passing eval on file for the
// model this deployment would use (`checkOpen`, from the agents module's eval gate), pasting is closed.
// Writes for one Workspace are serialized, and the limits are counted on what is there after the lock.
import { createHash } from "node:crypto";
import type { ContextPart, Models } from "../../models/index";
import { inWorkspace } from "../adapters/repo";
import { insertVoice, liveVoice, lockVoice, retireVoice, type LiveVoice } from "../adapters/voice-repo";
import { judgeVoice, voiceCheck, type VoiceAnswer, type VoiceReason } from "../definitions/voice-check";
import { exampleText, fits, swapWords, type VoiceRefusal } from "../domain/voice";

export type Generate = Models["generate"];
export type VoiceChecked = { status: "passed" } | { status: "refused"; reasons: VoiceReason[] } | { status: "unavailable" } | { status: "no_model" };
export type VoiceResult = { ok: true; id: string } | { ok: false; reason: VoiceRefusal | "voice_check_closed" | "voice_check_unavailable" | "voice_check_no_model" | "voice_check_refused"; reasons?: VoiceReason[] };
/** Refusals a retry won't fix: this Workspace has no model the check may run on until someone connects one. */
const NO_MODEL: ReadonlySet<string> = new Set(["no_route", "no_connection", "no_shared_sign_in"]);

const digestOf = (s: string) => createHash("sha256").update(s).digest("hex");

/** The raw answer, for the module and for the real eval alike. */
export async function askVoiceCheck(generate: Generate, workspaceId: string, userId: string, text: string): Promise<{ output: VoiceAnswer } | { failure: string }> {
  const parts: ContextPart[] = [
    { role: "system", kind: "definition", text: voiceCheck.prompt },
    { role: "user", kind: "checked_voice", text: `The passage to check:\n${text}` },
  ];
  const r = await generate({ workspaceId, purpose: voiceCheck.id, idempotencyKey: `voice_check:${userId}:${digestOf(text)}`, parts, output: voiceCheck.output as never, actorUserId: userId });
  if (r.ok) return typeof r.output !== "string" ? { output: r.output as VoiceAnswer } : { failure: "plain text, not the answer's shape" };
  return { failure: "refusal" in r ? r.refusal : `${r.errorFamily}${r.reason ? `: ${r.reason}` : ""}` };
}

async function checkExample(generate: Generate | undefined, workspaceId: string, userId: string, text: string): Promise<VoiceChecked> {
  if (!generate) return { status: "unavailable" };
  const asked = await askVoiceCheck(generate, workspaceId, userId, text);
  if (!("output" in asked)) return { status: NO_MODEL.has(asked.failure) ? "no_model" : "unavailable" };
  const j = judgeVoice(asked.output);
  return j.status === "malformed" ? { status: "unavailable" } : j;
}

/** Without `checkOpen`, as in most tests, pasting an example stays closed. */
export function voice(deps: { now: () => Date; generate?: () => Generate | undefined; checkOpen?: () => boolean }) {
  const open = () => deps.checkOpen?.() ?? false;

  async function save(workspaceId: string, userId: string, entry: { kind: "example" | "swap"; text: string; prefer: string | null }): Promise<VoiceResult> {
    return inWorkspace(workspaceId, async (tx): Promise<VoiceResult> => {
      await lockVoice(tx, workspaceId);
      const full = fits(await liveVoice(tx), entry);
      if (full) return { ok: false, reason: full };
      const id = await insertVoice(tx, workspaceId, { ...entry, digest: digestOf(`${entry.text}\n${entry.prefer ?? ""}`), userId, at: deps.now() });
      return { ok: true, id };
    });
  }

  return {
    listVoice: (workspaceId: string): Promise<LiveVoice[]> => inWorkspace(workspaceId, liveVoice),

    /** Whether pasting an example is open on this deployment. */
    pasteOpen: open,

    addSwap(workspaceId: string, a: { avoid: string; prefer: string; userId: string }): Promise<VoiceResult> {
      const w = swapWords(a.avoid, a.prefer);
      if (!w.ok) return Promise.resolve({ ok: false, reason: w.reason });
      return save(workspaceId, a.userId, { kind: "swap", text: w.avoid, prefer: w.prefer });
    },

    async addExample(workspaceId: string, a: { text: string; userId: string }): Promise<VoiceResult> {
      const t = exampleText(a.text);
      if (!t.ok) return { ok: false, reason: t.reason };
      if (!open()) return { ok: false, reason: "voice_check_closed" };
      const checked = await checkExample(deps.generate?.(), workspaceId, a.userId, t.text);
      if (checked.status === "unavailable") return { ok: false, reason: "voice_check_unavailable" };
      if (checked.status === "no_model") return { ok: false, reason: "voice_check_no_model" };
      if (checked.status === "refused") return { ok: false, reason: "voice_check_refused", reasons: checked.reasons };
      return save(workspaceId, a.userId, { kind: "example", text: t.text, prefer: null });
    },

    retireVoice: (workspaceId: string, id: string, userId: string): Promise<{ ok: true } | { ok: false; reason: "not_found" }> =>
      inWorkspace(workspaceId, async (tx) => ((await retireVoice(tx, id, userId, deps.now())) ? { ok: true as const } : { ok: false as const, reason: "not_found" as const })),
  };
}
