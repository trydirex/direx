// SPDX-License-Identifier: AGPL-3.0-only
// A Workspace's Search Console: the properties its connected Google account can see, the one a
// person chose, saved on the connection, and search data for that property only. Search data is
// read when asked for and never stored here.
import type { QueryInput, QueryOutput } from "@direx/plugin-sdk";
import { failureOf, type Query, type QueryId, type SearchProvider } from "../../plugins/index";
import { brandTerms, competing, nearPageOne, slipping } from "../domain/selectors";

/** Why a read gave no data, in a word the SEO page turns into a sentence. */
export type SearchRefusal = "not_connected" | "needs_reconnecting" | "no_property" | "not_listed" | "no_access" | "api_disabled" | "busy" | "failed";
/** `selfHost` comes with "api_disabled", since only a self-hosted operator can turn the API on. */
export type Refused = { ok: false; reason: SearchRefusal; selfHost?: boolean };

export type Property = QueryOutput<"search.properties">[number];
export type Row = QueryOutput<"search.analytics">["rows"][number];
export type Totals = { startDate: string; endDate: string; clicks: number; impressions: number; position: number | null };
export type Dimension = "query" | "page" | "date" | "country" | "device";

export type SeoDeps = {
  /** The Workspace's live credentials, as the vault lists them. */
  credentials: (workspaceId: string) => Promise<readonly { id: string; connection: string | null; status: string; meta: unknown }[]>;
  /** Saves one plain field in a credential's meta, replacing what was there. */
  setMeta: (workspaceId: string, credentialId: string, name: string, value: string) => Promise<{ ok: boolean }>;
  /** Google refused the token, so the connection shows that it needs reconnecting. */
  markNeedsReauth: (workspaceId: string, credentialId: string) => Promise<void>;
  /** Whose Google app connecting would use here: the Workspace's own, the server's, or none yet. */
  appSource: (workspaceId: string) => Promise<"own" | "system" | null>;
  /** The redirect a Workspace's own Google app must allow. */
  callbackUrl: () => string;
  /** The search data provider's connection and query ids, or none when no plugin provides it. */
  provider: () => SearchProvider | undefined;
  /** A plugin query through one credential, its answer checked by the host. */
  query: Query;
  selfHost: () => boolean;
  now?: () => Date;
  sleep?: (ms: number) => Promise<void>;
  /** How long one read may wait out "busy" answers, waits included. */
  ceilingMs?: number;
};

export const SEARCH_DEFAULTS = {
  /** A page request waits this long at most, well inside the server's idle timeout. */
  ceilingMs: 2 * 60_000,
  /** Used when Search Console says it is busy without saying for how long. */
  waitMs: 60_000,
  /** The API's largest page. */
  rowLimit: 25_000,
  /** Search Console's data is about 2 to 3 days behind, so the summary ends this many days back. */
  lagDays: 3,
  summaryDays: 28,
};

const USABLE = new Set(["siteOwner", "siteFullUser", "siteRestrictedUser"]);
const DAY_MS = 86_400_000;
const isoDay = (ms: number) => new Date(ms).toISOString().slice(0, 10);
/** Average rank weighted by how often each row was shown, as Search Console averages it; null with no impressions. */
const averageRank = (rows: readonly { impressions: number; position: number }[]) => {
  const shown = rows.reduce((n, r) => n + r.impressions, 0);
  return shown ? rows.reduce((n, r) => n + r.position * r.impressions, 0) / shown : null;
};
/** The 28 days of data ending 3 days before `at` (UTC), or the 28 days before those when `back` is 1. */
const windowOf = (at: Date, back = 0) => {
  const end = at.getTime() - (SEARCH_DEFAULTS.lagDays + back * SEARCH_DEFAULTS.summaryDays) * DAY_MS;
  return { startDate: isoDay(end - (SEARCH_DEFAULTS.summaryDays - 1) * DAY_MS), endDate: isoDay(end) };
};
const siteUrlOf = (meta: unknown) => {
  const v = (meta as { siteUrl?: unknown } | null)?.siteUrl;
  return typeof v === "string" ? v : null;
};

