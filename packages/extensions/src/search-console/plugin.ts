// SPDX-License-Identifier: AGPL-3.0-only
// Search Console's API v3: the properties the connected Google account can see, and search
// analytics rows for one of them. The caller pages with startRow. Which property a workspace may
// read is decided by the caller, not here.
import { accessToken, definePlugin, type Credential, PluginError, type PluginReason, type QueryOutput } from "@direx/plugin-sdk";
import { z } from "zod";
import { waitFrom } from "../newsletter/http";
import { searchConsoleManifest } from "./manifest";

export const SEARCH_CONSOLE_DEFAULTS = {
  timeoutMs: 20_000,
  /** Used when a 429 doesn't say how long to wait. */
  rateLimitWaitMs: 60_000,
};
export type SearchConsoleOptions = Partial<typeof SEARCH_CONSOLE_DEFAULTS> & { baseUrl?: string; fetch?: typeof fetch; now?: () => number };

/** Why a call failed, in a word the SEO page turns into a sentence. */
export type SearchConsoleReason = "needs_reconnecting" | "api_disabled" | "no_access" | "busy" | "failed";

/**
 * A failed answer. The host passes on only the message, so the status, any wait and the reason all
 * go in it, as "Search Console answered 429; wait 60000 ms: busy". It never holds a token or a body.
 */
/** The host's reason for each of Search Console's; no_access and api_disabled also go as a code. */
const typed = (why: SearchConsoleReason): PluginReason =>
  why === "needs_reconnecting" ? "credential_rejected" : why === "busy" ? "rate_limited" : "provider_error";

export class SearchConsoleError extends PluginError {
  /** Always set: these come from an HTTP answer. */
  declare readonly status: number;
  readonly credentialRejected: boolean;
  constructor(
    status: number,
    why: SearchConsoleReason,
    /** Set for a 429: how long to wait before asking again. */
    readonly retryAfterMs?: number,
  ) {
    super(
      typed(why),
      `Search Console answered ${status}${retryAfterMs === undefined ? "" : `; wait ${retryAfterMs} ms`}: ${why}`,
      { status, ...(retryAfterMs !== undefined && { waitMs: retryAfterMs }), ...((why === "no_access" || why === "api_disabled") && { code: why }) },
    );
    this.credentialRejected = status === 401;
  }
}

type GoogleErrorBody = { error?: { message?: unknown; details?: { reason?: unknown }[] } };

/** A 403 is either the API switched off in the OAuth client's project, or no access to the property. */
function forbidden(body: GoogleErrorBody): SearchConsoleReason {
  const message = typeof body.error?.message === "string" ? body.error.message : "";
  const disabled = (body.error?.details ?? []).some((d) => d.reason === "SERVICE_DISABLED") || /has not been used in project|is disabled/i.test(message);
  return disabled ? "api_disabled" : "no_access";
}

const DIMENSIONS = ["query", "page", "date", "country", "device"] as const;
const day = z.iso.date();

/** The day as YYYY-MM-DD in UTC, `months` back from `at`. */
const isoDay = (at: number, months = 0) => {
  const d = new Date(at);
  d.setUTCMonth(d.getUTCMonth() - months);
  return d.toISOString().slice(0, 10);
};

const analyticsInput = (now: () => number) =>
  z
    .strictObject({
      siteUrl: z.string().min(1).max(2048),
      startDate: day,
      endDate: day,
      dimensions: z.array(z.enum(DIMENSIONS)).min(1).refine((d) => new Set(d).size === d.length, "each dimension once"),
      rowLimit: z.number().int().min(1).max(25_000).default(25_000),
      startRow: z.number().int().min(0).default(0),
    })
    .superRefine((v, ctx) => {
      const today = isoDay(now());
      const earliest = isoDay(now(), 16);
      if (v.startDate > v.endDate) ctx.addIssue({ code: "custom", path: ["startDate"], message: "startDate is after endDate" });
      for (const k of ["startDate", "endDate"] as const) {
        if (v[k] > today) ctx.addIssue({ code: "custom", path: [k], message: `${k} is in the future` });
        if (v[k] < earliest) ctx.addIssue({ code: "custom", path: [k], message: `${k} is more than 16 months back` });
      }
    });

const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : 0);

export function createSearchConsolePlugin(o: SearchConsoleOptions = {}) {
  const cfg = { ...SEARCH_CONSOLE_DEFAULTS, ...o };
  const now = o.now ?? Date.now;
  const baseUrl = o.baseUrl ?? "https://searchconsole.googleapis.com/webmasters/v3";
  const doFetch = o.fetch ?? fetch;
  const analytics = analyticsInput(now);

  async function req<T>(c: Credential | null, path: string, json?: unknown): Promise<T | null> {
    const token = accessToken(c);
    if (!token) throw new PluginError("not_connected", "Search Console is not connected");
    const res = await doFetch(`${baseUrl}${path}`, {
      method: json === undefined ? "GET" : "POST",
      headers: { accept: "application/json", authorization: `Bearer ${token}`, ...(json !== undefined && { "content-type": "application/json" }) },
      ...(json !== undefined && { body: JSON.stringify(json) }),
      signal: AbortSignal.timeout(cfg.timeoutMs),
    });
    if (res.status === 401) throw new SearchConsoleError(401, "needs_reconnecting");
    if (res.status === 403) throw new SearchConsoleError(403, forbidden((await res.json().catch(() => ({}))) as GoogleErrorBody));
    if (res.status === 429) throw new SearchConsoleError(429, "busy", waitFrom(res.headers, now(), cfg.rateLimitWaitMs));
    if (!res.ok) throw new SearchConsoleError(res.status, "failed");
    return (await res.json().catch(() => null)) as T | null;
  }

  return definePlugin({
    manifest: searchConsoleManifest,
    queries: {
      "search.properties": async (input, ctx): Promise<QueryOutput<"search.properties">> => {
        if (!z.strictObject({}).nullish().safeParse(input).success) throw new Error("search.properties takes no input");
        const r = await req<{ siteEntry?: { siteUrl?: unknown; permissionLevel?: unknown }[] }>(ctx.credential, "/sites");
        return (r?.siteEntry ?? []).flatMap((s) => (typeof s.siteUrl === "string" && typeof s.permissionLevel === "string" ? [{ siteUrl: s.siteUrl, permissionLevel: s.permissionLevel }] : []));
      },
      "search.analytics": async (input, ctx): Promise<QueryOutput<"search.analytics">> => {
        const p = analytics.safeParse(input);
        if (!p.success) throw new Error(`search.analytics: ${p.error.issues.map((i) => `${i.path.join(".") || "input"}: ${i.message}`).join("; ")}`);
        const { siteUrl, ...body } = p.data;
        const r = await req<{ rows?: { keys?: unknown; clicks?: unknown; impressions?: unknown; ctr?: unknown; position?: unknown }[] }>(
          ctx.credential,
          `/sites/${encodeURIComponent(siteUrl)}/searchAnalytics/query`,
          body,
        );
        return {
          rows: (r?.rows ?? []).map((row) => ({
            keys: Array.isArray(row.keys) ? row.keys.map(String) : [],
            clicks: num(row.clicks),
            impressions: num(row.impressions),
            ctr: num(row.ctr),
            position: num(row.position),
          })),
        };
      },
    },
  });
}
