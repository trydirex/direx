// SPDX-License-Identifier: AGPL-3.0-only
// The prospecting calls, and the plain words for every status and reason they return.
import { queryOptions } from "@tanstack/react-query";
import type { components } from "../api/schema";
import { call, inWorkspace } from "../api/query";
import { api } from "../client";
import { approve, message, type Item } from "../items/actions";

type S = components["schemas"];
export type PastedLine = S["PastedLine"];
export type Run = S["ProspectRun"];
export type Company = S["ProspectCompany"];
export type Signal = "hiring" | "stale_blog";

/**
 * A company_review Item's content. The items route types content as unknown, since each kind has
 * its own, so this mirrors the payload prospecting writes.
 */
export type Review = {
  companyId: string;
  domain: string;
  website: string;
  name: string | null;
  country: { code: string; quote: string | null } | null;
  names: { status: string; reason: string | null };
  signals: { type: string; quote: string; pageUrl: string; observedOn: string }[];
  addresses: { id: string; email: string; kind: string; source: string; name: string | null; role: string | null; pageUrl: string; readAt: string; personId: string | null; leftOut: string | null }[];
  /** People named on the site with no published address; accepting guesses and checks an address for each. */
  guessFor?: { name: string; role: string | null }[];
};

const inW = (workspaceId: string) => ({ params: { path: { workspaceId } } });

export async function startPasted(workspaceId: string, body: { websites: string[]; signals: Signal[]; confirmedUsd: number }) {
  const r = await api.POST("/api/w/{workspaceId}/prospecting/runs/pasted", { ...inW(workspaceId), body });
  return r.data ? ({ ok: true, ...r.data } as const) : ({ ok: false, error: r.error?.error ?? "failed", max: r.error?.max } as const);
}

/** The most one pasted company can cost to read and check, so the paste form can say about how much a list costs. */
export const perCompanyQuery = (workspaceId: string) =>
  queryOptions({ queryKey: inWorkspace(workspaceId, "prospecting", "per-company"), queryFn: () => call(api.GET("/api/w/{workspaceId}/prospecting/estimate/per-company", inW(workspaceId))) });

/**
 * A pasted line's company domain, as the run reads it: lowercase, no scheme, www., port or path. Null
 * when it isn't a web address with a dotted host.
 */
// ponytail: mirrors the API's companyDomain without its shared mail domain list, so a gmail.com line still counts; share the parser if the web gets a package with the API.
export function siteDomain(line: string): string | null {
  const trimmed = line.trim();
  if (!trimmed) return null;
  let url: URL;
  try {
    url = new URL(/^[a-z][a-z0-9+.-]*:/i.test(trimmed) ? trimmed : `https://${trimmed}`);
  } catch {
    return null;
  }
  const host = url.hostname.replace(/\.$/, "").replace(/^www\./, "");
  if (!["http:", "https:"].includes(url.protocol) || !host.includes(".") || host.startsWith("[") || /^\d+(\.\d+){3}$/.test(host)) return null;
  return host;
}

/** How many companies a paste would read at most: each valid website once, however it is written. */
export const pastedCount = (text: string) => new Set(text.split("\n").map(siteDomain).filter(Boolean)).size;

export type ProposedTerms = NonNullable<S["ProposedTerms"]>;
export type Estimate = S["SearchEstimate"];
export type SearchLine = S["SearchLine"];
export type SearchBody = { terms: string[]; limit: number; signals: Signal[] };
export const SEARCH_MAX = { terms: 20, termLength: 200, companies: 200 };

type Refused = { error: string; terms?: string[]; usd?: number } | undefined;
const refused = (e: Refused) => ({ ok: false, error: e?.error ?? "failed", terms: e?.terms, usd: e?.usd }) as const;

