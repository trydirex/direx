// SPDX-License-Identifier: AGPL-3.0-only
// A docs tool's database imported to the Calendar (Notion first): the databases shared with Direx, one's
// columns and mapping, a preview of each row, and the import.
import { queryOptions } from "@tanstack/react-query";
import type { components } from "../api/schema";
import { call, inWorkspace } from "../api/query";
import { api } from "../client";

export type Column = components["schemas"]["DocsColumn"];
export type Mapping = NonNullable<components["schemas"]["DocsMapping"]>;
export type RowPlan = components["schemas"]["DocsRowPlan"];
type Failed = { error: string };
const at = (workspaceId: string) => ({ path: { workspaceId } });
const failed = (e?: { error?: string }): Failed => ({ error: e?.error ?? "failed" });

export async function databases(workspaceId: string) {
  const { data, error } = await api.GET("/api/w/{workspaceId}/docs/databases", { params: at(workspaceId) });
  return data ?? failed(error);
}
export async function database(workspaceId: string, databaseId: string) {
  const { data, error } = await api.GET("/api/w/{workspaceId}/docs/databases/{databaseId}", { params: { path: { workspaceId, databaseId } } });
  return data ?? failed(error);
}
export async function saveMapping(workspaceId: string, databaseId: string, body: Mapping) {
  const { data, error } = await api.PUT("/api/w/{workspaceId}/docs/databases/{databaseId}/mapping", { params: { path: { workspaceId, databaseId } }, body });
  return data ?? failed(error);
}
export async function preview(workspaceId: string, sourceId: string) {
  const { data, error } = await api.POST("/api/w/{workspaceId}/docs/sources/{sourceId}/preview", { params: { path: { workspaceId, sourceId } } });
  return data ?? failed(error);
}
export async function runImport(workspaceId: string, sourceId: string) {
  const { data, error } = await api.POST("/api/w/{workspaceId}/docs/sources/{sourceId}/import", { params: { path: { workspaceId, sourceId } } });
  return data ?? failed(error);
}

// Status write-back for one source (ADR 0025): where it stands, its columns, the yes or no, and the stop.
export type WriteBack = NonNullable<components["schemas"]["DocsWriteBack"]>;
export type WriteBackState = components["schemas"]["DocsWriteBackState"];
const source = (workspaceId: string, sourceId: string) => ({ params: { path: { workspaceId, sourceId } } });
/** Every imported source with its write-back state, read from Direx alone, so any member can reach Stop. */
export const writeBackSourcesQuery = (workspaceId: string) => queryOptions({ queryKey: inWorkspace(workspaceId, "docs", "sources"), queryFn: () => call(api.GET("/api/w/{workspaceId}/docs/sources", { params: at(workspaceId) })) });
/** A yes not yet stopped, live or paused: what Stop can end. */
export const stoppable = (s: WriteBackState) => s.grant?.answer === "yes" && !s.grant.stoppedAt;
export async function writeBackState(workspaceId: string, sourceId: string) {
  const { data, error } = await api.GET("/api/w/{workspaceId}/docs/sources/{sourceId}/write-back", source(workspaceId, sourceId));
  return data ?? failed(error);
}
export async function saveWriteBack(workspaceId: string, sourceId: string, body: WriteBack) {
  const { data, error } = await api.PUT("/api/w/{workspaceId}/docs/sources/{sourceId}/write-back", { ...source(workspaceId, sourceId), body });
  return data ?? failed(error);
}
export async function answerWriteBack(workspaceId: string, sourceId: string, body: { answer: "yes" | "no"; wordingVersion: string }) {
  const { data, error } = await api.POST("/api/w/{workspaceId}/docs/sources/{sourceId}/write-back/grant", { ...source(workspaceId, sourceId), body });
  return data ?? failed(error);
}
export async function stopWriteBack(workspaceId: string, sourceId: string, reason: string) {
  const { data, error } = await api.POST("/api/w/{workspaceId}/docs/sources/{sourceId}/write-back/stop", { ...source(workspaceId, sourceId), body: { reason } });
  return data ?? failed(error);
}

/** Why a write-back is held or Blocked, in words: the ledger's reason, or for a refusal the docs tool's. */
const WRITE: Record<string, string> = {
  docs_write_not_granted: "status write-back is off for this database",
  superseded: "a newer status replaced it",
  option_gone: "the mapping no longer has that option",
  late: "it is more than a day late",
  outcome_unknown: "not sure it was written",
  snapshot_changed: "what it was approved under changed",
  approval_invalid: "its approval no longer holds",
  approval_expired: "approval expired",
  keys_unavailable: "Direx can't read the Notion key",
  provider_rejected: "Notion refused it",
  workspace_deleted: "the Workspace was deleted",
  cant_edit: "the Notion connection can't edit this database. Give Direx's integration the Update content capability",
  row_gone: "the row is gone or no longer shared with Direx",
  changed_in_source: "someone changed the status in Notion, so Direx left it",
  column_gone: "the status column is gone",
  needs_reconnecting: "the Notion key no longer works. Replace it in Settings",
  rejected: "Notion refused the change",
};
export const writeWords = (w: { state: "held" | "blocked"; reason: string; detail: string | null }) =>
  `${w.state === "held" ? "Held" : "Blocked"}: ${WRITE[w.reason === "provider_refused_permanently" ? (w.detail ?? "") : w.reason] ?? "Notion refused it"}.`;

/** Each refusal and skip reason in words. */
const SAY: Record<string, string> = {
  not_connected: "Connect Notion in Settings first.",
  needs_reconnecting: "The Notion key no longer works. Replace it in Settings.",
  no_access: "Direx can't see that database. Share it with Direx's integration in Notion.",
  busy: "Notion is busy right now. Try again in a minute.",
  date_not_a_date: "The date column must be a Date column.",
  channel_not_a_choice: "The channel column must be a Select or Status column.",
  text_not_text: "The text column must be a Text or Title column.",
  unknown_channel_value: "A channel value isn't in that column any more. Pick the accounts again.",
  unknown_account: "An account isn't connected any more. Pick the accounts again.",
  no_date: "No date",
  past_date: "Date has passed",
  no_channel: "Channel not matched to an account",
  no_text: "No text",
  refused_by_network: "The network refused it",
  forbidden: "Only an Owner or Admin can do that.",
  status_not_a_choice: "The status column must be a Status or Select column.",
  unknown_option: "An option isn't in the status column any more. Pick the options again.",
  url_not_a_link: "The link column must be a URL column.",
  no_write_back: "Save the status columns first.",
  stale_wording: "The question changed. Read it again and answer.",
  already_on: "Status write-back is already on.",
  not_on: "Status write-back is already off.",
};
export const say = (code: string) => SAY[code] ?? "That didn't work. Try again.";
