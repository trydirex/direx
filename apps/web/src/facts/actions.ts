// SPDX-License-Identifier: AGPL-3.0-only
// The Brand calls, and how facts sort into the page. Each change returns the API's error code,
// or null when it worked.
import { queryOptions } from "@tanstack/react-query";
import type { components } from "../api/schema";
import { call, inWorkspace } from "../api/query";
import { api } from "../client";
import type { Item } from "../items/actions";

type S = components["schemas"];
export type Fact = S["Fact"];
export type FactVersion = S["FactVersion"];
export type Field = Fact["field"];

export const FIELD_LABEL: Record<Field, string> = {
  what_you_sell: "What you sell",
  who_buys: "Who buys",
  tone: "Tone",
  price: "Prices",
  claim: "Approved claims",
  never_say: "Never say",
  competitor: "Competitors",
};
export const SINGLE: Field[] = ["what_you_sell", "who_buys", "tone"];
export const MANY: Field[] = ["price", "claim", "never_say"];

export const sourceLabel = (s: Fact["source"]) => (s.kind === "person" ? `Added by ${s.label}` : `From ${s.label}`);

const at = (workspaceId: string) => ({ path: { workspaceId } });

export async function list(workspaceId: string): Promise<Fact[]> {
  const { data } = await api.GET("/api/w/{workspaceId}/facts", { params: at(workspaceId) });
  return data?.facts ?? [];
}

export const factsQuery = (workspaceId: string) =>
  queryOptions({ queryKey: inWorkspace(workspaceId, "facts"), queryFn: async () => (await call(api.GET("/api/w/{workspaceId}/facts", { params: at(workspaceId) }))).facts });

const byKind = (items: Item[]) => ({ conflicts: items.filter((i) => i.kind === "fact_conflict"), proposals: items.filter((i) => i.kind === "fact_proposal") });

/** Fact conflicts and proposals waiting for a person. */
export const factItemsQuery = (workspaceId: string) =>
  queryOptions({
    queryKey: inWorkspace(workspaceId, "items", "facts"),
    queryFn: async () => byKind((await call(api.GET("/api/w/{workspaceId}/items", { params: { ...at(workspaceId), query: { state: "needs_approval", limit: 200 } } }))).items),
  });

/** What is waiting for a person on this page. */
export async function waiting(workspaceId: string): Promise<{ conflicts: Item[]; proposals: Item[] }> {
  const { data } = await api.GET("/api/w/{workspaceId}/items", { params: { ...at(workspaceId), query: { state: "needs_approval", limit: 200 } } });
  return byKind(data?.items ?? []);
}

/** A fact's earlier versions, read only once someone opens its History. */
export const versionsQuery = (workspaceId: string, id: string) =>
  queryOptions({ queryKey: inWorkspace(workspaceId, "facts", id, "versions"), queryFn: async () => (await call(api.GET("/api/w/{workspaceId}/facts/{id}/versions", { params: { path: { workspaceId, id } } }))).versions });

export async function versions(workspaceId: string, id: string): Promise<FactVersion[]> {
  const { data } = await api.GET("/api/w/{workspaceId}/facts/{id}/versions", { params: { path: { workspaceId, id } } });
  return data?.versions ?? [];
}

export type NewValue = { field: Field; subject?: string; value: string };

export async function save(workspaceId: string, v: NewValue & { expectedVersion?: number }): Promise<string | null> {
  const { error } = await api.POST("/api/w/{workspaceId}/facts", { params: at(workspaceId), body: v });
  return error ? error.error : null;
}

export async function suggest(workspaceId: string, v: NewValue): Promise<string | null> {
  const { error } = await api.POST("/api/w/{workspaceId}/facts/proposals", { params: at(workspaceId), body: v });
  return error ? error.error : null;
}

export async function retire(workspaceId: string, id: string): Promise<string | null> {
  const { error } = await api.POST("/api/w/{workspaceId}/facts/{id}/retire", { params: { path: { workspaceId, id } } });
  return error ? error.error : null;
}

// Voice (ADR 0022): how drafts should sound, kept apart from what they may claim.
export type VoiceEntry = S["VoiceEntry"];
export const voiceQuery = (workspaceId: string) =>
  queryOptions({ queryKey: inWorkspace(workspaceId, "voice"), queryFn: async () => call(api.GET("/api/w/{workspaceId}/voice", { params: at(workspaceId) })) });

export async function addSwap(workspaceId: string, avoid: string, prefer: string): Promise<string | null> {
  const { error } = await api.POST("/api/w/{workspaceId}/voice/swaps", { params: at(workspaceId), body: { avoid, prefer } });
  return error ? error.error : null;
}
export async function addExample(workspaceId: string, text: string): Promise<string | null> {
  const { error } = await api.POST("/api/w/{workspaceId}/voice/examples", { params: at(workspaceId), body: { text } });
  return error ? error.error : null;
}
export async function retireVoice(workspaceId: string, id: string): Promise<string | null> {
  const { error } = await api.POST("/api/w/{workspaceId}/voice/{id}/retire", { params: { path: { workspaceId, id } } });
  return error ? error.error : null;
}