/** Starts a terms run from the approved Strategy. Its terms land later; poll `latestTerms` for its runId. */
export async function draftTerms(workspaceId: string) {
  const r = await api.POST("/api/w/{workspaceId}/prospecting/terms", inW(workspaceId));
  return r.data ? ({ ok: true, runId: r.data.runId } as const) : refused(r.error);
}

export const latestTerms = async (workspaceId: string) => (await found(api.GET("/api/w/{workspaceId}/prospecting/terms", inW(workspaceId))))?.proposed;

export async function estimate(workspaceId: string, body: SearchBody) {
  const r = await api.POST("/api/w/{workspaceId}/prospecting/estimate", { ...inW(workspaceId), body });
  return r.data ? ({ ok: true, estimate: r.data } as const) : refused(r.error);
}

/** Terms drafted earlier, or null when there are none or they couldn't be read: they only prefill the box. */
export const termsQuery = (workspaceId: string) => queryOptions({ queryKey: inWorkspace(workspaceId, "prospecting", "terms"), queryFn: async () => (await latestTerms(workspaceId)) ?? null });

/** The agent run drafting terms, polled until it settles. */
export const termsRunQuery = (workspaceId: string, id: string) =>
  queryOptions({ queryKey: inWorkspace(workspaceId, "agents", "runs", id), queryFn: () => call(api.GET("/api/w/{workspaceId}/agents/runs/{id}", { params: { path: { workspaceId, id } } })) });

export async function startSearch(workspaceId: string, body: SearchBody & { confirmedUsd: number }) {
  const r = await api.POST("/api/w/{workspaceId}/prospecting/runs", { ...inW(workspaceId), body });
  return r.data ? ({ ok: true, ...r.data } as const) : refused(r.error);
}

/** One line per term, blank lines dropped. */
export const readTerms = (text: string) =>
  text
    .split("\n")
    .map((t) => t.trim())
    .filter(Boolean);

const SEARCH: Record<string, string> = {
  no_strategy: "Approve a Strategy that says who it's for first. Terms are drafted from its audience.",
  not_available: "Searching for companies isn't available here, so paste their websites instead.",
  unknown_signal: "One of those signals isn't one Direx knows.",
  forbidden: "Your role doesn't allow this.",
  no_route: "No model is set up to draft terms here, so write them yourself.",
  disabled: "Drafting terms is turned off for this Workspace, so write them yourself.",
  unknown_agent: "The terms drafter isn't installed here, so write them yourself.",
  too_many_terms: `Use at most ${SEARCH_MAX.terms} terms.`,
  term_too_long: `Keep each term under ${SEARCH_MAX.termLength} characters.`,
  no_terms: "Write at least one term, one per line.",
};
export function saySearch(e: { error: string; terms?: string[]; usd?: number }): string {
  if (e.error === "person_data") return `These terms look like they name a person or hold an address, so they can't be searched. Change or remove them: ${(e.terms ?? []).join("; ")}.`;
  if (e.error === "below_estimate") return `The search alone is estimated at ${usd(e.usd ?? 0)}. Set the spend limit to at least that.`;
  return SEARCH[e.error] ?? "That didn't go through. Try again.";
}

/** What the screen says about a proposal's dropped terms and objective; nothing when none were dropped. */
export function droppedWords(t: Pick<ProposedTerms, "dropped" | "objective">): string {
  const terms = t.dropped === 0 ? "" : t.dropped === 1 ? "1 term was left out because it named a person or held an address." : `${t.dropped} terms were left out because they named a person or held an address.`;
  const objective = t.objective === null ? " The objective was left out because it named a person or held an address." : "";
  return (terms + objective).trim();
}

export function searchLineWords(l: SearchLine): string {
  if (l.ok) return "added to this search";
  if (l.reason === "over_amount") return "left over, because the spend limit ran out before it could be read";
  return "already known, so it isn't read or charged again";
}

/**
 * The data, `null` when the server says it doesn't exist, or `undefined` when the request failed and is
 * worth trying again. A restarting or briefly failing server must not read as "gone" on a screen that polls.
 */
