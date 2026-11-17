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

export const addCompetitor = async (workspaceId: string, body: CompetitorFields) => result(await api.POST("/api/w/{workspaceId}/competitors", { params: at(workspaceId), body }));

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
