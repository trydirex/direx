// SPDX-License-Identifier: AGPL-3.0-only
// Reads one public web page for a run. Every address the name resolves to must be public, and the
// connection goes to the address that was checked while the certificate is still checked against
// the name, so DNS can't change the answer in between. Each redirect is checked again. A failure
// is a named value: the run lists it and carries on.
import { lookup } from "node:dns/promises";
import { BlockList, isIP } from "node:net";

const MAX_REDIRECTS = 5;
const MAX_BYTES = 2 * 1024 * 1024;
const TIMEOUT_MS = 15_000;
/** What a model is shown of one page. */
const MAX_TEXT_CHARS = 50_000;
/** What code keeps of one page's HTML, the size of a stored snapshot. */
const MAX_HTML_CHARS = 200 * 1024;
/** Who Direx says it is on every read. A site's robots.txt is read under the same name, so its answer is about us. */
export const PAGE_READER_AGENT = "Direx-page-reader";

const BLOCKED = new BlockList();
for (const [net, bits] of [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.0.2.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["198.51.100.0", 24],
  ["203.0.113.0", 24],
  ["224.0.0.0", 4],
  ["240.0.0.0", 4],
] as const) {
  BLOCKED.addSubnet(net, bits, "ipv4");
}
for (const [net, bits] of [
  ["::", 128],
  ["::1", 128],
  ["64:ff9b::", 96],
  ["100::", 64],
  ["2001::", 32],
  ["2001:db8::", 32],
  ["2002::", 16],
  ["fc00::", 7],
  ["fe80::", 10],
  ["fec0::", 10],
  ["ff00::", 8],
] as const) {
  BLOCKED.addSubnet(net, bits, "ipv6");
}

/** The IPv4 address inside an IPv4-mapped IPv6 address, in either spelling. */
function mappedV4(ip: string): string | null {
  const m = /^::ffff:(?:(\d+\.\d+\.\d+\.\d+)|([0-9a-f]{1,4}):([0-9a-f]{1,4}))$/i.exec(ip);
  if (!m) return null;
  if (m[1]) return m[1];
  const [hi, lo] = [parseInt(m[2]!, 16), parseInt(m[3]!, 16)];
  return `${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`;
}

export function isPublicAddress(ip: string): boolean {
  const v4 = mappedV4(ip);
  if (v4) return isPublicAddress(v4);
  const family = isIP(ip);
  if (family === 0) return false;
  return !BLOCKED.check(ip, family === 4 ? "ipv4" : "ipv6");
}

const site = (host: string) => host.toLowerCase().replace(/^www\./, "");

/** The same host, a subdomain of it, or its www twin. */
export function sameSite(base: URL, target: URL): boolean {
  const [b, t] = [site(base.hostname), site(target.hostname)];
  return t === b || t.endsWith(`.${b}`);
}

export type PageFailure = "robots_disallowed" | "bad_address" | "other_site" | "private_address" | "no_address" | "too_many_redirects" | "not_text" | "too_large" | "timed_out" | "bad_certificate" | "unreachable" | "http_error";
export type PageResult = { ok: true; url: string; text: string; truncated: boolean; links?: string[] } | { ok: false; url: string; reason: PageFailure };
/** `base` is the address the person gave; `url` is the page wanted, on that site. */
export type FetchPage = (base: string, url: string, signal?: AbortSignal) => Promise<PageResult>;

type Resolve = (host: string) => Promise<{ address: string }[]>;
const systemResolve: Resolve = (host) => lookup(host, { all: true, verbatim: true });

/** One request to a checked address. The name goes in Host and in the TLS check. */
export function pinnedRequest(url: URL, address: string, signal: AbortSignal, tls?: { ca?: string }): Promise<Response> {
  const host = isIP(address) === 6 ? `[${address}]` : address;
  const port = url.port ? `:${url.port}` : "";
  const init = {
    headers: { Host: url.host, Accept: "text/html, text/plain;q=0.9, application/xml;q=0.8, text/xml;q=0.8", "User-Agent": PAGE_READER_AGENT },
    redirect: "manual",
    keepalive: false,
    signal,
    ...(url.protocol === "https:" && { tls: { serverName: url.hostname, ...tls } }),
  };
  return fetch(`${url.protocol}//${host}${port}${url.pathname}${url.search}`, init as RequestInit);
}

