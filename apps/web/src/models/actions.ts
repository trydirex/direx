// SPDX-License-Identifier: AGPL-3.0-only
// The calls the Models page makes. Each change returns the API's error code, or null when it
// worked. Amounts come as strings of micro-dollars and are shown as dollars.
import { queryOptions } from "@tanstack/react-query";
import type { components } from "../api/schema";
import { call, inWorkspace } from "../api/query";
import { api } from "../client";

type S = components["schemas"];
export type Provider = S["ModelProvider"];
export type ProviderRow = S["ModelProviderRow"];
export type Usage = S["ModelUsage"];
export type Settings = S["ModelSettings"];

const MICROS_PER_DOLLAR = 1_000_000;

export const PROVIDER_NAMES: Record<Provider, string> = { anthropic: "Anthropic", openai: "OpenAI", google: "Google Gemini", openrouter: "OpenRouter" };

export const dollars = (micros: string, places = 2) => `$${(Number(micros) / MICROS_PER_DOLLAR).toFixed(places)}`;

/** A whole or decimal dollar amount as micro-dollars, or null when it isn't one. */
export function toMicros(amount: string): string | null {
  const m = amount.trim().match(/^\$?(\d+)(?:\.(\d{1,6}))?$/);
  return m ? (BigInt(m[1]!) * BigInt(MICROS_PER_DOLLAR) + BigInt((m[2] ?? "").padEnd(6, "0"))).toString() : null;
}

const at = (workspaceId: string) => ({ path: { workspaceId } });
const on = (workspaceId: string, provider: Provider) => ({ path: { workspaceId, provider } });

export type ModelsData = { deployment: "cloud" | "self_host"; providers: ProviderRow[]; usage: Usage; settings: Settings; keys: S["Credential"][] };

/** Providers, this month's cost, the budget and, for someone who may pick one, the Workspace API keys. */
export const modelsQuery = (workspaceId: string, manage: boolean) =>
  queryOptions({
    queryKey: inWorkspace(workspaceId, "models", manage),
    queryFn: async (): Promise<ModelsData> => {
      const params = at(workspaceId);
      const [conn, usage, settings, creds] = await Promise.all([
        call(api.GET("/api/w/{workspaceId}/models/connections", { params })),
        call(api.GET("/api/w/{workspaceId}/models/usage", { params: { ...params, query: {} } })),
        call(api.GET("/api/w/{workspaceId}/models/settings", { params })),
        manage ? call(api.GET("/api/w/{workspaceId}/credentials", { params })) : undefined,
      ]);
      const keys = creds?.credentials.filter((c) => c.scope === "workspace" && c.kind === "api_key" && c.status === "active") ?? [];
      return { deployment: conn.deployment, providers: conn.providers, usage, settings, keys };
    },
  });

export async function setKey(workspaceId: string, provider: Provider, credentialId: string): Promise<string | null> {
  const { error } = await api.PUT("/api/w/{workspaceId}/models/connections/{provider}", { params: on(workspaceId, provider), body: { credentialId } });
  return error ? error.error : null;
}

export async function clearKey(workspaceId: string, provider: Provider): Promise<string | null> {
  const { error } = await api.DELETE("/api/w/{workspaceId}/models/connections/{provider}", { params: on(workspaceId, provider) });
  return error ? error.error : null;
}

/** Null when the key worked; otherwise why not. */
export async function testKey(workspaceId: string, provider: Provider): Promise<string | null> {
  const { data, error } = await api.POST("/api/w/{workspaceId}/models/connections/{provider}/test", { params: on(workspaceId, provider) });
  if (error) return error.error;
  return data.ok ? null : (data.reason ?? "no_receipt");
}

/** Picks a saved key for the provider and tests it. A key the provider refuses is taken back off, so it never shows as ready. */
export async function pickKey(workspaceId: string, provider: Provider, credentialId: string): Promise<string | null> {
  const failed = (await setKey(workspaceId, provider, credentialId)) ?? (await testKey(workspaceId, provider));
  if (failed) await clearKey(workspaceId, provider);
  return failed;
}

/** Saves a pasted API key as a Workspace key, picks it for the provider and tests it. A refused key is deleted again. Null when all three worked. */
export async function addKey(workspaceId: string, provider: Provider, value: string): Promise<string | null> {
  const { data, error } = await api.POST("/api/w/{workspaceId}/credentials", {
    params: at(workspaceId),
    // The stored key's id must be unique, and a second paste for the same provider is a new key.
    body: { scope: "workspace", kind: "api_key", key: `model_${provider}_${Date.now().toString(36)}`, name: `${PROVIDER_NAMES[provider]} key`, value: { key: value } },
  });
  if (error) return error.error;
  const failed = await pickKey(workspaceId, provider, data.credential.id);
  if (failed) await api.DELETE("/api/w/{workspaceId}/credentials/{id}", { params: { path: { workspaceId, id: data.credential.id } } });
  return failed;
}

