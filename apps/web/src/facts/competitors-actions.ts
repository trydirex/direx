// SPDX-License-Identifier: AGPL-3.0-only
// The competitor list calls. A change returns the API's error code (null when it worked), the row's id,
// and the checks of the URLs it read, which are shown but never stored.
import { queryOptions } from "@tanstack/react-query";
import type { components } from "../api/schema";
import { call, inWorkspace } from "../api/query";
import { api } from "../client";

type S = components["schemas"];
export type Competitor = S["Competitor"];
export type Check = S["CompetitorCheck"];
export type CompetitorFields = Omit<Competitor, "id">;
export type Result = { code: string | null; id: string | null; checks: Check[] };

const at = (workspaceId: string) => ({ path: { workspaceId } });
const one = (workspaceId: string, id: string) => ({ path: { workspaceId, id } });
const result = (r: { data?: { checks: Check[]; competitor?: Competitor }; error?: { error: string } }, id: string | null = null): Result => ({
  code: r.error ? r.error.error : null,
  id: r.data?.competitor?.id ?? id,
  checks: r.data?.checks ?? [],
});

export const MAX_COMPETITORS = 5;

export type LastRead = S["CompetitorRead"];
export type Change = S["CompetitorChange"];

/** The list and each page's latest weekly read. */
export const competitorsQuery = (workspaceId: string) =>
  queryOptions({ queryKey: inWorkspace(workspaceId, "competitors"), queryFn: () => call(api.GET("/api/w/{workspaceId}/competitors", { params: at(workspaceId) })) });

export const changesQuery = (workspaceId: string, id: string) =>
  queryOptions({
    queryKey: inWorkspace(workspaceId, "competitors", id, "changes"),
    queryFn: async () => (await call(api.GET("/api/w/{workspaceId}/competitors/{id}/changes", { params: one(workspaceId, id) }))).changes,
  });

/** A weekly read in words: when it was, or why it failed. */
export function readWords(r: LastRead): string {
  if (r.failure === null) return `Read ${new Date(r.readAt).toLocaleString(undefined, { weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" })}`;
  const [reason, ...rest] = r.failure.split(": ");
  const words = checkWords({ source: r.source, url: r.url, result: reason as Check["result"], ...(rest.length > 0 && { detail: rest.join(": ") }) });
  return `Last read failed: ${words.charAt(0).toLowerCase()}${words.slice(1)}`;
}

const PART_LABEL = { title: "Title", description: "Description", headline: "Headline", subhead: "Subhead" } as const;
const quoted = (s: string | null) => (s === null ? "nothing" : `“${s}”`);

/** One Change as lines a person reads. */
export function changeWords(c: Change): string[] {
  const d = c.detail;
  if ("rewritten" in d) return [`Page rewritten: ${d.rewritten.added} lines added, ${d.rewritten.removed} removed`];
  if ("part" in d) return [`${PART_LABEL[d.part]} changed from ${quoted(d.before)} to ${quoted(d.after)}`];
  return [...d.added.map((l) => `Added: ${l}`), ...(d.removed ?? []).map((l) => `Removed: ${l}`)];
}

const KIND_WORDS: Record<string, string> = { fact_update: "update a Fact", comparison_page: "comparison page", post: "post", ranking_brief: "ranking Brief" };
const shortDay = (iso: string) => new Date(iso).toLocaleDateString(undefined, { day: "numeric", month: "short" });

/** The classifier's label in words, or null while a Change is unlabelled. `others` finds the date of a sameAs. */
export function labelWords(c: Change, others: Change[]): string | null {
  if (c.label === null) return null;
  const head = c.label === "noise" ? "Noise" : `Worth answering: ${KIND_WORDS[c.kind ?? ""] ?? c.kind}`;
  const first = c.sameAs === null ? null : others.find((o) => o.id === c.sameAs);
  const same = c.sameAs === null ? "" : first ? ` Same as the Change of ${shortDay(first.at)}.` : " Same as an earlier Change.";
  return `${head}. ${c.reason ?? ""}${same}`.trim();
}