async function found<T>(call: Promise<{ data?: T; response: Response }>): Promise<T | null | undefined> {
  try {
    const r = await call;
    return r.data ?? (r.response.status === 404 ? null : undefined);
  } catch {
    return undefined;
  }
}

export const loadRun = (workspaceId: string, id: string) => found(api.GET("/api/w/{workspaceId}/prospecting/runs/{id}", { params: { path: { workspaceId, id } } }));

/** The latest runs, newest first, so one can be found again after leaving Find companies. */
export const runsQuery = (workspaceId: string) =>
  queryOptions({ queryKey: inWorkspace(workspaceId, "prospecting", "runs"), queryFn: async () => (await call(api.GET("/api/w/{workspaceId}/prospecting/runs", inW(workspaceId)))).runs });

/** Queues the address checks again for a run's accepted companies, after the checking service refused. */
export const checkAgain = (workspaceId: string, id: string) =>
  call(api.POST("/api/w/{workspaceId}/prospecting/runs/{id}/check-again", { params: { path: { workspaceId, id } } }));

/** A run and its companies. A 404 throws not_found, which the screen says as a missing run. */
export const runQuery = (workspaceId: string, id: string) =>
  queryOptions({
    queryKey: inWorkspace(workspaceId, "prospecting", "runs", id),
    queryFn: async () => {
      const [run, companies] = await Promise.all([call(api.GET("/api/w/{workspaceId}/prospecting/runs/{id}", { params: { path: { workspaceId, id } } })), companiesOf(workspaceId, id)]);
      return { run, companies };
    },
  });

/** Every company in one run, a page at a time; a run holds at most 200. */
export async function companiesOf(workspaceId: string, runId: string): Promise<Company[]> {
  const out: Company[] = [];
  let cursor: string | undefined;
  do {
    const { data } = await api.GET("/api/w/{workspaceId}/prospecting/companies", { params: { path: { workspaceId }, query: { runId, cursor } } });
    if (!data) break;
    out.push(...data.companies);
    cursor = data.next ?? undefined;
  } while (cursor);
  return out;
}

/** Keeps the addresses at these positions in the review's list, which ends the Item Applied. */
export const keep = (workspaceId: string, item: Pick<Item, "id" | "revision">, positions: number[]) => approve(workspaceId, item, positions.length ? positions.join(",") : "none");
export const reject = (workspaceId: string, item: Pick<Item, "id" | "revision">) => approve(workspaceId, item, "reject");

/** Only a web address becomes a link, so a page can't hand the screen a script or another scheme. */
export function safeHref(url: string): string | undefined {
  try {
    const u = new URL(url);
    return u.protocol === "http:" || u.protocol === "https:" ? u.href : undefined;
  } catch {
    return undefined;
  }
}

const humanize = (code: string) => code.replaceAll("_", " ");

const START: Record<string, string> = {
  empty: "Paste at least one website.",
  unknown_signal: "One of those signals isn't one Direx knows.",
  forbidden: "Ask an Owner, Admin or Marketer to start a search.",
};
export const sayStart = (error: string, max?: number) => (error === "too_many" ? `A search takes at most ${max ?? 200} new companies. Paste fewer.` : (START[error] ?? "That didn't go through. Try again."));

const REVIEW: Record<string, string> = {
  choice_required: "Pick at least one address to keep, or reject the company.",
  nothing_to_keep: "There's no address to keep and no one to guess an address for. Reject the company instead.",
  unknown_address: "That address isn't on this review any more. Close it and open it again.",
  address_left_out: "One of those addresses is left out and can't be kept.",
  company_changed: "This company changed after the review was made. Close it and open it again.",
};
export const sayReview = (code: string) => REVIEW[code] ?? message(code);

