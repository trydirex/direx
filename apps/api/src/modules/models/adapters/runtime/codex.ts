// SPDX-License-Identifier: AGPL-3.0-only
// One call to the unmodified Codex CLI. Codex has no single tools-off switch, so each feature that
// offers a tool is disabled by name. Its sign-in is a file it may refresh, so the newer file is kept.
// Direx ships Codex pinned in apps/api and runs the native binary from its platform package (ADR 0036).
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { z } from "zod";
import type { DispatchRequest, DispatchResult } from "../sdk";
import { envelopeSchema, failureOf, instructions, NOT_INSTALLED_REASON, resultOf } from "./envelope";
import { runSandboxed } from "./sandbox";
import type { ModelAdapter } from "./types";

// The platforms Codex publishes a package for, with the folder its binary sits in. Windows is left
// out: the sandbox refuses it, so Codex can't run there either way.
const TARGETS: Readonly<Record<string, string>> = {
  "linux-x64": "x86_64-unknown-linux-musl",
  "linux-arm64": "aarch64-unknown-linux-musl",
  "darwin-x64": "x86_64-apple-darwin",
  "darwin-arm64": "aarch64-apple-darwin",
};

/**
 * The native binary in the platform package installed beside the pinned wrapper, or null. The wrapper
 * names the exact package it expects (`npm:@openai/codex@<version>-<platform>`), so a package left over
 * from another version is refused. Never the wrapper's Node launcher, and never one on PATH.
 */
export function packagedCodex(wrapperDir: string, platform: string): string | null {
  const target = TARGETS[platform];
  if (!target) return null;
  try {
    const wrapper = realpathSync(wrapperDir);
    const expected = JSON.parse(readFileSync(join(wrapper, "package.json"), "utf8")).optionalDependencies?.[`@openai/codex-${platform}`];
    const dir = join(wrapper, "..", `codex-${platform}`);
    const pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
    const binary = join(dir, "vendor", target, "bin", "codex");
    return expected === `npm:${pkg.name}@${pkg.version}` && existsSync(binary) ? binary : null;
  } catch {
    return null;
  }
}

let testBinary: string | null | undefined;
let shipped: string | null | undefined;

/** Test only: the binary the Codex adapter and sign-in run instead of the shipped one; null is "not installed". */
export function useCodexBinaryForTests(binary: string | null | undefined): void {
  testBinary = binary;
}

/** Resolve the shipped binary relative to a module, or return null when it isn't installed. */
export function resolveShippedCodex(from = import.meta.url): string | null {
  let manifest: string;
  try {
    manifest = createRequire(from).resolve("@openai/codex/package.json");
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "MODULE_NOT_FOUND") return null;
    throw error;
  }
  return packagedCodex(dirname(manifest), `${process.platform}-${process.arch}`);
}

/** The Codex binary to run, or null when it isn't installed. */
export function codexBinary(): string | null {
  if (testBinary !== undefined) return testBinary;
  shipped ??= resolveShippedCodex();
  return shipped;
}

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
  const binary = codexBinary();
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
  installed: async () => codexBinary() !== null,
  call,
};
