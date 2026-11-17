// SPDX-License-Identifier: AGPL-3.0-only
// One call to the unmodified Claude Code CLI. `--tools ""` alone leaves connected MCP tools on,
// so settings and MCP config are shut out too.
import { z } from "zod";
import type { DispatchRequest, DispatchResult } from "../sdk";
import { envelopeSchema, failureOf, instructions, NOT_INSTALLED_REASON, resultOf } from "./envelope";
import { runSandboxed } from "./sandbox";
import type { ModelAdapter } from "./types";

const SYSTEM_FILE = "system.txt";

export const claudeArgs = (r: Pick<DispatchRequest, "model" | "tools" | "output">): string[] => [
  "-p",
  "--tools", "",
  "--strict-mcp-config",
  "--setting-sources", "",
  "--disable-slash-commands",
  "--no-session-persistence",
  "--system-prompt-file", SYSTEM_FILE,
  "--model", r.model,
  "--output-format", "json",
  "--json-schema", JSON.stringify(envelopeSchema(r)),
];

const reply = z.object({
  is_error: z.boolean().optional(),
  structured_output: z.unknown(),
  usage: z.object({
    input_tokens: z.number().default(0),
    cache_read_input_tokens: z.number().default(0),
    cache_creation_input_tokens: z.number().default(0),
    output_tokens: z.number().default(0),
    output_tokens_details: z.object({ thinking_tokens: z.number().default(0) }).optional(),
  }).optional(),
  modelUsage: z.record(z.string(), z.unknown()).optional(),
});

function parsed(stdout: string) {
  try {
    return reply.safeParse(JSON.parse(stdout));
  } catch {
    return null;
  }
}

async function call(r: DispatchRequest): Promise<DispatchResult> {
  const binary = Bun.which("claude", { PATH: process.env.PATH ?? "" });
  if (!binary) return { ok: false, family: "configuration", definite: true, reason: NOT_INSTALLED_REASON };
  const run = await runSandboxed({
    binary,
    args: claudeArgs(r),
    env: { CLAUDE_CODE_OAUTH_TOKEN: r.apiKey, CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1" },
    stdin: r.messages.map((m) => m.content).join("\n\n"),
    egress: ["api.anthropic.com:443"],
    files: { [SYSTEM_FILE]: [r.system, instructions(r)].filter(Boolean).join("\n\n") },
    signal: r.abortSignal,
  });
  if (r.abortSignal.aborted) return { ok: false, family: "no_receipt", definite: false };
  if (!run.ran) return { ok: false, family: "configuration", definite: true, reason: run.reason };
  const body = parsed(run.stdout);
  if (run.exitCode !== 0 || body?.data?.is_error) return failureOf(`${run.stdout}\n${run.stderr}`);
  if (!body) return { ok: false, family: "model_refusal", usage: null, reason: "cli: reply not json" };
  if (!body.success) return { ok: false, family: "model_refusal", usage: null, reason: `cli: ${body.error.issues.slice(0, 5).map((i) => `${i.path.join(".") || "(root)"} ${i.code}`).join("; ")}` };
  const u = body.data.usage;
  const usage = {
    noCacheTokens: u?.input_tokens ?? 0,
    cacheReadTokens: u?.cache_read_input_tokens ?? 0,
    cacheWriteTokens: u?.cache_creation_input_tokens ?? 0,
    outputTokens: u?.output_tokens ?? 0,
    reasoningTokens: u?.output_tokens_details?.thinking_tokens ?? 0,
    tokensUnknown: !u,
  };
  return resultOf(r, body.data.structured_output, usage, Object.keys(body.data.modelUsage ?? {})[0] ?? r.model);
}

export const claudeCode: ModelAdapter = {
  id: "claude_code",
  label: "Claude Code",
  signIn: "setup_token",
  models: ["claude-haiku-5-5", "claude-sonnet-5-5", "claude-opus-5-5"],
  installed: async () => Bun.which("claude", { PATH: process.env.PATH ?? "" }) !== null,
  call,
};