const READ_REASON: Record<string, string> = {
  robots_txt: "its robots.txt asks readers like Direx to stay away",
  refused: "the site refused to let Direx read it",
  no_text: "its home page has almost no text, which usually means it needs JavaScript",
  bad_address: "the address isn't a website Direx can open",
  other_site: "it sent Direx to a different site",
  private_address: "it points at a private network",
  no_address: "its name doesn't lead to any server",
  too_many_redirects: "it redirected too many times",
  not_text: "its home page isn't a web page",
  too_large: "its home page is too large to read",
  timed_out: "it took too long to answer",
  bad_certificate: "its security certificate isn't valid",
  unreachable: "Direx couldn't reach it",
  http_error: "it answered with an error",
};
export const readWords = (c: Pick<Company, "readStatus" | "readReason">) =>
  c.readStatus === "pending" ? "Waiting to be read" : c.readStatus === "read" ? "Read" : `Not read: ${READ_REASON[c.readReason ?? ""] ?? humanize(c.readReason ?? "no reason given")}`;

const NAMES_REASON: Record<string, string> = {
  site_not_read: "the site wasn't read",
  no_route: "no model is set up to read names here",
  no_models: "no model is set up to read names here",
  disabled: "reading names is turned off",
  unknown_agent: "the names reader isn't installed",
  cost_capped: "it reached its cost limit",
  step_capped: "it reached its step limit",
  timed_out: "it took too long",
  failed: "the model run failed",
  cancelled: "it was cancelled",
  refused: "the model refused",
  expired: "it waited too long to start",
};
export function namesWords(status: string | null, reason: string | null): string {
  if (status === null) return "Names not read yet";
  if (status === "pending") return "Reading names";
  if (status === "done") return "Names read";
  return `Names not read: ${NAMES_REASON[reason ?? ""] ?? humanize(reason ?? "no reason given")}`;
}

const LEFT_OUT: Record<string, string> = {
  other_domain: "it's on another domain than the company's",
  generic_address: "it's a shared inbox such as info@ or support@",
  do_not_email_notice: "the page asks not to be sent marketing email",
  no_known_person: "no one on the site is known by it",
  opted_out: "this Person asked not to be contacted",
  already_contacted: "this Person was already written to",
  not_kept: "a person didn't keep it",
};
export const leftOutWords = (reason: string) => LEFT_OUT[reason] ?? humanize(reason);

export const STATE_WORDS: Record<string, string> = { new: "Not reviewed yet", in_review: "Waiting for you", accepted: "Kept", rejected: "Rejected" };
export const RUN_WORDS: Record<string, string> = { running: "Reading", done: "Finished", stopped: "Stopped at the spend limit", failed: "Failed" };

export const KIND_WORDS: Record<string, string> = { named: "Named person", function: "Role address", generic: "Shared inbox", unknown: "Unknown" };
export const SIGNAL_WORDS: Record<string, string> = { hiring: "Hiring", stale_blog: "Blog not updated in 6 months" };
export const usd = (n: number) => `$${n.toFixed(2)}`;
/** A search spends up to the amount confirmed; a pasted list has no limit, only Direx's estimate. */
export const spentWords = (r: Pick<Run, "source" | "vendorCostUsd" | "confirmedUsd">) =>
  r.source === "pasted" ? `${usd(r.vendorCostUsd)} spent, estimated about ${usd(r.confirmedUsd)}` : `${usd(r.vendorCostUsd)} spent of up to ${usd(r.confirmedUsd)}`;
/** An upper bound in dollars, rounded up to the cent so a fraction of a cent isn't shown as nothing. */
export const centsUp = (n: number) => (Math.ceil(Math.round(n * 1e6) / 1e4) / 100).toFixed(2);
export const usdUp = (n: number) => `$${centsUp(n)}`;

