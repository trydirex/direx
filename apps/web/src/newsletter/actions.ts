// SPDX-License-Identifier: AGPL-3.0-only
// The newsletter calls the page makes. Each save returns the API's error code, or null when it worked.
import { queryOptions } from "@tanstack/react-query";
import type { components } from "../api/schema";
import { messageForCode } from "../api/messages";
import { call, inWorkspace } from "../api/query";
import { api } from "../client";

type S = components["schemas"];
export type NewsletterSettings = S["NewsletterSettings"];
export type SettingsInput = S["NewsletterSettingsInput"];
export type Platform = { connection: string; name: string; credentialId: string | null; hasLists: boolean; listId: string | null; listName: string | null };
export type SettingsPage = { settings: NewsletterSettings | null; platforms: Platform[]; lists: { credentialId: string; connection: string; name: string }[]; nextSlot: string | null; quiet: boolean; subscriberCount: number | null };
export type AccountList = S["NewsletterAccountList"];

const at = (workspaceId: string) => ({ path: { workspaceId } });

export const settingsQuery = (workspaceId: string) =>
  queryOptions({ queryKey: inWorkspace(workspaceId, "newsletter", "settings"), queryFn: async (): Promise<SettingsPage> => call(api.GET("/api/w/{workspaceId}/newsletter/settings", { params: at(workspaceId) })) });

export async function saveSettings(workspaceId: string, body: SettingsInput): Promise<string | null> {
  const { error } = await api.PUT("/api/w/{workspaceId}/newsletter/settings", { params: at(workspaceId), body });
  return error ? error.error : null;
}

const key = (workspaceId: string, credentialId: string) => ({ path: { workspaceId, credentialId } });

/** The lists in the account behind a newsletter key, or the error code. */
export async function accountLists(workspaceId: string, credentialId: string): Promise<AccountList[] | string> {
  const { data, error } = await api.GET("/api/w/{workspaceId}/newsletter/keys/{credentialId}/lists", { params: key(workspaceId, credentialId) });
  return data?.lists ?? error!.error;
}

export const accountListsQuery = (workspaceId: string, credentialId: string) =>
  queryOptions({
    queryKey: inWorkspace(workspaceId, "newsletter", "keys", credentialId, "lists"),
    queryFn: async () => (await call(api.GET("/api/w/{workspaceId}/newsletter/keys/{credentialId}/lists", { params: key(workspaceId, credentialId) }))).lists,
  });

/** Saves which list gets the newsletter. The error code, or null when it worked. */
export async function chooseList(workspaceId: string, credentialId: string, listId: string): Promise<string | null> {
  const { error } = await api.PUT("/api/w/{workspaceId}/newsletter/keys/{credentialId}/list", { params: key(workspaceId, credentialId), body: { listId } });
  return error ? error.error : null;
}

export const MESSAGES: Record<string, string> = {
  list_not_connected: "That list isn't connected to this Workspace any more. Connect it again, or pick another.",
  bad_time_zone: "That time zone isn't one we know. Try a name such as Europe/Berlin.",
  not_listed: "That list isn't in the account any more. Pick another.",
  no_lists: "This tool has one list per account, so there's nothing to choose.",
  tool_unreachable: "Direx couldn't reach the tool to read its lists. Try again in a minute.",
};
export const say = (error: string) => messageForCode(error, MESSAGES);

export const WEEKDAYS = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"] as const;