// The named entities pages use for text; any other name stays as written.
const ENTITIES: Record<string, string> = {
  amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ",
  rsquo: "’", lsquo: "‘", rdquo: "”", ldquo: "“", mdash: "—", ndash: "–", hellip: "…", bull: "•", middot: "·", copy: "©", reg: "®", trade: "™",
};
const entity = (whole: string, name: string) => {
  const code = name[0] !== "#" ? null : name[1] === "x" || name[1] === "X" ? parseInt(name.slice(2), 16) : parseInt(name.slice(1), 10);
  if (code === null) return ENTITIES[name] ?? whole;
  return code <= 0x10ffff ? String.fromCodePoint(code) : whole;
};

/** Good enough: a person reads whatever comes of this. */
export function htmlToText(html: string): string {
  return html
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<(script|style|noscript|template|svg)\b[\s\S]*?<\/\1\s*>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&(#\d{1,7}|#[xX][0-9a-fA-F]{1,6}|[a-zA-Z]{2,8});/g, entity)
    // Control characters, a null among them, are never text, and Postgres can't store a null in JSON.
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

const MAX_LINKS = 100;

/** One spelling for an address, so a run can compare what it asks for with what it may read. */
export function pageAddress(base: string, url: string): string | null {
  try {
    const u = new URL(url, base);
    u.hash = "";
    return u.href;
  } catch {
    return null;
  }
}

/**
 * The same-site links on a page, without query strings. A run may read only these and the address it
 * was given, because a page it reads can ask it to put what it knows into a URL. A link written before
 * the run started can't hold anything the run knows.
 */
export function linksIn(html: string, pageUrl: string, base: string): string[] {
  const out = new Set<string>();
  for (const [, href] of html.matchAll(/<a\b[^>]*?\bhref\s*=\s*["']?([^"'\s>]+)/gi)) {
    const address = pageAddress(pageUrl, href!);
    if (!address) continue;
    const u = new URL(address);
    if ((u.protocol !== "http:" && u.protocol !== "https:") || u.username || u.password || !sameSite(new URL(base), u)) continue;
    u.search = "";
    out.add(u.href);
    if (out.size === MAX_LINKS) break;
  }
  return [...out];
}

async function readLimited(res: Response, max: number): Promise<Buffer | null> {
  const reader = res.body?.getReader();
  if (!reader) return Buffer.alloc(0);
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.length;
    if (size > max) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks);
}

type Deps = { resolve?: Resolve; request?: typeof pinnedRequest };
type Fetched = { ok: true; url: string; status: number; type: string; body: string; bytes: Buffer } | { ok: false; url: string; reason: PageFailure; status?: number };

const isText = (type: string) => type.startsWith("text/") || type === "application/xhtml+xml";

export function createFetchPage(deps: Deps = {}): FetchPage {
  const fetchBody = createFetchBody(deps);
  return async (base, url, outer) => {
    const got = await fetchBody(base, url, outer, isText);
    if (!got.ok) return { ok: false, url: got.url, reason: got.reason };
    const plain = got.type === "text/plain";
    const text = plain ? got.body.replace(/\s+/g, " ").trim() : htmlToText(got.body);
    return { ok: true, url: got.url, text: text.slice(0, MAX_TEXT_CHARS), truncated: text.length > MAX_TEXT_CHARS, links: plain ? [] : linksIn(got.body, got.url, base) };
  };
}

export type SitemapResult = { ok: true; url: string; index: boolean; locs: string[] } | { ok: false; url: string; reason: PageFailure };
export type FetchSitemap = (base: string, url: string, signal?: AbortSignal) => Promise<SitemapResult>;

/**
 * The same-site addresses a sitemap lists, without query strings. `index` says they are more
 * sitemaps rather than pages. Its text never reaches a model.
 */
export function createFetchSitemap(deps: Deps = {}): FetchSitemap {
  const fetchBody = createFetchBody(deps);
  return async (base, url, outer) => {
    const got = await fetchBody(base, url, outer, (type) => type === "application/xml" || type === "text/xml");
    if (!got.ok) return { ok: false, url: got.url, reason: got.reason };
    return { ok: true, url: got.url, index: /<sitemapindex\b/i.test(got.body), locs: locsIn(got.body, base) };
  };
}

/** `status` is set on an `http_error`, so a caller can tell a missing robots.txt from a refused one. */
export type HtmlResult = { ok: true; url: string; status: number; html: string; truncated: boolean } | { ok: false; url: string; reason: PageFailure; status?: number };
type MayFollow = (destination: URL) => Promise<boolean>;
export type FetchHtml = (base: string, url: string, signal?: AbortSignal, mayFollow?: MayFollow) => Promise<HtmlResult>;

/**
 * A page's HTML for code to read, such as the addresses in its mailto: links, which the text a model
 * is shown loses. Same checks and limits as a page read; never shown to a model. `maxChars` lets a
 * reader that stores its own capped copy see the whole body, up to the read limit, so a footer
 * address on a long page isn't lost.
 */
export function createFetchHtml({ maxChars = MAX_HTML_CHARS, ...deps }: Deps & { maxChars?: number } = {}): FetchHtml {
  const fetchBody = createFetchBody(deps);
  return async (base, url, outer, mayFollow) => {
    const got = await fetchBody(base, url, outer, isText, MAX_BYTES, MAX_REDIRECTS, mayFollow);
    if (!got.ok) return got;
    return { ok: true, url: got.url, status: got.status, html: got.body.slice(0, maxChars), truncated: got.body.length > maxChars };
  };
}

export function locsIn(xml: string, base: string): string[] {
  const out = new Set<string>();
  for (const [, raw] of xml.matchAll(/<loc>\s*([^<]+?)\s*<\/loc>/gi)) {
    const address = pageAddress(base, raw!.replace(/&(amp|lt|gt|quot|apos);/g, (_, e: string) => ENTITIES[e]!));
    if (!address) continue;
    const u = new URL(address);
    if ((u.protocol !== "http:" && u.protocol !== "https:") || u.username || u.password || !sameSite(new URL(base), u)) continue;
    u.search = "";
    out.add(u.href);
  }
  return [...out];
}

/** One body from a public address on the person's site, if its type is one `accepts` takes. */
/** The image types a page's preview may show: no SVG, which can carry script. */
const IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);
/** [DEFAULT] The largest preview image kept. */
const MAX_IMAGE_BYTES = 1024 * 1024;
export type FetchImage = (url: string, signal?: AbortSignal) => Promise<{ ok: true; type: string; bytes: Buffer } | { ok: false; reason: PageFailure }>;

/** One image from a public address, with the same checks as a page read, for a link's preview card. */
export function createFetchImage(deps: Deps = {}): FetchImage {
  const fetchBody = createFetchBody(deps);
  return async (url, signal) => {
    // The image's own site is the base, so a CDN image may redirect within its CDN and nowhere else.
    const got = await fetchBody(url, url, signal, (t) => IMAGE_TYPES.has(t), MAX_IMAGE_BYTES);
    return got.ok ? { ok: true, type: got.type, bytes: got.bytes } : { ok: false, reason: got.reason };
  };
}

/** [DEFAULT] The largest JSON document read: an OAuth client's metadata is a few hundred bytes. */
const MAX_JSON_BYTES = 64 * 1024;
export type JsonResult = { ok: true; url: string; value: unknown } | { ok: false; url: string; reason: PageFailure | "not_json" };
export type FetchJson = (url: string, signal?: AbortSignal) => Promise<JsonResult>;

/**
 * One JSON document at a public https address, such as an OAuth client's metadata document for the
 * door (door-oauth spec). The same address checks as a page read, but no redirect at all: the
 * document's address is its identity, so it must answer where it says it is.
 */
export function createFetchJson(deps: Deps = {}): FetchJson {
  const fetchBody = createFetchBody(deps);
  return async (url, signal) => {
    if (!URL.canParse(url) || new URL(url).protocol !== "https:") return { ok: false, url, reason: "bad_address" };
    const got = await fetchBody(url, url, signal, (t) => t === "application/json", MAX_JSON_BYTES, 0);
    if (!got.ok) return { ok: false, url, reason: got.reason };
    try {
      return { ok: true, url: got.url, value: JSON.parse(got.body) as unknown };
    } catch {
      return { ok: false, url, reason: "not_json" };
    }
  };
}

async function resolveBeforeAbort(resolve: Resolve, host: string, signal: AbortSignal) {
  const { promise, reject } = Promise.withResolvers<never>();
  const abort = () => reject(signal.reason);
  signal.addEventListener("abort", abort, { once: true });
  try {
    return await Promise.race([promise, resolve(host).catch(() => [])]);
  } finally {
    signal.removeEventListener("abort", abort);
  }
}

function createFetchBody({ resolve = systemResolve, request = pinnedRequest }: Deps) {
  return async (base: string, url: string, outer: AbortSignal | undefined, accepts: (type: string) => boolean, maxBytes = MAX_BYTES, redirects = MAX_REDIRECTS, mayFollow?: MayFollow): Promise<Fetched> => {
    const signal = AbortSignal.any([AbortSignal.timeout(TIMEOUT_MS), ...(outer ? [outer] : [])]);
    const fail = (reason: PageFailure): Fetched => ({ ok: false, url, reason });
    let baseUrl: URL;
    let current: URL;
    try {
      baseUrl = new URL(base);
      current = new URL(url, baseUrl);
    } catch {
      return fail("bad_address");
    }

    try {
      for (let hop = 0; hop <= redirects; hop++) {
        if (current.protocol !== "http:" && current.protocol !== "https:") return fail("bad_address");
        if (current.username || current.password) return fail("bad_address");
        if (!sameSite(baseUrl, current)) return fail("other_site");

        signal.throwIfAborted();
        const host = current.hostname.replace(/^\[|\]$/g, "");
        const answers = isIP(host) ? [{ address: host }] : await resolveBeforeAbort(resolve, host, signal);
        if (answers.length === 0) return fail("no_address");
        if (!answers.every((a) => isPublicAddress(a.address))) return fail("private_address");

        signal.throwIfAborted();
        if (hop > 0 && mayFollow && !(await mayFollow(current))) return fail("robots_disallowed");
        signal.throwIfAborted();
        const res = await request(current, answers[0]!.address, signal);
        if (res.status >= 300 && res.status < 400) {
          await res.body?.cancel();
          const next = res.headers.get("location");
          if (!next) return fail("http_error");
          try {
            current = new URL(next, current);
          } catch {
            return fail("bad_address");
          }
          continue;
        }
        if (!res.ok) {
          await res.body?.cancel();
          return { ok: false, url, reason: "http_error", status: res.status };
        }
        const type = (res.headers.get("content-type") ?? "").split(";")[0]!.trim().toLowerCase();
        if (!accepts(type)) {
          await res.body?.cancel();
          return fail("not_text");
        }
        const bytes = await readLimited(res, maxBytes);
        if (bytes === null) return fail("too_large");
        return { ok: true, url: current.href, status: res.status, type, body: new TextDecoder().decode(bytes), bytes };
      }
      return fail("too_many_redirects");
    } catch (e) {
      const err = e as { code?: string; name?: string };
      if (signal.aborted || err.name === "TimeoutError" || err.name === "AbortError") return fail("timed_out");
      if (/CERT|TLS|SSL/i.test(err.code ?? "")) return fail("bad_certificate");
      return fail("unreachable");
    }
  };
}
