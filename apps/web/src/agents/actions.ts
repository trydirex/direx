// SPDX-License-Identifier: AGPL-3.0-only
// The calls for reading a website into Brand, and how a run reads to a person. Each change returns
// the API's error code, or null when it worked.
import { queryOptions } from "@tanstack/react-query";
import type { components } from "../api/schema";
import { call, inWorkspace } from "../api/query";
import { api } from "../client";

type S = components["schemas"];
export type Run = S["AgentRun"];
export type RunDetail = S["AgentRunDetail"];
export type RunSettings = S["AgentSettings"];

const STATUS: Record<string, string> = {
  queued: "Waiting to start",
  running: "Reading",
  waiting: "Waiting",
  succeeded: "Finished",
  failed: "Stopped",
  cancelled: "Cancelled",
  timed_out: "Stopped: ran out of time",
  step_capped: "Stopped: reached its step limit",
  cost_capped: "Stopped: reached its cost limit",
  refused: "Not started",
  expired: "Expired",
};

const REASON: Record<string, string> = {
  daily_cap: "the daily limit is used up, and it carries on when the day turns",
  budget_stop: "this month's budget is used up, and it carries on next month",
  no_connection: "connect a model provider on the AI models page, then try again",
  credential_unavailable: "the model provider's key needs attention on the AI models page",
  no_route: "no model is available for this yet",
  free_text: "the model didn't return anything Direx could use",
  invalid_output: "the model didn't return anything Direx could use",
  model_refusal: "the model didn't return anything Direx could use",
  lease_lapsed: "the worker stopped twice before it finished",
  provider_quota: "the model provider's usage limit is used up, so try again once it resets",
};
/** Why a run that ended without finishing stopped, in a person's words. */
export const stopReason = (r: Pick<Run, "statusReason">) => (r.statusReason && REASON[r.statusReason]) || "something went wrong";

const PAGE_REASON: Record<string, string> = {
  bad_address: "that isn't a page address",
  other_site: "it's on another site",
  private_address: "it isn't a public address",
  not_linked: "it wasn't the address given or a link on a page already read",
  no_address: "the site couldn't be found",
  too_many_redirects: "it redirects too many times",
  not_text: "it isn't a text page",
  too_large: "it's too large",
  timed_out: "it took too long",
  bad_certificate: "its security certificate isn't valid",
  unreachable: "the site couldn't be reached",
  http_error: "the site returned an error",
};

const CHANGE_MESSAGES: Record<string, string> = {
  disabled: "Reading websites is turned off for this Workspace.",
  no_route: "No model is available for this yet.",
  not_allowed: "Only the person who started this read or an Admin can cancel it.",
  already_ended: "This read has already ended.",
  over_cloud_limit: "On Direx cloud the limits are at most 10 at once and 1,000 a day.",
};
export const sayChange = (code: string) => CHANGE_MESSAGES[code] ?? "That didn't go through. Try again.";

export const isLive = (r: Pick<Run, "status">) => ["queued", "running", "waiting"].includes(r.status);
export const statusLabel = (r: Pick<Run, "status" | "statusReason">) => {
  const label = STATUS[r.status] ?? r.status;
  if (!r.statusReason) return label;
  // A run that broke on Direx's side says what broke, as the worker recorded it.
  if (r.statusReason.startsWith("error: ")) return `${label}: Direx hit an error (${r.statusReason.slice("error: ".length)})`;
  return `${label}: ${REASON[r.statusReason] ?? "something went wrong"}`;
};
/** Reasons a run stopped before any model could take it on, so whether that model was tested doesn't apply. */
const NO_MODEL: readonly string[] = ["no_connection", "credential_unavailable", "no_route"];
/** The run used a model Direx hasn't tested on this job. */
export const untested = (r: Pick<Run, "unevaluated" | "statusReason">) => r.unevaluated && !NO_MODEL.includes(r.statusReason ?? "");
/** What a run cost: on a person's subscription nothing is billed per run, so it says that instead of $0.00. */
export const costWords = (r: { costMicros: string; subscription: boolean }) => (r.subscription ? "ran on your subscription" : `$${(Number(r.costMicros) / 1_000_000).toFixed(2)}`);
export const pageReason = (code: string) => PAGE_REASON[code] ?? "it couldn't be read";

const at = (workspaceId: string) => ({ path: { workspaceId } });
const on = (workspaceId: string, id: string) => ({ path: { workspaceId, id } });
const agent = (workspaceId: string) => ({ path: { workspaceId, agent: "brand_reader" as const } });

export async function startRead(workspaceId: string, input: { url: string } | { text: string }): Promise<string | null> {
  const { error } = await api.POST("/api/w/{workspaceId}/agents/brand_reader/runs", { params: at(workspaceId), body: input });
  return error ? error.error : null;
}

// A docs tool's pages (Notion first), read for brand facts by the brand reader.
export const docsQuery = (workspaceId: string) => queryOptions({ queryKey: inWorkspace(workspaceId, "docs"), queryFn: () => call(api.GET("/api/w/{workspaceId}/docs", { params: at(workspaceId) })) });
export async function docsPages(workspaceId: string) {
  const { data, error } = await api.GET("/api/w/{workspaceId}/docs/pages", { params: at(workspaceId) });
  return data ?? { error: error?.error ?? "failed" };
}
export async function readDocsPage(workspaceId: string, pageId: string) {
  const { data, error } = await api.POST("/api/w/{workspaceId}/docs/pages/{pageId}/read", { params: { path: { workspaceId, pageId } } });
  return data ?? { error: error?.error ?? "failed" };
}

/** The same address or text on the same day gets the read already there, and starts nothing. */
export const noNewRun = (before: Pick<Run, "id">[], after: Pick<Run, "id">[]) => after.every((r) => before.some((b) => b.id === r.id));

export async function listRuns(workspaceId: string, agent?: string): Promise<Run[]> {
  const { data } = await api.GET("/api/w/{workspaceId}/agents/runs", { params: { ...at(workspaceId), ...(agent && { query: { agent } }) } });
  return data?.runs ?? [];
}

/** The latest runs, of one agent when named. A failed read of the list shows as no runs, as it did before the query layer. */
export const runsQuery = (workspaceId: string, agent?: string) =>
  queryOptions({ queryKey: inWorkspace(workspaceId, "agents", "runs", ...(agent ? [agent] : [])), queryFn: () => listRuns(workspaceId, agent) });

export async function runDetail(workspaceId: string, id: string): Promise<RunDetail | undefined> {
  const { data } = await api.GET("/api/w/{workspaceId}/agents/runs/{id}", { params: on(workspaceId, id) });
  return data;
}

export async function cancelRun(workspaceId: string, id: string): Promise<string | null> {
  const { error } = await api.POST("/api/w/{workspaceId}/agents/runs/{id}/cancel", { params: on(workspaceId, id) });
  return error ? error.error : null;
}

export async function readSettings(workspaceId: string): Promise<RunSettings | undefined> {
  const { data } = await api.GET("/api/w/{workspaceId}/agents/{agent}/settings", { params: agent(workspaceId) });
  return data;
}

export async function saveRunSettings(workspaceId: string, body: { enabled?: boolean; maxConcurrentRuns?: number; maxDailyRuns?: number }): Promise<string | null> {
  const { error } = await api.PATCH("/api/w/{workspaceId}/agents/{agent}/settings", { params: agent(workspaceId), body });
  return error ? error.error : null;
}
