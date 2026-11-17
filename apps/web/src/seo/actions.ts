// SPDX-License-Identifier: AGPL-3.0-only
// The Search Console calls the SEO page makes, and each refusal as the sentence the page shows.
import { queryOptions } from "@tanstack/react-query";
import type { components, paths } from "../api/schema";
import { call, inWorkspace } from "../api/query";
import { api } from "../client";
import { startConnect } from "../credentials/actions";

type S = components["schemas"];
export type Refusal = NonNullable<S["SearchConsoleRefusal"]>;
export type Reason = Refusal["reason"];
export type SearchConsole = { connected: boolean; siteUrl: string | null; properties: { siteUrl: string; permissionLevel: string }[] | null; refusal: Refusal | null };
export type Summary = paths["/api/w/{workspaceId}/seo/search-console/summary"]["get"]["responses"][200]["content"]["application/json"];

/**
 * "+12% vs previous 28 days" for a figure against the same span before it, or "" when there is no
 * earlier span on record or it was zero, so no comparison is made up.
 */
export function changeWords(now: number, before: number | undefined, previous: { startDate: string; endDate: string } | null): string {
  if (!previous || !before) return "";
  const days = Math.round((Date.parse(previous.endDate) - Date.parse(previous.startDate)) / 86_400_000) + 1;
  const pct = Math.round(((now - before) / before) * 100);
  return `${pct > 0 ? "+" : ""}${pct}% vs previous ${days} days`;
}
/** Average rank against the 28 days before, where a lower rank is better: "Up from 9", "Down from 7". */
export function rankChangeWords(now: number | null, before: number | null | undefined): string {
  if (now === null || before === null || before === undefined) return "";
  const [a, b] = [Math.round(now), Math.round(before)];
  return a < b ? `Up from ${b}` : a > b ? `Down from ${b}` : "Same as the 28 days before";
}
export type Candidates = paths["/api/w/{workspaceId}/seo/candidates"]["get"]["responses"][200]["content"]["application/json"];

export const CONNECTION = "google_search_console";
export const API_LIBRARY = "https://console.cloud.google.com/apis/library/searchconsole.googleapis.com";

const at = (workspaceId: string) => ({ path: { workspaceId } });

const key = (workspaceId: string, ...rest: string[]) => inWorkspace(workspaceId, "seo", ...rest);

export const searchConsoleQuery = (workspaceId: string) =>
  queryOptions({ queryKey: key(workspaceId, "search-console"), queryFn: async (): Promise<SearchConsole> => call(api.GET("/api/w/{workspaceId}/seo/search-console", { params: at(workspaceId) })) });

/** A refusal is data here: the page shows it in place, with its own next step. */
export const summaryQuery = (workspaceId: string) => queryOptions({ queryKey: key(workspaceId, "summary"), queryFn: () => summary(workspaceId) });
export const candidatesQuery = (workspaceId: string) => queryOptions({ queryKey: key(workspaceId, "candidates"), queryFn: () => candidates(workspaceId) });
export const briefsQuery = (workspaceId: string) =>
  queryOptions({ queryKey: key(workspaceId, "briefs"), queryFn: async (): Promise<BriefsState> => call(api.GET("/api/w/{workspaceId}/seo/briefs", { params: at(workspaceId) })) });

/** Saves the property. The refusal, or null when it worked. */
export async function chooseProperty(workspaceId: string, siteUrl: string): Promise<Refusal | null> {
  const { error } = await api.POST("/api/w/{workspaceId}/seo/search-console/property", { params: at(workspaceId), body: { siteUrl } });
  return error ? { reason: error.error as Reason, selfHost: error.selfHost } : null;
}

/** The 28-day clicks and impressions, or the refusal. */
export async function summary(workspaceId: string): Promise<Summary | Refusal> {
  const { data, error } = await api.GET("/api/w/{workspaceId}/seo/search-console/summary", { params: at(workspaceId) });
  return data ?? { reason: error!.error as Reason, selfHost: error!.selfHost };
}

/** The pages and queries worth a brief, or the refusal. */
export async function candidates(workspaceId: string): Promise<Candidates | Refusal> {
  const { data, error } = await api.GET("/api/w/{workspaceId}/seo/candidates", { params: at(workspaceId) });
  return data ?? { reason: error!.error as Reason, selfHost: error!.selfHost };
}

export type RunNote = NonNullable<S["BriefRunNote"]>;
export type BriefsState = { note: RunNote | null; ranThisWeek: boolean };

export async function briefs(workspaceId: string): Promise<BriefsState | null> {
  return (await api.GET("/api/w/{workspaceId}/seo/briefs", { params: at(workspaceId) })).data ?? null;
}

/** Starts this week's Briefs as the person who pressed it. The run's note, or the sentence saying why not. */
export async function runBriefs(workspaceId: string): Promise<RunNote | string> {
  const { data, error } = await api.POST("/api/w/{workspaceId}/seo/briefs/run", { params: at(workspaceId) });
  if (data) return data;
  if (!error?.error) return "The run hit an error on the server. Try again; if it happens again, the server log says why.";
  return error.error === "already_ran" ? "This week's Briefs have already been started." : say({ reason: error.error as Reason, selfHost: error.selfHost });
}

export type History = paths["/api/w/{workspaceId}/seo/briefs/history"]["get"]["responses"][200]["content"]["application/json"];
export type BriefHistory = History["briefs"][number];

export const historyQuery = (workspaceId: string) =>
  queryOptions({ queryKey: key(workspaceId, "briefs", "history"), queryFn: async (): Promise<History> => call(api.GET("/api/w/{workspaceId}/seo/briefs/history", { params: at(workspaceId) })) });

