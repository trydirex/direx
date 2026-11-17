// SPDX-License-Identifier: AGPL-3.0-only
// Reads one public page for SEO: robots.txt first, under the same name and limits a company read
// uses, then the page. Its head's title and description, its text and a capped copy of its HTML are
// kept. A page larger than the read limit is refused; one larger than the stored copy is cut.
import { allowed, capped, createFetchHtml, htmlToText, PAGE_READER_AGENT, robotsFrom, type FetchHtml } from "../../agents/index";

export type PageRead =
  | { ok: true; url: string; finalUrl: string; title: string | null; metaDescription: string | null; html: string; text: string; truncated: boolean; readAt: Date }
  | { ok: false; reason: "robots_disallowed" | "not_html" | "too_big" | "failed"; detail?: string };

/** `fetchHtml` must not cut the body itself, so the head and text come from the whole page. */
export type PageReaderDeps = { fetchHtml?: FetchHtml; now?: () => Date };

const headOf = (html: string) => html.split(/<\/head\s*>/i)[0]!;
const tidy = (raw: string | undefined) => (raw === undefined ? null : htmlToText(raw) || null);

function titleOf(html: string): string | null {
  return tidy(/<title\b[^>]*>([\s\S]*?)<\/title\s*>/i.exec(headOf(html))?.[1]);
}

function metaDescriptionOf(html: string): string | null {
  for (const [tag] of headOf(html).matchAll(/<meta\b[^>]*>/gi)) {
    if (!/\bname\s*=\s*["']?description["'\s/>]/i.test(tag!)) continue;
    return tidy(/\bcontent\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))/i.exec(tag!)?.slice(1).find((v) => v !== undefined));
  }
  return null;
}

/** The title, meta description and text of a page's HTML, as a read keeps them. */
export const pageParts = (html: string) => ({ title: titleOf(html), metaDescription: metaDescriptionOf(html), text: htmlToText(html) });

export function createPageReader(deps: PageReaderDeps = {}) {
  const fetchHtml = deps.fetchHtml ?? createFetchHtml({ maxChars: Infinity });
  const now = deps.now ?? (() => new Date());

  return async function readPage(url: string): Promise<PageRead> {
    let page: URL;
    try {
      page = new URL(url);
    } catch {
      return { ok: false, reason: "failed", detail: "bad_address" };
    }
    const robotsAnswer = await fetchHtml(url, "/robots.txt");
    const robots = robotsFrom(robotsAnswer.ok ? robotsAnswer : { ok: false, status: robotsAnswer.status });
    if (!allowed(robots, PAGE_READER_AGENT, page.pathname + page.search)) return { ok: false, reason: "robots_disallowed" };

    const got = await fetchHtml(url, url);
    if (!got.ok) {
      if (got.reason === "not_text") return { ok: false, reason: "not_html" };
      if (got.reason === "too_large") return { ok: false, reason: "too_big" };
      return { ok: false, reason: "failed", detail: got.status ? `${got.reason} ${got.status}` : got.reason };
    }
    const html = capped(got.html);
    return {
      ok: true,
      url,
      finalUrl: got.url,
      title: titleOf(got.html),
      metaDescription: metaDescriptionOf(got.html),
      html,
      text: capped(htmlToText(got.html)),
      truncated: got.truncated || html !== got.html,
      readAt: now(),
    };
  };
}