export type Cohort = S["Cohort"];
export type CohortFilter = S["CohortFilter"];
export type CohortMember = S["CohortMember"];
export type CohortPage = Cohort & { count: number; deliverable: number; inCampaign: number; usedBy: { campaignId: string; title: string; people: number; lastAddedAt: string }[]; members: CohortMember[]; next: string | null };
export type Handover = S["Handover"];
export type HandoverResult = S["HandoverResult"];

export const COHORT_CHOICES = {
  signals: ["hiring", "stale_blog"],
  kinds: ["named", "function"],
  sources: ["published", "guessed"],
  verification: ["deliverable", "invalid", "catch_all", "unknown", "other"],
} as const satisfies Partial<Record<keyof CohortFilter, readonly string[]>>;

/** A new segment: checked addresses only, since nothing else goes over at hand-over, and the searches it starts from. */
export const newFilter = (runs: string[] = []): CohortFilter => ({ signals: [], countries: [], kinds: [], sources: [], verification: ["deliverable"], runs });

/**
 * The searches a link asks a new segment to start from: `?runs=<id>,<id>` on the Segments page. Any
 * search id in the value counts, so a list written as JSON reads the same.
 */
export const presetRuns = (searchStr: string): string[] => [...new Set((new URLSearchParams(searchStr).get("runs") ?? "").toLowerCase().match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g) ?? [])];

/** How a search reads in a list: what it was and when it started. */
/** A search by what it looked for ("UK logistics firms +2 terms · 25 companies"); pasted websites and an old search with no terms by their date. */
export function searchName(r: Pick<Run, "source" | "terms" | "createdAt"> & { companies?: number }) {
  const count = r.companies === undefined ? "" : ` · ${r.companies} ${r.companies === 1 ? "company" : "companies"}`;
  const [first, ...rest] = r.terms;
  if (first) return `${first}${rest.length ? ` +${rest.length} ${rest.length === 1 ? "term" : "terms"}` : ""}${count}`;
  return `${r.source === "pasted" ? "Pasted websites" : "Search"}, ${new Date(r.createdAt).toLocaleString("en-GB", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" })}${count}`;
}

const either = (values: readonly string[], words: Record<string, string>) => values.map((v) => words[v] ?? humanize(v)).join(" or ");

/** A filter as short phrases, one per condition, for chips and the segment list. */
export function filterChips(f: CohortFilter, countryName: (code: string) => string = (c) => c): string[] {
  const age = f.signalMaxAgeDays === undefined ? "" : `read in the last ${f.signalMaxAgeDays} ${f.signalMaxAgeDays === 1 ? "day" : "days"}`;
  const chips = [
    f.signals.length ? `${either(f.signals, SIGNAL_WORDS)}${age ? `, ${age}` : ""}` : age ? `Any Signal ${age}` : "",
    f.countries.length ? `Country: ${f.countries.map(countryName).join(" or ")}` : "",
    f.runs.length ? `Found by ${f.runs.length === 1 ? "1 search" : `${f.runs.length} searches`}` : "",
    f.kinds.length ? either(f.kinds, KIND_WORDS) : "",
    f.sources.length ? either(f.sources, SOURCE_WORDS) : "",
    f.verification.length ? (f.verification.length === 1 && f.verification[0] === "deliverable" ? "Checked addresses" : `Check: ${either(f.verification, VERIFY_WORDS)}`) : "",
  ].filter(Boolean);
  return chips.length ? chips : ["Every kept address"];
}

export const listCohorts = async (workspaceId: string) => (await api.GET("/api/w/{workspaceId}/prospecting/cohorts", inW(workspaceId))).data?.cohorts ?? [];
export const loadCohort = (workspaceId: string, id: string, cursor?: string) =>
  found(api.GET("/api/w/{workspaceId}/prospecting/cohorts/{id}", { params: { path: { workspaceId, id }, query: { cursor } } }));

export const cohortsQuery = (workspaceId: string) =>
  queryOptions({ queryKey: inWorkspace(workspaceId, "prospecting", "cohorts"), queryFn: async () => (await call(api.GET("/api/w/{workspaceId}/prospecting/cohorts", inW(workspaceId)))).cohorts });

