// SPDX-License-Identifier: AGPL-3.0-only
import { expect, test } from "vitest";
import { z } from "zod";
import { resultOf } from "./adapters/runtime/envelope";
import type { DispatchRequest } from "./adapters/sdk";

const usage = { noCacheTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 1, reasoningTokens: 0 };
const request = { tools: [], output: z.strictObject({ kind: z.enum(["price", "promise"]), n: z.number() }) } as unknown as DispatchRequest;

test("an answer that misses its schema is refused, naming the fields and never the model's words", () => {
  const r = resultOf(request, { answer: JSON.stringify({ kind: "SECRET-WORDS", n: "7", extra: 1 }), tool: null, tool_input: null }, usage, "m");
  expect(r).toMatchObject({ ok: false, family: "model_refusal" });
  const reason = (r as { reason?: string }).reason!;
  expect(reason).toContain("kind invalid_value");
  expect(reason).toContain("n invalid_type");
  expect(reason).not.toContain("SECRET-WORDS");
});

test("an answer that fits its schema comes back typed", () => {
  expect(resultOf(request, { answer: JSON.stringify({ kind: "price", n: 7 }), tool: null, tool_input: null }, usage, "m")).toMatchObject({ ok: true, output: { kind: "price", n: 7 } });
});

test("an envelope that doesn't fit, or holds no answer, says so without the model's words", () => {
  const bad = resultOf(request, { answer: { said: "SECRET-WORDS" }, tool: null, tool_input: null }, usage, "m") as { reason?: string };
  expect(bad.reason).toMatch(/^envelope: answer /);
  expect(bad.reason).not.toContain("SECRET-WORDS");
  expect(resultOf(request, { answer: null, tool: null, tool_input: null }, usage, "m")).toMatchObject({ ok: false, reason: "envelope: no answer" });
});

test("a tool call that misses its input schema is refused, naming the tool and fields and never the model's words", () => {
  const tools = { tools: [{ name: "propose", description: "", class: "read", inputSchema: z.strictObject({ at: z.iso.datetime() }) }] } as unknown as DispatchRequest;
  const r = resultOf(tools, { answer: null, tool: "propose", tool_input: JSON.stringify({ at: "SECRET-WORDS" }) }, usage, "m") as { reason?: string };
  expect(r.reason).toBe("tool: propose input: at invalid_format");
  expect(resultOf(tools, { answer: null, tool: "send_email", tool_input: "{}" }, usage, "m")).toMatchObject({ ok: false, reason: 'tool: no tool "send_email"' });
});

test("a nested object sent as a JSON string is read once as that object; one that still doesn't fit is refused", () => {
  const tools = { tools: [{ name: "propose", description: "", class: "read", inputSchema: z.strictObject({ reply: z.strictObject({ kind: z.literal("answer") }) }) }] } as unknown as DispatchRequest;
  expect(resultOf(tools, { answer: null, tool: "propose", tool_input: JSON.stringify({ reply: JSON.stringify({ kind: "answer" }) }) }, usage, "m")).toMatchObject({ ok: true, toolCalls: [{ toolName: "propose", input: { reply: { kind: "answer" } } }] });
  expect(resultOf(tools, { answer: null, tool: "propose", tool_input: JSON.stringify({ reply: JSON.stringify({ kind: "done" }) }) }, usage, "m")).toMatchObject({ ok: false, family: "model_refusal" });
});

test("a whole tool input sent as a JSON string inside the string is read once as that object", () => {
  const tools = { tools: [{ name: "propose", description: "", class: "read", inputSchema: z.strictObject({ n: z.number() }) }] } as unknown as DispatchRequest;
  expect(resultOf(tools, { answer: null, tool: "propose", tool_input: JSON.stringify(JSON.stringify({ n: 1 })) }, usage, "m")).toMatchObject({ ok: true, toolCalls: [{ input: { n: 1 } }] });
});