/** "Tuesday 10 November, 09:00", in the newsletter's own time zone. */
export const slotWords = (iso: string, timeZone: string) =>
  new Intl.DateTimeFormat("en-GB", { timeZone, weekday: "long", day: "numeric", month: "long", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(new Date(iso)).replace(" at", ",");

/** "Goes to Founders, 340 subscribers": the list the settings name, the count only when the tool gave one. */
export function audienceWords(page: SettingsPage): string | null {
  const s = page.settings;
  if (!s) return null;
  const platform = page.platforms.find((p) => p.credentialId === s.credentialId);
  const name = s.list === "substack" ? "your Substack list" : platform && (platform.listName ?? `your ${platform.name} list`);
  if (!name) return null;
  const n = page.subscriberCount;
  return n === null ? `Goes to ${name}.` : `Goes to ${name}, ${n.toLocaleString("en")} ${n === 1 ? "subscriber" : "subscribers"}.`;
}

export type IssueSummary = S["NewsletterIssueSummary"];
export type IssuesPage = { issues: IssueSummary[]; next: string | null };

/** A page of issues, newest slot first; `before` is the previous page's `next`. */
export const loadIssues = (workspaceId: string, before?: string): Promise<IssuesPage> =>
  call(api.GET("/api/w/{workspaceId}/newsletter/issues", { params: { ...at(workspaceId), query: before ? { before } : {} } }));

export const issuesQuery = (workspaceId: string) => queryOptions({ queryKey: inWorkspace(workspaceId, "newsletter", "issues"), queryFn: () => loadIssues(workspaceId) });

export type Issue = S["NewsletterIssue"];
export type IssueStats = NonNullable<Issue["stats"]>;
/** Clicks over delivered, or over sent when the tool doesn't say how many were delivered, in percent. */
export const clickRate = (s: IssueStats) => {
  const base = s.delivered ?? s.recipients;
  return base ? (s.clicks / base) * 100 : 0;
};
const one = (workspaceId: string, itemId: string) => ({ path: { workspaceId, itemId } });

export const issueQuery = (workspaceId: string, itemId: string) =>
  queryOptions({ queryKey: inWorkspace(workspaceId, "newsletter", "issues", itemId), queryFn: () => call(api.GET("/api/w/{workspaceId}/newsletter/issues/{itemId}", { params: one(workspaceId, itemId) })) });

/** The saved issue, or the error code. */
export async function saveIssue(workspaceId: string, itemId: string, body: { title: string; previewText?: string; markdown: string }): Promise<Issue | string> {
  const { data, error } = await api.PUT("/api/w/{workspaceId}/newsletter/issues/{itemId}", { params: one(workspaceId, itemId), body });
  return data ?? error!.error;
}

export async function submitIssue(workspaceId: string, itemId: string): Promise<Issue | string> {
  const { data, error } = await api.POST("/api/w/{workspaceId}/newsletter/issues/{itemId}/submit", { params: one(workspaceId, itemId) });
  return data ?? error!.error;
}

export async function markIssueSent(workspaceId: string, itemId: string): Promise<Issue | string> {
  const { data, error } = await api.POST("/api/w/{workspaceId}/newsletter/issues/{itemId}/sent", { params: one(workspaceId, itemId) });
  return data ?? error!.error;
}

/** The HTML the server makes of this Markdown, the same rendering an issue carries. */
export async function previewHtml(workspaceId: string, markdown: string): Promise<string | null> {
  return (await api.POST("/api/w/{workspaceId}/newsletter/preview", { params: { path: { workspaceId } }, body: { markdown } })).data?.html ?? null;
}

export const ISSUE_MESSAGES: Record<string, string> = {
  ...MESSAGES,
  issue_empty: "Give it a title and some words first.",
  wrong_state: "This issue can't change now: it was sent, skipped or cancelled.",
  slot_in_past: "Its time has passed, so it can't be approved now. It will be skipped.",
  not_found: "This issue isn't here any more.",
};
export const sayIssue = (error: string) => messageForCode(error, ISSUE_MESSAGES);

/** The stats in plain words. Opens are shown, but said to overcount. */
export function statsWords(s: IssueStats): string[] {
  const n = (count: number, one: string, many: string) => `${count.toLocaleString("en")} ${count === 1 ? one : many}`;
  return [
    `Sent to ${n(s.recipients, "person", "people")}${s.delivered === undefined ? "" : `, ${n(s.delivered, "delivered", "delivered")}`}.`,
    `${n(s.clicks, "click", "clicks")} on links, ${n(s.unsubscribes, "unsubscribe", "unsubscribes")}.`,
    `${n(s.opens, "open", "opens")}, but many are recorded automatically by mail apps, so this counts more than really read it.`,
  ];
}
