// SPDX-License-Identifier: AGPL-3.0-only
// The only import of the AI SDK and its providers. One call, SDK retries off, no step loop,
// and failures returned as values. A provider's error text never leaves this file, since
// it can echo the key.
import { createAnthropic } from "@ai-sdk/anthropic";
import { createGoogleGenerativeAI } from "@ai-sdk/google";
import { createOpenAI } from "@ai-sdk/openai";
import { createOpenRouter } from "@openrouter/ai-sdk-provider";
import { APICallError, generateText, NoObjectGeneratedError, NoOutputGeneratedError, Output, tool } from "ai";
import type { ZodType } from "zod";
import type { Usage } from "../domain/cost";
import type { ErrorFamily } from "../domain/errors";
import type { Provider } from "../domain/routes-check";
import type { ToolClass } from "../domain/trust";

export type ToolDef = { name: string; description: string; class: ToolClass; inputSchema: ZodType };
export type ToolCall = { toolName: string; input: unknown };

export type DispatchRequest = {
  provider: Provider;
  model: string;
  apiKey: string;
  baseURL?: string;
  system?: string;
  messages: { role: "user"; content: string }[];
  tools: readonly ToolDef[];
  output?: ZodType;
  maxOutputTokens: number;
  abortSignal: AbortSignal;
  /** For a CLI that refreshes its own sign-in. */
  replaceKey?: (value: string) => Promise<void>;
};

/** `tokensUnknown` is for a CLI that reported no counts: the zeros mean nothing and aren't recorded. */
export type DispatchUsage = Usage & { reasoningTokens: number; tokensUnknown?: boolean };

export type DispatchResult =
  | {
      ok: true;
      text: string;
      output: unknown;
      toolCalls: ToolCall[];
      usage: DispatchUsage;
      resolvedModel: string;
      providerRequestId?: string;
      /** A cost the provider itself reported, in dollars. */
      reportedCostUsd?: number;
    }
  /** The provider answered and charged, but gave nothing usable. */
  | { ok: false; family: "model_refusal"; usage: DispatchUsage | null; /** Which fields missed the schema, by path and code only: never the model's words. */ reason?: string }
  /** `definite` means the provider said no and charged nothing; otherwise nobody knows. */
  | { ok: false; family: ErrorFamily; definite: boolean; retryNotBefore?: Date; /** Why, in words a person can act on. Never holds a credential. */ reason?: string };

export type Dispatch = (r: DispatchRequest) => Promise<DispatchResult>;

function languageModel(r: DispatchRequest) {
  const { apiKey, baseURL } = r;
  switch (r.provider) {
    case "anthropic":
      return createAnthropic({ apiKey, baseURL })(r.model);
    case "openai":
      return createOpenAI({ apiKey, baseURL })(r.model);
    case "google":
      return createGoogleGenerativeAI({ apiKey, baseURL })(r.model);
    case "openrouter":
      return createOpenRouter({ apiKey, baseURL }).chat(r.model, {
        provider: { allow_fallbacks: false, data_collection: "deny" },
        usage: { include: true },
      });
    case "claude_code":
    case "codex":
      throw new Error("a CLI provider goes through its adapter, not the SDK");
  }
}

type SdkUsage = {
  inputTokens?: number;
  outputTokens?: number;
  inputTokenDetails?: { noCacheTokens?: number; cacheReadTokens?: number; cacheWriteTokens?: number };
  outputTokenDetails?: { reasoningTokens?: number };
};

function usageOf(u: SdkUsage): DispatchUsage {
  const cacheReadTokens = u.inputTokenDetails?.cacheReadTokens ?? 0;
  const cacheWriteTokens = u.inputTokenDetails?.cacheWriteTokens ?? 0;
  return {
    noCacheTokens: u.inputTokenDetails?.noCacheTokens ?? Math.max((u.inputTokens ?? 0) - cacheReadTokens - cacheWriteTokens, 0),
    cacheReadTokens,
    cacheWriteTokens,
    outputTokens: u.outputTokens ?? 0,
    reasoningTokens: u.outputTokenDetails?.reasoningTokens ?? 0,
  };
}

function retryAfter(headers: Record<string, string> | undefined): Date | undefined {
  const raw = headers?.["retry-after"];
  const seconds = Number(raw);
  return raw !== undefined && Number.isFinite(seconds) && seconds >= 0 ? new Date(Date.now() + seconds * 1000) : undefined;
}

function failure(e: unknown): DispatchResult {
  if (NoObjectGeneratedError.isInstance(e)) return { ok: false, family: "model_refusal", usage: e.usage ? usageOf(e.usage) : null };
  if (NoOutputGeneratedError.isInstance(e)) return { ok: false, family: "model_refusal", usage: null };
  if (APICallError.isInstance(e) && e.statusCode !== undefined) {
    const s = e.statusCode;
    if (s === 429) return { ok: false, family: "provider_quota", definite: true, retryNotBefore: retryAfter(e.responseHeaders) };
    if (s >= 500) return { ok: false, family: "transient_upstream", definite: true, retryNotBefore: retryAfter(e.responseHeaders) };
    return { ok: false, family: "configuration", definite: true };
  }
  return { ok: false, family: "no_receipt", definite: false };
}

export const sdkDispatch: Dispatch = async (r) => {
  try {
    const result = await generateText({
      model: languageModel(r),
      system: r.system,
      messages: r.messages,
      tools: Object.fromEntries(r.tools.map((t) => [t.name, tool({ description: t.description, inputSchema: t.inputSchema })])),
      output: r.output ? Output.object({ schema: r.output }) : undefined,
      maxOutputTokens: r.maxOutputTokens,
      maxRetries: 0,
      abortSignal: r.abortSignal,
    });
    const usage = usageOf(result.usage);
    if (result.finishReason === "content-filter") return { ok: false, family: "model_refusal", usage };
    const openrouter = result.providerMetadata?.openrouter as { usage?: { cost?: number } } | undefined;
    return {
      ok: true,
      text: result.text,
      output: r.output ? result.output : undefined,
      toolCalls: result.toolCalls.map((c) => ({ toolName: c.toolName, input: c.input })),
      usage,
      resolvedModel: result.response.modelId,
      providerRequestId: result.response.id,
      reportedCostUsd: openrouter?.usage?.cost,
    };
  } catch (e) {
    return failure(e);
  }
};