/** One cohort's live count and its first page of members. */
export const cohortQuery = (workspaceId: string, id: string) =>
  queryOptions({ queryKey: inWorkspace(workspaceId, "prospecting", "cohorts", id), queryFn: (): Promise<CohortPage> => call(api.GET("/api/w/{workspaceId}/prospecting/cohorts/{id}", { params: { path: { workspaceId, id }, query: {} } })) });

/** The Campaigns a cohort can be added to: only one whose plan was approved takes People (ADR 0023). */
export const campaignChoicesQuery = (workspaceId: string) =>
  queryOptions({
    queryKey: inWorkspace(workspaceId, "prospecting", "campaigns"),
    queryFn: async () => (await call(api.GET("/api/w/{workspaceId}/campaigns", inW(workspaceId)))).campaigns.filter((c) => c.status !== "draft" && c.status !== "awaiting_signoff"),
  });
/** Said when the API refuses a chosen Campaign: its plan isn't approved yet, or it or the segment was deleted. */
export const NOT_TAKING = "That Campaign can't take people until its plan is approved. If it was deleted, reload the page.";

/** Saves a new cohort, or changes the one with this id. */
export async function saveCohort(workspaceId: string, body: { name: string; filter: CohortFilter }, id?: string) {
  const r = id
    ? await api.PUT("/api/w/{workspaceId}/prospecting/cohorts/{id}", { params: { path: { workspaceId, id } }, body })
    : await api.POST("/api/w/{workspaceId}/prospecting/cohorts", { ...inW(workspaceId), body });
  return r.data ? ({ ok: true, cohort: r.data } as const) : ({ ok: false, error: r.error?.error ?? "failed", field: r.error?.field } as const);
}

/** How many a filter matches now, read again whenever the filter changes. Nothing is saved. */
export const cohortCountQuery = (workspaceId: string, filter: CohortFilter) =>
  queryOptions({
    queryKey: inWorkspace(workspaceId, "prospecting", "cohorts", "count", filter),
    queryFn: async () => {
      const r = await countCohort(workspaceId, filter);
      if (!r.ok) throw new Error(r.error);
      return r.count;
    },
  });

/** How many a filter matches now, without saving it. */
export async function countCohort(workspaceId: string, filter: CohortFilter) {
  const r = await api.POST("/api/w/{workspaceId}/prospecting/cohorts/count", { ...inW(workspaceId), body: { filter } });
  return r.data ? ({ ok: true, count: r.data.count } as const) : ({ ok: false, error: r.error?.error ?? "failed", field: r.error?.field } as const);
}

export async function addToCampaign(workspaceId: string, cohortId: string, campaignId: string) {
  const r = await api.POST("/api/w/{workspaceId}/prospecting/cohorts/{id}/add-to-campaign", { params: { path: { workspaceId, id: cohortId } }, body: { campaignId } });
  return r.data ? ({ ok: true, handoverId: r.data.handoverId } as const) : ({ ok: false, error: r.error?.error ?? "failed" } as const);
}

/** About how many adding the cohort to this Campaign would take, and why the rest would be skipped. Nothing is written. */
export const addPreviewQuery = (workspaceId: string, cohortId: string, campaignId: string) =>
  queryOptions({
    queryKey: inWorkspace(workspaceId, "prospecting", "cohorts", cohortId, "preview", campaignId),
    queryFn: () => call(api.POST("/api/w/{workspaceId}/prospecting/cohorts/{id}/add-to-campaign/preview", { params: { path: { workspaceId, id: cohortId } }, body: { campaignId } })),
  });

/** One skip reason and its count, as a line: "On your Do not contact list: 2". */
export function skipWords(s: { reason: string; count: number }): string {
  const why = HANDOVER_REASON[s.reason] ?? humanize(s.reason);
  return `${why.charAt(0).toUpperCase()}${why.slice(1)}: ${s.count.toLocaleString("en-US")}`;
}

