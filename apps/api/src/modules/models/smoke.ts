// SPDX-License-Identifier: AGPL-3.0-only
// Manual check of the model adapter against real providers: one call each of text, a tool,
// typed output and an abort, per provider with a key set. It also answers what CI cannot:
// which model id each provider reports back. Spends a few cents at most. Keys come from the
// vault and are never printed. Set each one first, with the value on stdin:
//
//   bun apps/api/src/secrets.ts set provider.anthropic
//   bun apps/api/src/modules/models/smoke.ts
import { z } from "zod";
import { createVault, ensureRootKey } from "../credentials/index";
import { readSystemSecret } from "../credentials/system-secrets";
import { sdkDispatch, type DispatchRequest, type DispatchResult } from "./adapters/sdk";
import { isCliProvider } from "./domain/routes-check";
import { routesFor } from "./purposes";

const MAX_OUTPUT_TOKENS = 200;

const describe = (r: DispatchResult) =>
  r.ok
    ? `ok, model ${r.resolvedModel}, input ${r.usage.noCacheTokens + r.usage.cacheReadTokens + r.usage.cacheWriteTokens}, output ${r.usage.outputTokens}${r.reportedCostUsd === undefined ? "" : `, reported $${r.reportedCostUsd}`}`
    : `failed: ${r.family}`;

const vault = createVault({ rootKey: await ensureRootKey(), now: () => new Date() });
let tried = 0;
let failed = 0;
for (const c of routesFor("self_host").connection_test!.candidates) {
  if (isCliProvider(c.provider)) continue;
  const apiKey = await readSystemSecret(vault, `provider.${c.provider}`, "model_call");
  if (!apiKey) {
    console.log(`${c.provider}: skipped, provider.${c.provider} is not set`);
    continue;
  }
  tried++;
  const base: DispatchRequest = {
    provider: c.provider,
    model: c.model,
    apiKey,
    messages: [{ role: "user", content: "What is 2 + 2? Answer briefly." }],
    tools: [],
    maxOutputTokens: MAX_OUTPUT_TOKENS,
    abortSignal: AbortSignal.timeout(60_000),
  };
  const lookup = { name: "lookup", description: "Look up a fact.", class: "read" as const, inputSchema: z.object({ query: z.string() }) };
  const checks: [string, DispatchRequest, (r: DispatchResult) => boolean][] = [
    ["text", base, (r) => r.ok && r.text.length > 0],
    ["tool", { ...base, messages: [{ role: "user", content: "Use the lookup tool to find the capital of France." }], tools: [lookup] }, (r) => r.ok && r.toolCalls[0]?.toolName === "lookup"],
    ["typed", { ...base, output: z.object({ answer: z.number() }) }, (r) => r.ok && (r.output as { answer: number }).answer === 4],
    ["abort", { ...base, abortSignal: AbortSignal.abort() }, (r) => !r.ok && r.family === "no_receipt"],
  ];
  for (const [name, req, pass] of checks) {
    const r = await sdkDispatch(req);
    const good = pass(r);
    if (!good) failed++;
    console.log(`${c.provider} ${name}: ${good ? "pass" : "FAIL"} (${describe(r)})`);
  }
}
console.log(tried ? `${tried} provider(s), ${failed} failed check(s)` : "no provider key set");
process.exit(failed || !tried ? 1 : 0);
