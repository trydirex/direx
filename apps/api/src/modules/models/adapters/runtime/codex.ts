// SPDX-License-Identifier: AGPL-3.0-only
// One call to the unmodified Codex CLI. Codex has no single tools-off switch, so each feature that
// offers a tool is disabled by name. Its sign-in is a file it may refresh, so the newer file is kept.
import { z } from "zod";
import type { DispatchRequest, DispatchResult } from "../sdk";
import { envelopeSchema, failureOf, instructions, NOT_INSTALLED_REASON, resultOf } from "./envelope";
import { runSandboxed } from "./sandbox";
import type { ModelAdapter } from "./types";

const AUTH_FILE = ".codex/auth.json";
const SCHEMA_FILE = "schema.json";
const DISABLED_FEATURES = ["shell_tool", "unified_exec", "apps", "browser_use", "computer_use", "plugins", "multi_agent", "in_app_browser", "code_mode_host"];

export const codexArgs = (r: Pick<DispatchRequest, "model">): string[] => [
  "exec",
  "--json",
  "--skip-git-repo-check",
  "--ignore-user-config",
  "--ignore-rules",
  "--sandbox", "read-only",
  ...DISABLED_FEATURES.flatMap((f) => ["--disable", f]),
  "--model", r.model,
  "--output-schema", SCHEMA_FILE,
  "-",
];

const event = z.object({
  type: z.string(),
  item: z.object({ type: z.string(), text: z.string().optional() }).optional(),
  usage: z.object({
    input_tokens: z.number().default(0),
    cached_input_tokens: z.number().default(0),
    cache_write_input_tokens: z.number().default(0),
    output_tokens: z.number().default(0),
    reasoning_output_tokens: z.number().default(0),
  }).optional(),
});

function eventsOf(stdout: string) {
  return stdout.split("\n").flatMap((line) => {
    try {
      const e = event.safeParse(JSON.parse(line));
      return e.success ? [e.data] : [];
    } catch {
      return [];
    }
  });
}

function parseJson(text: string | undefined): unknown {
  try {
    return JSON.parse(text ?? "");
  } catch {
    return undefined;
  }
}

async function call(r: DispatchRequest): Promise<DispatchResult> {
  const binary = Bun.which("codex", { PATH: process.env.PATH ?? "" });
  if (!binary) return { ok: false, family: "configuration", definite: true, reason: NOT_INSTALLED_REASON };
  const run = await runSandboxed({
    binary,
    args: codexArgs(r),
    env: { CODEX_HOME: "/home/direx/.codex" },
    stdin: [r.system, instructions(r), ...r.messages.map((m) => m.content)].filter(Boolean).join("\n\n"),
    egress: ["chatgpt.com:443", "auth.openai.com:443", "api.openai.com:443"],
    files: { [AUTH_FILE]: r.apiKey, [SCHEMA_FILE]: JSON.stringify(envelopeSchema(r)) },
    readBack: [AUTH_FILE],
    signal: r.abortSignal,
  });
  if (r.abortSignal.aborted) return { ok: false, family: "no_receipt", definite: false };
  if (!run.ran) return { ok: false, family: "configuration", definite: true, reason: run.reason };
  // Kept whatever the outcome: a refresh may already have spent the old token.
  const refreshed = run.files[AUTH_FILE];
  if (refreshed && refreshed !== r.apiKey) await r.replaceKey?.(refreshed);

  const events = eventsOf(run.stdout);
  const done = events.find((e) => e.type === "turn.completed");
  if (run.exitCode !== 0 || !done) return run.exitCode === 0 && events.length === 0 ? { ok: false, family: "model_refusal", usage: null } : failureOf(`${run.stdout}\n${run.stderr}`);
  const u = done.usage;
  const cacheRead = u?.cached_input_tokens ?? 0;
  const cacheWrite = u?.cache_write_input_tokens ?? 0;
  const usage = {
    noCacheTokens: Math.max((u?.input_tokens ?? 0) - cacheRead - cacheWrite, 0),
    cacheReadTokens: cacheRead,
    cacheWriteTokens: cacheWrite,
    outputTokens: u?.output_tokens ?? 0,
    reasoningTokens: u?.reasoning_output_tokens ?? 0,
    tokensUnknown: !u,
  };
  const answer = events.filter((e) => e.type === "item.completed" && e.item?.type === "agent_message").at(-1)?.item?.text;
  return resultOf(r, parseJson(answer), usage, r.model);
}

export const codex: ModelAdapter = {
  id: "codex",
  label: "Codex",
  signIn: "device",
  models: ["gpt-6-luna", "gpt-6-sol", "gpt-6-astra"],
  installed: async () => Bun.which("codex", { PATH: process.env.PATH ?? "" }) !== null,
  call,
};
