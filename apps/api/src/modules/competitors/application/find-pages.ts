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

export type FindResult = FoundPages | { ok: false; reason: "robots_disallowed" | "unreadable"; detail?: string } | { ok: false; reason: "busy" };
export type FindPages = (workspaceId: string, landingUrl: string) => Promise<FindResult>;

export function createFindPages(deps: { fetchHtml?: FetchHtml; fetchSitemap?: FetchSitemap; timeoutMs?: number } = {}): FindPages {
  const fetchHtml = deps.fetchHtml ?? createFetchHtml({ maxChars: Infinity });
  const fetchSitemap = deps.fetchSitemap ?? createFetchSitemap();
  // ponytail: one process's lock; two API processes could each run one for a Workspace, which only costs a few reads.
  const running = new Set<string>();

  async function find(given: string, signal: AbortSignal): Promise<FindResult> {
    const robotsByOrigin = new Map<string, Promise<{ text: string; may: (url: URL) => boolean }>>();
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
    const readLinks = async (url: string): Promise<Link[] | null> => {
      const u = new URL(url);
      if (!(await mayRead(u))) return null;
      const page = await fetchHtml(given, url, signal, mayRead);
      signal.throwIfAborted();
      return page.ok ? linksIn(page.html, page.url) : null;
    };

    const home = new URL(given);
    const robots = await robotsOf(home);
    if (!robots.may(home)) return { ok: false, reason: "robots_disallowed" };
    const page = await fetchHtml(given, given, signal, mayRead);
    signal.throwIfAborted();
    if (!page.ok && page.reason === "robots_disallowed") return { ok: false, reason: page.reason };
    if (!page.ok) return page.reason === "other_site" ? { ok: false, reason: "other_site" } : { ok: false, reason: "unreadable", detail: page.status ? `${page.reason} ${page.status}` : page.reason };

    const sitemaps = sitemapsIn(robots.text);
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

    // Addresses on the homepage's own host that its robots.txt keeps us out of are dropped. Others
    // are only proposed, and adding the competitor reads them with their own robots.txt first.
    const mayPropose = (c: { url: string }) => new URL(c.url).host !== home.host || robots.may(new URL(c.url));
    const candidates = [...keep(given, linksIn(page.html, page.url), "homepage"), ...keep(given, locs.map((url) => ({ url, text: "" })), "sitemap")].filter(mayPropose);
    const found = findPages(given, page.url, candidates);
    if (!found.ok || found.changelog) return found;
    const roadmap = roadmapOf(candidates);
    const onRoadmap = roadmap ? await readLinks(roadmap) : null;
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