/** Whole dollars and cents; a cost too small for a cent says so rather than showing $0.00. */
export const cost = (micros: string | number) => {
  const shown = dollars(String(micros));
  return shown === "$0.00" && Number(micros) > 0 ? "Under $0.01" : shown;
};

export async function saveSettings(workspaceId: string, body: Settings): Promise<string | null> {
  const { error } = await api.PUT("/api/w/{workspaceId}/models/settings", { params: at(workspaceId), body });
  return error ? error.error : null;
}

export type AdapterId = S["ModelAdapterId"];
export type AdapterRow = S["ModelAdapter"];
export type Choice = { adapter: AdapterId | null; model: string | null };
export type AdapterList = { choice: { adapter: string; model: string | null } | null; agents: { agent: string; adapter: string; model: string | null }[]; adapters: AdapterRow[] };
export type SignInStart = S["ModelSignInStart"];

// ponytail: agents are code in several modules, so a new one needs a line here to get a row.
export const AGENT_NAMES: Record<string, string> = {
  brand_reader: "Brand reader",
  strategy_drafter: "Strategy drafter",
  plan_drafter: "Plan drafter",
  campaign_drafter: "Campaign drafter",
  recipient_reader: "Website reader",
  recipient_writer: "Email drafter",
};

// ponytail: purposes are free strings set where a model is called, so a new one shows its raw id until it gets a line here.
const PURPOSE_NAMES: Record<string, string> = {
  ask: "Answering questions in Ask Direx",
  brand_extract: "Reading your website for Brand",
  campaign_draft: "Drafting Campaigns",
  claim_check: "Checking claims in drafts",
  clip_pick: "Picking clips",
  connection_test: "Checking a model works",
  dispatch_check: "Checking before sending",
  injection_check: "Checking pages for planted instructions",
  lesson_check: "Checking Lessons",
  optout_detect: "Reading replies for opt-outs",
  plan_draft: "Drafting plans",
  recipient_read: "Reading company websites",
  recipient_write: "Writing each person's email",
  result_why: "Explaining your results",
  seo_brief: "Writing SEO Briefs",
};

/** What a model call was for, in words. */
export const purposeName = (purpose: string) => PURPOSE_NAMES[purpose] ?? AGENT_NAMES[purpose] ?? purpose;

const forAdapter =(workspaceId: string, adapter: AdapterId) => ({ path: { workspaceId, adapter } });

export const adaptersQuery = (workspaceId: string) =>
  queryOptions({ queryKey: inWorkspace(workspaceId, "models", "adapters"), queryFn: (): Promise<AdapterList> => call(api.GET("/api/w/{workspaceId}/models/adapters", { params: at(workspaceId) })) });

export async function chooseAdapter(workspaceId: string, body: Choice): Promise<string | null> {
  const { error } = await api.PUT("/api/w/{workspaceId}/models/adapter", { params: at(workspaceId), body });
  return error ? error.error : null;
}

export async function chooseForAgent(workspaceId: string, agent: string, body: Choice): Promise<string | null> {
  const { error } = await api.PUT("/api/w/{workspaceId}/models/agents/{agent}/adapter", { params: { path: { workspaceId, agent } }, body });
  return error ? error.error : null;
}

/** Starts a sign-in that a person finishes in their browser. */
export async function startSignIn(workspaceId: string, adapter: AdapterId, shared: boolean): Promise<SignInStart | { error: string }> {
  const params = forAdapter(workspaceId, adapter);
  const { data, error } = shared
    ? await api.POST("/api/w/{workspaceId}/models/adapters/{adapter}/sign-in/shared", { params })
    : await api.POST("/api/w/{workspaceId}/models/adapters/{adapter}/sign-in/personal", { params });
  return data ?? { error: error?.error ?? "no_link" };
}

export async function finishSignIn(workspaceId: string, id: string, code: string | null): Promise<string | null> {
  const { error } = await api.POST("/api/w/{workspaceId}/models/sign-ins/{id}/finish", { params: { path: { workspaceId, id } }, body: { code } });
  return error ? error.error : null;
}

export async function signOut(workspaceId: string, adapter: AdapterId, shared: boolean): Promise<string | null> {
  const params = forAdapter(workspaceId, adapter);
  const { error } = shared
    ? await api.DELETE("/api/w/{workspaceId}/models/adapters/{adapter}/sign-in/shared", { params })
    : await api.DELETE("/api/w/{workspaceId}/models/adapters/{adapter}/sign-in/personal", { params });
  return error ? error.error : null;
}

/** Null when the sign-in worked; otherwise why not. */
export async function testAdapter(workspaceId: string, adapter: AdapterId): Promise<string | null> {
  const { data, error } = await api.POST("/api/w/{workspaceId}/models/adapters/{adapter}/test", { params: forAdapter(workspaceId, adapter) });
  if (error) return error.error;
  return data.ok ? null : (data.reason ?? "no_receipt");
}