/** "page\nsearch", so a candidate row can find its Brief. */
export const waitingKey = (page: string, query: string) => `${page}\n${query}`;
/** Rows whose Brief waits on a person, and rows whose Brief is still being written. */
export const rowStates = (h: History) => ({
  waiting: new Set(h.briefs.filter((b) => b.state === "draft" || b.state === "needs_approval" || b.state === "scheduled").map((b) => waitingKey(b.page, b.query))),
  writing: new Set(h.writing.map((b) => waitingKey(b.page, b.query))),
});

/** Starts one Brief for a candidate row. Null when it started, else the sentence saying why not. */
export async function writeBrief(workspaceId: string, page: string, query: string): Promise<string | null> {
  const { error } = await api.POST("/api/w/{workspaceId}/seo/briefs/write", { params: at(workspaceId), body: { page, query } });
  if (!error) return null;
  const reason = error.error;
  if (reason === "brief_waiting") return "A Brief for this page and search is already waiting on you.";
  if (reason === "not_a_candidate") return "That search isn't in the lists any more. Reload the page.";
  if (reason in SKIPPED) return `Direx couldn't read the page, because ${skippedWords(reason)}.`;
  if (reason === "no_route" || reason === "disabled") return stoppedWords(reason);
  if (reason === "api_disabled" || reason in WORDS) return say({ reason: reason as Reason, selfHost: error.selfHost });
  return "The Brief couldn't start. Try again.";
}

/**
 * Whether a Brief helped, in a few words: not yet applied, too early, or clicks after against
 * before. Without both numbers it says it can't tell rather than guess.
 */
export function helpedWords(b: { state: string; checkOn: string | null; before: { clicks: number } | null; after: number | null }, today: string): string {
  if (b.state === "cancelled") return "Dismissed";
  if (b.state !== "applied" || !b.checkOn) return "Not applied yet";
  if (today < b.checkOn) return `Too early, check on ${dayWords(b.checkOn)}`;
  if (!b.before) return "Can't tell: it was picked without a click count";
  if (b.after === null) return "Can't tell: Search Console couldn't be read";
  const { clicks } = b.before;
  if (clicks === 0) return b.after > 0 ? `Yes, ${n(b.after)} clicks from none` : "No change";
  const times = b.after / clicks;
  if (times >= 1.5) return `Yes, ${Math.round(times * 10) / 10}× the clicks`;
  return times <= 2 / 3 ? "No, fewer clicks" : "No change";
}
const n = (x: number) => x.toLocaleString("en");

const SKIPPED: Record<string, string> = {
  robots_disallowed: "its robots.txt doesn't allow reading it",
  not_html: "it isn't a web page",
  too_big: "it's too big to read",
  failed: "it didn't load",
};
export const skippedWords = (reason: string) => SKIPPED[reason] ?? "it couldn't be read";

/** Why a run started no Briefs, as a sentence. */
export const stoppedWords = (reason: string) =>
  reason === "no_route"
    ? "Briefs need a model. On Direx Cloud they aren't available yet; on a self-hosted Direx, connect Claude Code or Codex under AI models."
    : reason === "disabled"
      ? "The Brief agent is turned off under Agents."
      : "The Briefs couldn't start. Try again next week, or ask an Admin to check Models.";

/** "/blog/post" for a page URL, so a list stays readable. */
export const pathOf = (page: string) => (URL.canParse(page) ? new URL(page).pathname : page);

/** Opens Google's consent page, the same connect a Gmail Mailbox uses. On failure, the sentence to show. */
export async function connect(workspaceId: string, go: (url: string) => void = (url) => location.assign(url)): Promise<string | null> {
  const r = await startConnect(workspaceId, CONNECTION);
  if ("url" in r) {
    go(r.url);
    return null;
  }
  return r.error === "unknown_connection"
    ? "Search Console needs a Google OAuth client. Set DIREX_GOOGLE_CLIENT_ID and store its secret as signin.google, as .env.example describes."
    : "That didn't work. Try again.";
}

/** The connect error the callback sends back, as a sentence. */
export const connectError = (code: string) =>
  code === "missing_scope"
    ? "Search Console access wasn't granted. Connect again and allow Search Console access."
    : code === "denied"
      ? "The connection was cancelled. Nothing was saved."
      : "Search Console didn't connect. Try again.";

const WORDS: Record<Exclude<Reason, "api_disabled">, string> = {
  not_connected: "Search Console isn't connected.",
  needs_reconnecting: "Search Console needs reconnecting.",
  no_property: "Pick a property first.",
  not_listed: "This Google account can't see that property. Pick one from the list.",
  no_access: "This Google account can't see that property any more.",
  busy: "Search Console is busy, try again later.",
  failed: "Search Console didn't answer. Try again later.",
};

export const say = (r: Refusal) =>
  r.reason === "api_disabled" ? (r.selfHost ? "Turn on the Search Console API for your Google OAuth client." : "Something went wrong on our side. Try again later.") : (WORDS[r.reason] ?? "That didn't work. Try again.");

/** "3 November 2026" for a YYYY-MM-DD date. */
export const dayWords = (iso: string) => new Intl.DateTimeFormat("en-GB", { timeZone: "UTC", day: "numeric", month: "long", year: "numeric" }).format(new Date(`${iso}T00:00:00Z`));

/** "2 November 2026, 07:00" for a moment, in the Workspace time zone, so a run reads in local time. */
export const momentWords = (iso: string, timeZone: string) => {
  const f = (o: Intl.DateTimeFormatOptions) => new Intl.DateTimeFormat("en-GB", { timeZone, ...o }).format(new Date(iso));
  return { day: f({ day: "numeric", month: "long", year: "numeric" }), clock: f({ hour: "2-digit", minute: "2-digit", hourCycle: "h23" }) };
};