export function createSeo(deps: SeoDeps) {
  const now = deps.now ?? (() => new Date());
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const ceilingMs = deps.ceilingMs ?? SEARCH_DEFAULTS.ceilingMs;

  /** The Workspace's Search Console connection: the one holding a choice, else the first. */
  async function connection(workspaceId: string) {
    const provider = deps.provider();
    if (!provider) return { ok: false as const, reason: "not_connected" as const };
    const live = (await deps.credentials(workspaceId)).filter((c) => c.connection === provider.connection);
    const credential = live.find((c) => siteUrlOf(c.meta)) ?? live[0];
    if (!credential) return { ok: false as const, reason: "not_connected" as const };
    return { ok: true as const, provider, credential, siteUrl: siteUrlOf(credential.meta) };
  }

  /** One query, waiting out "busy" answers until the ceiling, and its failure as a refusal. */
  async function ask<N extends "search.properties" | "search.analytics">(workspaceId: string, credentialId: string, capability: QueryId<N>, input: QueryInput<N>): Promise<{ ok: true; output: QueryOutput<N> } | Refused> {
    const start = now().getTime();
    for (;;) {
      try {
        return { ok: true, output: await deps.query(workspaceId, capability, input, credentialId) };
      } catch (e) {
        const f = failureOf(e, capability);
        // No token at all means the vault could not renew it.
        const reason: SearchRefusal =
          f.code === "no_access" || f.code === "api_disabled"
            ? f.code
            : f.reason === "rate_limited"
              ? "busy"
              : f.reason === "credential_rejected" || f.reason === "not_connected"
                ? "needs_reconnecting"
                : "failed";
        if (reason === "busy") {
          const wait = f.waitMs ?? SEARCH_DEFAULTS.waitMs;
          if (now().getTime() - start + wait <= ceilingMs) {
            await sleep(wait);
            continue;
          }
        }
        if (f.reason === "credential_rejected") await deps.markNeedsReauth(workspaceId, credentialId);
        return reason === "api_disabled" ? { ok: false, reason, selfHost: deps.selfHost() } : { ok: false, reason };
      }
    }
  }

  type Connection = Extract<Awaited<ReturnType<typeof connection>>, { ok: true }>;
  async function propertiesOf(workspaceId: string, c: Connection): Promise<{ ok: true; properties: Property[] } | Refused> {
    if (c.credential.status !== "active") return { ok: false, reason: "needs_reconnecting" };
    const r = await ask(workspaceId, c.credential.id, c.provider.properties, null);
    if (!r.ok) return r;
    return { ok: true, properties: r.output.filter((p) => USABLE.has(p.permissionLevel)) };
  }

  /**
   * Rows for the chosen property only: there is no way to name another. Pages through until a
   * page comes back short.
   */
  async function analytics(workspaceId: string, range: { startDate: string; endDate: string }, dimensions: Dimension[]): Promise<{ ok: true; siteUrl: string; rows: Row[] } | Refused> {
    const c = await connection(workspaceId);
    if (!c.ok) return c;
    if (!c.siteUrl) return { ok: false, reason: "no_property" };
    if (c.credential.status !== "active") return { ok: false, reason: "needs_reconnecting" };
    const rows: Row[] = [];
    for (;;) {
      const input = { siteUrl: c.siteUrl, startDate: range.startDate, endDate: range.endDate, dimensions, rowLimit: SEARCH_DEFAULTS.rowLimit, startRow: rows.length };
      const r = await ask(workspaceId, c.credential.id, c.provider.analytics, input);
      if (!r.ok) return r;
      const page = r.output.rows;
      rows.push(...page);
      if (page.length < SEARCH_DEFAULTS.rowLimit) return { ok: true, siteUrl: c.siteUrl, rows };
    }
  }

  async function properties(workspaceId: string) {
    const c = await connection(workspaceId);
    return c.ok ? propertiesOf(workspaceId, c) : c;
  }

  return {
    properties,
    analytics,

    /** What the SEO page shows first: whether Search Console is connected, the choice, and what to choose from. */
    async state(workspaceId: string) {
      const c = await connection(workspaceId);
      if (!c.ok) return { connected: false, siteUrl: null, properties: null, refusal: { reason: c.reason }, app: { source: await deps.appSource(workspaceId), callbackUrl: deps.callbackUrl() } };
      const p = await propertiesOf(workspaceId, c);
      return { connected: true, siteUrl: c.siteUrl, properties: p.ok ? p.properties : null, refusal: p.ok ? null : { reason: p.reason, ...(p.selfHost !== undefined && { selfHost: p.selfHost }) } };
    },

    /** Saves the property the Workspace reads from now on. It must be one the account can see. */
    async choose(workspaceId: string, siteUrl: string): Promise<{ ok: true; siteUrl: string } | Refused> {
      const c = await connection(workspaceId);
      if (!c.ok) return c;
      const p = await propertiesOf(workspaceId, c);
      if (!p.ok) return p;
      if (!p.properties.some((x) => x.siteUrl === siteUrl)) return { ok: false, reason: "not_listed" };
      const saved = await deps.setMeta(workspaceId, c.credential.id, "siteUrl", siteUrl);
      return saved.ok ? { ok: true, siteUrl } : { ok: false, reason: "not_connected" };
    },

    /**
     * Clicks and impressions over the last 28 days of data, which end 3 days before today (UTC), and
     * over the 28 days before those when the data reaches back that far, else `previous` is null.
     */
    async summary(workspaceId: string): Promise<({ ok: true; siteUrl: string; daily: { date: string; position: number }[]; previous: Totals | null } & Totals) | Refused> {
      const range = windowOf(now());
      const before = windowOf(now(), 1);
      const r = await analytics(workspaceId, { startDate: before.startDate, endDate: range.endDate }, ["date"]);
      if (!r.ok) return r;
      const totals = (w: { startDate: string; endDate: string }) => {
        const rows = r.rows.filter((row) => row.keys[0]! >= w.startDate && row.keys[0]! <= w.endDate);
        return { rows, clicks: rows.reduce((n, row) => n + row.clicks, 0), impressions: rows.reduce((n, row) => n + row.impressions, 0), position: averageRank(rows) };
      };
      const { rows, clicks, impressions, position } = totals(range);
      const prev = totals(before);
      // ponytail: a row in the previous window's first week counts as covering it; a site with no
      // impressions for a whole week there shows no comparison.
      const covered = prev.rows.some((row) => row.keys[0]! <= isoDay(Date.parse(before.startDate) + 6 * DAY_MS));
      const daily = rows.filter((row) => row.impressions > 0).map((row) => ({ date: row.keys[0]!, position: row.position })).sort((a, b) => a.date.localeCompare(b.date));
      return { ok: true, siteUrl: r.siteUrl, ...range, clicks, impressions, position, daily, previous: covered ? { ...before, clicks: prev.clicks, impressions: prev.impressions, position: prev.position } : null };
    },

    /**
     * What's worth a brief, over the same 28 days as the summary: pairs near page one, pages
     * slipping against the 28 days before, and queries several pages compete for. Brand searches
     * are left out, using the Workspace name and the property's domain.
     */
    async candidates(workspaceId: string, workspaceName: string) {
      const current = windowOf(now());
      const previous = windowOf(now(), 1);
      const pairs = await analytics(workspaceId, current, ["query", "page"]);
      if (!pairs.ok) return pairs;
      const pagesNow = await analytics(workspaceId, current, ["page"]);
      if (!pagesNow.ok) return pagesNow;
      const pagesBefore = await analytics(workspaceId, previous, ["page"]);
      if (!pagesBefore.ok) return pagesBefore;
      const terms = brandTerms(workspaceName, pairs.siteUrl);
      // Each pair's rank in the 28 days before, when that read works; the lists don't wait on it.
      const pairsBefore = await analytics(workspaceId, previous, ["query", "page"]);
      const was = new Map(pairsBefore.ok ? pairsBefore.rows.map((r) => [`${r.keys[0]!.toLowerCase()}\n${r.keys[1]}`, r.position]) : []);
      const before = (query: string, page: string) => was.get(`${query.toLowerCase()}\n${page}`) ?? null;
      const near = nearPageOne(pairs.rows, terms);
      const vying = competing(pairs.rows, terms);
      return {
        ok: true as const,
        siteUrl: pairs.siteUrl,
        current,
        previous,
        nearPageOne: { ...near, top: near.top.map((x) => ({ ...x, positionBefore: before(x.query, x.page) })) },
        slipping: slipping(pagesNow.rows, pagesBefore.rows, pairs.rows, terms),
        competing: { ...vying, top: vying.top.map((x) => ({ ...x, pages: x.pages.map((pg) => ({ ...pg, positionBefore: before(x.query, pg.page) })) })) },
      };
    },

    /**
     * One page and search over the same 28 days, for a Brief a person asked for. The windows always
     * come back; the numbers are empty when Search Console isn't connected or has no row for them.
     */
    async pageNumbers(workspaceId: string, page: string, query: string) {
      const current = windowOf(now());
      const previous = windowOf(now(), 1);
      const pairs = await analytics(workspaceId, current, ["query", "page"]);
      const q = query.trim().toLowerCase();
      const row = pairs.ok ? pairs.rows.find((r) => r.keys[0]?.toLowerCase() === q && r.keys[1] === page) : undefined;
      const numbers: Record<string, number> = row ? { impressions: row.impressions, clicks: row.clicks, position: row.position } : {};
      return { current, previous, numbers };
    },

    /**
     * Clicks for each page and search over one range, read live, in the order asked; a pair with no row had none.
     * Null when Search Console can't be read, so a caller says it can't tell rather than zero.
     */
    async clicksOver(workspaceId: string, range: { startDate: string; endDate: string }, pairs: readonly { page: string; query: string }[]): Promise<number[] | null> {
      const r = await analytics(workspaceId, range, ["query", "page"]);
      if (!r.ok) return null;
      return pairs.map((p) => {
        const q = p.query.trim().toLowerCase();
        return r.rows.filter((row) => row.keys[0]?.toLowerCase() === q && row.keys[1] === p.page).reduce((n, row) => n + row.clicks, 0);
      });
    },

    /** What the latest Brief run noted, kept on the connection beside the chosen property. */
    async briefsRun(workspaceId: string): Promise<unknown> {
      const c = await connection(workspaceId);
      const v = c.ok ? (c.credential.meta as { briefsRun?: unknown } | null)?.briefsRun : undefined;
      if (typeof v !== "string") return null;
      try {
        return JSON.parse(v) as unknown;
      } catch {
        // A note that doesn't parse counts as no run, so the week can be run again.
        return null;
      }
    },
    async saveBriefsRun(workspaceId: string, note: unknown): Promise<boolean> {
      const c = await connection(workspaceId);
      return c.ok && (await deps.setMeta(workspaceId, c.credential.id, "briefsRun", JSON.stringify(note))).ok;
    },
  };
}
export type Seo = ReturnType<typeof createSeo>;
