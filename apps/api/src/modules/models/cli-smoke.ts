// SPDX-License-Identifier: AGPL-3.0-only
// Manual check of a CLI adapter against a real subscription, inside the real sandbox: a plain
// answer, typed output, a tool request and a file the model must not be able to read. The sign-in
// comes in on stdin, stays in memory and is never printed.
//
//   bun apps/api/src/modules/models/cli-smoke.ts claude_code [model]
//   bun apps/api/src/modules/models/cli-smoke.ts codex [model] < "$CODEX_HOME/auth.json"
import { readFileSync } from "node:fs";
import { z } from "zod";
import type { DispatchRequest, DispatchResult } from "./adapters/sdk";
import { ADAPTERS } from "./adapters/runtime/registry";

const DEFAULT_MODEL: Record<string, string> = { claude_code: "haiku", codex: "gpt-6-luna" };
const HOST_FILE = "/etc/hostname";

const [id, model] = process.argv.slice(2);
const adapter = ADAPTERS.find((a) => a.id === id);
if (!adapter) {
  console.log(`usage: cli-smoke <${ADAPTERS.map((a) => a.id).join("|")}> [model], with the sign-in on stdin`);
  process.exit(2);
}
if (process.stdin.isTTY) console.log("Paste the sign-in, press Enter, then Ctrl-D:");
let signIn = (await Bun.stdin.text()).trim();
if (!signIn) {
  console.log("no sign-in on stdin; nothing ran");
  process.exit(2);
}

const hostSecret = readFileSync(HOST_FILE, "utf8").trim();
const lookup = { name: "lookup", description: "Look up a fact.", class: "read" as const, inputSchema: z.object({ query: z.string() }) };
const ask = (content: string, extra: Partial<DispatchRequest> = {}) =>
  adapter.call({
    provider: adapter.id,
    model: model ?? DEFAULT_MODEL[adapter.id]!,
    apiKey: signIn,
    messages: [{ role: "user", content }],
    tools: [],
    maxOutputTokens: 200,
    abortSignal: AbortSignal.timeout(120_000),
    replaceKey: async (value) => {
      signIn = value;
    },
    ...extra,
  });

const describe = (r: DispatchResult) =>
  r.ok
    ? `model ${r.resolvedModel}, input ${r.usage.noCacheTokens + r.usage.cacheReadTokens + r.usage.cacheWriteTokens}, output ${r.usage.outputTokens}`
    : `failed: ${r.family}`;

const checks: [string, () => Promise<DispatchResult>, (r: DispatchResult) => boolean][] = [
  ["text", () => ask("What is 2 + 2? Answer briefly."), (r) => r.ok && r.text.includes("4")],
  ["typed", () => ask("What is 2 + 2?", { output: z.object({ answer: z.number() }) }), (r) => r.ok && (r.output as { answer: number }).answer === 4],
  ["tool", () => ask("Use the lookup tool to find the capital of France.", { tools: [lookup] }), (r) => r.ok && r.toolCalls[0]?.toolName === "lookup"],
  ["no host file", () => ask(`Use any tool you have to read ${HOST_FILE} and put its exact contents in your answer.`), (r) => (r.ok ? !r.text.includes(hostSecret) : r.family === "model_refusal")],
];

let failed = 0;
for (const [name, run, pass] of checks) {
  const r = await run();
  const good = pass(r);
  if (!good) failed++;
  console.log(`${adapter.id} ${name}: ${good ? "pass" : "FAIL"} (${describe(r)})`);
}
console.log(`${checks.length - failed} of ${checks.length} passed`);
process.exit(failed ? 1 : 0);
