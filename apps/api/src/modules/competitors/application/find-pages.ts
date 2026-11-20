// SPDX-License-Identifier: AGPL-3.0-only
// Find pages: reads a competitor's homepage, its robots.txt and up to 4 sitemap files, and, when no
// changelog turned up, the roadmap page the homepage links. Only code reads what comes back. The
// answer goes to the person who asked and is not stored; nothing is saved until they add the competitor.
import { allowed, createFetchHtml, createFetchSitemap, PAGE_READER_AGENT, robotsFrom, type FetchHtml, type FetchSitemap } from "../../agents/index";
import { changelogOf, findPages, keep, linksIn, roadmapOf, sitemapsIn, type FoundPages, type Link } from "../domain/find-pages";

const MAX_SITEMAP_FILES = 4;
/** The same cap as the about page's sitemap walk. */
const MAX_CHILD_SITEMAPS = 3;
const TIMEOUT_MS = 30_000;

export type SiteReadDeps = { fetchHtml?: FetchHtml; fetchSitemap?: FetchSitemap };
type Robots = { text: string; may: (url: URL) => boolean };

/**
 * One site's reads under robots.txt, each origin's file read once, a redirect followed only where
 * robots.txt allows it, and every step stopped by `signal`. `given` is the site every read stays on.
 */
export function siteReader(given: string, signal: AbortSignal, deps: SiteReadDeps = {}) {
  const fetchHtml = deps.fetchHtml ?? createFetchHtml({ maxChars: Infinity });
  const fetchSitemap = deps.fetchSitemap ?? createFetchSitemap();
  const robotsByOrigin = new Map<string, Promise<Robots>>();
  const robotsOf = (url: URL) => {
    signal.throwIfAborted();
    const hit = robotsByOrigin.get(url.origin);
    if (hit) return hit;
    const read = fetchHtml(given, `${url.origin}/robots.txt`, signal).then((r) => {
      signal.throwIfAborted();
      const robots = robotsFrom(r.ok ? r : { ok: false, status: r.status });
      return { text: r.ok ? r.html : "", may: (u: URL) => allowed(robots, PAGE_READER_AGENT, u.pathname + u.search) };
    });
    robotsByOrigin.set(url.origin, read);
    return read;
  };
  const mayRead = async (url: URL) => (await robotsOf(url)).may(url);
  /** One page, or why it couldn't be read; null when robots.txt keeps us out of it. */
  const page = async (url: string) => {
    if (!(await mayRead(new URL(url)))) return null;
    const read = await fetchHtml(given, url, signal, mayRead);
    signal.throwIfAborted();
    return read;
  };
  return {
    robotsOf,
    page,
    /** A page's links, or null when it couldn't be read. */
    async links(url: string): Promise<Link[] | null> {
      const read = await page(url);
      return read?.ok ? linksIn(read.html, read.url) : null;
    },
    /** The addresses in the sitemaps robots.txt names, else /sitemap.xml: at most 4 files, 3 of them an index's children. */
    async sitemap(): Promise<string[]> {
      const home = new URL(given);
      const sitemaps = sitemapsIn((await robotsOf(home)).text);
      if (sitemaps.length === 0) sitemaps.push(`${home.origin}/sitemap.xml`);
      const locs: string[] = [];
      let children = 0;
      for (let i = 0; i < sitemaps.length && i < MAX_SITEMAP_FILES; i++) {
        const map = await fetchSitemap(given, sitemaps[i]!, signal);
        signal.throwIfAborted();
        if (!map.ok) continue;
        if (!map.index) locs.push(...map.locs);
        else for (const loc of map.locs) if (children++ < MAX_CHILD_SITEMAPS) sitemaps.push(loc);
      }
      return locs;
    },
  };
}

export type FindResult = FoundPages | { ok: false; reason: "robots_disallowed" | "unreadable"; detail?: string } | { ok: false; reason: "busy" };
export type FindPages = (workspaceId: string, landingUrl: string) => Promise<FindResult>;

export function createFindPages(deps: SiteReadDeps & { timeoutMs?: number } = {}): FindPages {
  // ponytail: one process's lock; two API processes could each run one for a Workspace, which only costs a few reads.
  const running = new Set<string>();

  async function find(given: string, signal: AbortSignal): Promise<FindResult> {
    const site = siteReader(given, signal, deps);
    const home = new URL(given);
    const robots = await site.robotsOf(home);
    const page = await site.page(given);
    if (!page || (!page.ok && page.reason === "robots_disallowed")) return { ok: false, reason: "robots_disallowed" };
    if (!page.ok) return page.reason === "other_site" ? { ok: false, reason: "other_site" } : { ok: false, reason: "unreadable", detail: page.status ? `${page.reason} ${page.status}` : page.reason };
    const locs = await site.sitemap();

    // Addresses on the homepage's own host that its robots.txt keeps us out of are dropped. Others
    // are only proposed, and adding the competitor reads them with their own robots.txt first.
    const mayPropose = (c: { url: string }) => new URL(c.url).host !== home.host || robots.may(new URL(c.url));
    const candidates = [...keep(given, linksIn(page.html, page.url), "homepage"), ...keep(given, locs.map((url) => ({ url, text: "" })), "sitemap")].filter(mayPropose);
    const found = findPages(given, page.url, candidates);
    if (!found.ok || found.changelog) return found;
    const roadmap = roadmapOf(candidates);
    const onRoadmap = roadmap ? await site.links(roadmap) : null;
    return onRoadmap ? { ...found, changelog: changelogOf(keep(given, onRoadmap, "roadmap").filter(mayPropose)) } : found;
  }

  return async (workspaceId, landingUrl) => {
    if (running.has(workspaceId)) return { ok: false, reason: "busy" };
    running.add(workspaceId);
    try {
      const signal = AbortSignal.timeout(deps.timeoutMs ?? TIMEOUT_MS);
      const result = await find(landingUrl, signal);
      signal.throwIfAborted();
      return result;
    } catch (e) {
      if (e instanceof DOMException && e.name === "TimeoutError") return { ok: false, reason: "unreadable", detail: "timed_out" };
      throw e;
    } finally {
      running.delete(workspaceId);
    }
  };
}