/** `proposalId` is the proposal used to fill the form, which adding closes. */
export const addCompetitor = async (workspaceId: string, body: CompetitorFields & { proposalId?: string }) => result(await api.POST("/api/w/{workspaceId}/competitors", { params: at(workspaceId), body }));

export const editCompetitor = async (workspaceId: string, id: string, body: CompetitorFields) => result(await api.PATCH("/api/w/{workspaceId}/competitors/{id}", { params: one(workspaceId, id), body }));

export const checkCompetitor = async (workspaceId: string, id: string) => result(await api.POST("/api/w/{workspaceId}/competitors/{id}/check", { params: one(workspaceId, id) }), id);

export async function removeCompetitor(workspaceId: string, id: string): Promise<string | null> {
  const { error } = await api.DELETE("/api/w/{workspaceId}/competitors/{id}", { params: one(workspaceId, id) });
  return error ? error.error : null;
}

/** What a check found, in words. */
export function checkWords(c: Check): string {
  switch (c.result) {
    case "readable":
      return c.prices?.length ? `Readable: found ${c.prices.join(", ")}. If your competitor's plan prices aren't here, they're drawn by a script` : "Readable";
    case "no_prices":
      return "Readable, but no prices in the text; they may be drawn by a script";
    case "robots_disallowed":
      return "Blocked by robots.txt";
    case "not_html":
      return "Not a web page";
    case "too_big":
      return "Too large to read";
    case "failed":
      return c.detail ? `Didn't load (${c.detail})` : "Didn't load";
  }
}

export type FoundPage = S["CompetitorFoundPage"];
export type FoundPages = S["CompetitorFindPages"];

/** The pricing and changelog pages Direx found from a homepage, or why it found none; `busy` while one already runs. */
export async function findPages(workspaceId: string, landingUrl: string): Promise<FoundPages | { ok: false; reason: string }> {
  const r = await api.POST("/api/w/{workspaceId}/competitors/find-pages", { params: at(workspaceId), body: { landingUrl } });
  return r.data ?? { ok: false, reason: r.error?.error ?? "failed" };
}

/** Where a found page came from, so the person can judge it before adding. */
export function foundWords(f: NonNullable<FoundPage>): string {
  if (f.via === "sitemap") return "Found in the site's sitemap.";
  const where = f.via === "homepage" ? "the homepage" : "the roadmap page";
  return f.text ? `Found through the link “${f.text.slice(0, 60)}” on ${where}.` : `Found through a link on ${where}.`;
}

const FIND_WORDS: Record<string, string> = {
  other_site: "This address goes to another company's site, so Direx has nothing to suggest.",
  robots_disallowed: "This site's robots.txt asks Direx not to read it.",
  unreadable: "Direx couldn't read that page.",
  busy: "Already looking. Try again in a moment.",
};
export const findWords = (reason: string) => FIND_WORDS[reason] ?? "Direx couldn't look just now. Try again.";

export type Proposal = S["CompetitorProposal"];

/** Competitors Direx found that wait for a person, the site they came from, and when it was last scanned. */
export const proposalsQuery = (workspaceId: string) =>
  queryOptions({ queryKey: inWorkspace(workspaceId, "competitors", "proposals"), queryFn: () => call(api.GET("/api/w/{workspaceId}/competitors/proposals", { params: at(workspaceId) })) });

/** Reads the Workspace's site again for competitor names; the error code, or null. */
export async function scanProposals(workspaceId: string): Promise<string | null> {
  const { error } = await api.POST("/api/w/{workspaceId}/competitors/proposals/scan", { params: at(workspaceId) });
  return error ? error.error : null;
}

export async function dismissProposal(workspaceId: string, id: string): Promise<string | null> {
  const { error } = await api.POST("/api/w/{workspaceId}/competitors/proposals/{id}/dismiss", { params: one(workspaceId, id) });
  return error ? error.error : null;
}

/** Where a proposal came from, in words. */
export const proposalSource = (p: Proposal) => (p.source === "search" ? `Search: ${(p.terms ?? []).join(", ")}` : "Your page compares you");