export const loadHandover = (workspaceId: string, id: string, cursor?: string) =>
  found(api.GET("/api/w/{workspaceId}/prospecting/handovers/{id}", { params: { path: { workspaceId, id }, query: { cursor } } }));

/** A hand-over and its first page of results. */
export const handoverQuery = (workspaceId: string, id: string) =>
  queryOptions({ queryKey: inWorkspace(workspaceId, "prospecting", "handovers", id), queryFn: () => call(api.GET("/api/w/{workspaceId}/prospecting/handovers/{id}", { params: { path: { workspaceId, id }, query: {} } })) });

/** Polls every few seconds while the background work runs, and stops once it has settled. */
export const whileRunning =
  <T>(status: (data: T) => string) =>
  (q: { state: { data?: T } }) =>
    q.state.data !== undefined && status(q.state.data) === "running" ? POLL_MS : false;
export const POLL_MS = 5_000;

const COHORT_ERROR: Record<string, string> = {
  forbidden: "Your role doesn't allow changing segments.",
  not_found: "That segment or Campaign is gone. Reload the page.",
};
export function sayCohort(error: string, field?: string): string {
  if (error === "unknown_value" && field === "countries") return "Countries need two-letter codes, such as US or GB.";
  if (error === "unknown_value" && field === "signalMaxAgeDays") return "Days need to be a whole number from 1 to 3650.";
  if (error === "unknown_value" && field === "runs") return "One of those searches is gone. Pick the searches again.";
  return COHORT_ERROR[error] ?? (error.startsWith("name") ? "Give the segment a name." : "That didn't go through. Try again.");
}

export const SOURCE_WORDS: Record<string, string> = { published: "Published on the site", guessed: "Guessed" };
export const VERIFY_WORDS: Record<string, string> = {
  deliverable: "Deliverable",
  invalid: "Not deliverable",
  catch_all: "Can't tell, the domain accepts every address",
  unknown: "Couldn't be checked",
  other: "The check gave no clear answer",
};
export const verifyWords = (m: Pick<CohortMember, "verificationResult" | "verifiedAt">) =>
  m.verificationResult === null ? "Not checked yet" : `${VERIFY_WORDS[m.verificationResult] ?? humanize(m.verificationResult)}${m.verifiedAt ? `, checked ${m.verifiedAt.slice(0, 10)}` : ""}`;

const HANDOVER_REASON: Record<string, string> = {
  not_deliverable: "not deliverable when checked",
  guess_in_canada: "a guessed address for someone in Canada, which never goes over",
  suppressed: "on your Do not contact list",
  already_contacted: "this Person was already written to",
  removed: "removed from this Campaign earlier, so not added back",
  no_email: "no email address",
  bad_email: "not an email address",
  bad_website: "the company's website isn't a web address",
  bad_country: "the country isn't a two-letter code",
  bad_basis: "the reason for writing to them wasn't accepted",
  too_long: "a value is too long",
};
export function handoverWords(r: HandoverResult): string {
  if (r.status === "left_out") return `Left out: ${HANDOVER_REASON[r.reason ?? ""] ?? humanize(r.reason ?? "no reason given")}.`;
  const said = r.status === "added" ? "Added." : r.status === "joined" ? "Added, already a Person here." : "Waiting for you: this Person is in another live Campaign.";
  // A Person without a country can't be drafted for, since whether they may be written to depends on it.
  const noCountry = r.missing.includes("country") ? " No country is known, so they stay out of drafts until someone enters it." : "";
  const rest = r.missing.filter((m) => m !== "country");
  return `${said}${noCountry}${rest.length ? ` Gets no draft until these are recorded: ${rest.map(humanize).join(", ")}.` : ""}`;
}
