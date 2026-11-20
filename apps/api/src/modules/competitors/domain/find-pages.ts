// SPDX-License-Identifier: AGPL-3.0-only
// Pure: which of a competitor's addresses look like its pricing page and its changelog. Code picks
// them from the homepage's links and the sitemap, never a model, so a page can't steer the answer.
// A person sees each one with where it was found and decides; nothing here is saved.

export type Via = "homepage" | "sitemap" | "roadmap";
export type Link = { url: string; text: string };
export type Candidate = Link & { via: Via };
export type Found = { url: string; via: Via; text: string };
export type FoundPages =
  | { ok: true; pricing: Found | null; changelog: Found | null; alsoPricing: string[] }
  /** The address goes to another company's site (keeper.app lands on doublehq.com). The host is left out when the read was refused at the redirect. */
  | { ok: false; reason: "other_site"; host?: string };

/** Services that host a changelog on their own domain, linked from the competitor's homepage. */
export const HOSTED_CHANGELOGS = ["canny.io", "headwayapp.co", "launchnotes.io", "productboard.com", "featurebase.app", "frill.co", "getbeamer.com", "announcekit.app", "noticeable.news"] as const;

const site = (host: string) => host.toLowerCase().replace(/^www\./, "");
const onDomain = (host: string, domain: string) => host === domain || host.endsWith(`.${domain}`);

/** The same host, a subdomain of it, or its www twin: roadmap.xenett.com is on xenett.com. */
export const sameSite = (base: URL, target: URL) => onDomain(site(target.hostname), site(base.hostname));
export const hosted = (u: URL) => HOSTED_CHANGELOGS.some((d) => onDomain(u.hostname.toLowerCase(), d));

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", "#39": "'", nbsp: " " };
const textOf = (text: string) => text.replace(/&(amp|lt|gt|quot|apos|#39|nbsp);/g, (_, e: string) => ENTITIES[e]!).replace(/\s+/g, " ").trim();

/** Every http(s) link on a page with its text, without query or fragment, each address once. */
export function linksIn(html: string, pageUrl: string): Link[] {
  const out = new Map<string, Link>();
  let chunks: string[] = [];
  // Tokenize once. Looking ahead for a closing tag from each opening tag rescans malformed pages.
  new HTMLRewriter().on("a", {
    element(anchor) {
      chunks = [];
      const href = anchor.getAttribute("href");
      if (!href) return;
      let u: URL;
      try {
        u = new URL(href.replace(/&amp;/g, "&"), pageUrl);
      } catch {
        return;
      }
      if ((u.protocol !== "http:" && u.protocol !== "https:") || u.username || u.password) return;
      u.search = "";
      u.hash = "";
      const label = chunks;
      anchor.onEndTag(() => {
        const text = textOf(label.join(""));
        const seen = out.get(u.href);
        if (!seen || (!seen.text && text)) out.set(u.href, { url: u.href, text });
      });
    },
    text(chunk) {
      chunks.push(chunk.text);
      if (chunk.lastInTextNode) chunks.push(" ");
    },
  }).transform(html);
  return [...out.values()];
}

/** The sitemaps a robots.txt names. */
export const sitemapsIn = (robots: string) => [...robots.matchAll(/^\s*sitemap\s*:\s*(\S+)/gim)].map((m) => m[1]!);

const path = (u: URL) => u.pathname.replace(/\/+$/, "").split("/").filter(Boolean);
const last = (u: URL) => (path(u).at(-1) ?? "").toLowerCase();

const PRICING = /^(pricing|prices?|plans|pricing-plans|plans-pricing|plans-and-pricing)$/;
/** Finlens's founders-pricing; one level deep only, so a blog post about pricing isn't one. */
const NAMED_PRICING = /^[a-z0-9-]+-pricing$/;
const PRICING_TEXT = /^(pricing|plans|plans (&|and) pricing)$/i;
const CHANGELOG = /^(change-?s?-?log(ging|s)?|releases?|release-notes|release-logs?|whats-new|what-s-new|product-updates|updates|announcements)$/;
const CHANGELOG_TEXT = /^(changelog|change log|what'?s new|release notes|product updates|updates|announcements)$/i;
/** These name the page itself, so they beat a generic "updates". */
const STRONG = /^(change-?s?-?log(ging|s)?|announcements|release-notes|release-logs?)$/;

const byLength = (a: Candidate, b: Candidate) => a.url.length - b.url.length;
const found = (c: Candidate | undefined): Found | null => (c ? { url: c.url, via: c.via, text: c.text } : null);

function isPricing(c: Candidate) {
  const u = new URL(c.url);
  const depth = path(u).length;
  return depth <= 2 && (PRICING.test(last(u)) || (depth === 1 && NAMED_PRICING.test(last(u))) || PRICING_TEXT.test(c.text));
}

/** The shortest pricing page; the others the homepage links are "also found" (a sitemap's are regional copies). */
function pricingOf(cands: readonly Candidate[]) {
  const hits = cands.filter(isPricing).sort(byLength);
  const also = hits.slice(1).filter((c) => c.via === "homepage" && c.url !== hits[0]!.url);
  return { pricing: found(hits[0]), alsoPricing: [...new Set(also.map((c) => c.url))] };
}

function isChangelog(c: Candidate) {
  const u = new URL(c.url);
  const seg = last(u);
  if (seg === "roadmap" || path(u).length > 2) return false;
  if (hosted(u)) return /changelog|announcement|update/i.test(u.pathname) || CHANGELOG_TEXT.test(c.text);
  return CHANGELOG.test(seg) || CHANGELOG_TEXT.test(c.text);
}

/** The changelog among the candidates: a page that names itself one beats a generic "updates". */
export function changelogOf(cands: readonly Candidate[]): Found | null {
  const hits = cands.filter(isChangelog).sort(byLength);
  return found(hits.find((c) => STRONG.test(last(new URL(c.url)))) ?? hits[0]);
}

/** A roadmap page linked from the homepage, read once when no changelog was found: Xenett's links its announcements. */
export function roadmapOf(cands: readonly Candidate[]): string | null {
  return cands.filter((c) => c.via === "homepage" && last(new URL(c.url)) === "roadmap").sort(byLength)[0]?.url ?? null;
}

/** Same-site addresses and hosted changelog services only; anything else on a page is ignored. */
export function keep(given: string, links: readonly Link[], via: Via): Candidate[] {
  const base = new URL(given);
  return links.filter((l) => sameSite(base, new URL(l.url)) || (via !== "sitemap" && hosted(new URL(l.url)))).map((l) => ({ ...l, via }));
}

/** `given` is the address the person typed; `finalUrl` is where its homepage landed. */
export function findPages(given: string, finalUrl: string, cands: readonly Candidate[]): FoundPages {
  const landed = new URL(finalUrl);
  if (!sameSite(new URL(given), landed)) return { ok: false, reason: "other_site", host: site(landed.hostname) };
  return { ok: true, ...pricingOf(cands), changelog: changelogOf(cands) };
}
