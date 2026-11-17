// SPDX-License-Identifier: AGPL-3.0-only
// Pure: the link a post's preview card shows, and what a page says about itself for that card.

/** `image` is the address the page names for its card's picture; Direx fetches it, the browser never does. */
export type LinkPreview = { title: string | null; description: string | null; site: string; image: string | null };
/** What a post keeps: the link it read, what it found (null when the page couldn't be read) and when. */
export type KeptPreview = { url: string; preview: LinkPreview | null; at?: string };

/** [DEFAULT] How long a page that couldn't be read waits before it's tried again. */
export const RETRY_MS = 86_400_000;

/** Whether to read the page now: a new link, or one whose page failed more than RETRY_MS ago. */
export const mustRead = (kept: KeptPreview | null, url: string, now: Date) =>
  kept?.url !== url || (kept.preview === null && now.getTime() - new Date(kept.at ?? 0).getTime() > RETRY_MS);

/** The first http or https address in a post's text, without trailing punctuation. */
export function firstLink(text: string): string | null {
  const m = /\bhttps?:\/\/[^\s<>"']+/i.exec(text);
  if (!m) return null;
  const url = m[0].replace(/[.,;:!?)\]]+$/, "");
  try {
    return new URL(url).toString();
  } catch {
    return null;
  }
}

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", "#39": "'", nbsp: " " };
const decode = (s: string) => s.replace(/&(amp|lt|gt|quot|apos|#39|nbsp);/g, (_, e: string) => ENTITIES[e]!).replace(/\s+/g, " ").trim();
const MAX = 300;
const clip = (s: string | undefined) => {
  const t = s && decode(s);
  return t ? (t.length > MAX ? `${t.slice(0, MAX - 1)}…` : t) : null;
};

/** The page's Open Graph (or Twitter, or plain) title, description and site name, as a network's card shows them. */
export function previewOf(html: string, url: string): LinkPreview {
  const meta = new Map<string, string>();
  for (const tag of html.match(/<meta\b[^>]*>/gi) ?? []) {
    const attrs = new Map<string, string>();
    for (const a of tag.matchAll(/([a-z:-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/gi)) attrs.set(a[1]!.toLowerCase(), a[2] ?? a[3] ?? "");
    const key = (attrs.get("property") ?? attrs.get("name"))?.toLowerCase();
    const content = attrs.get("content");
    if (key && content !== undefined && !meta.has(key)) meta.set(key, content);
  }
  const title = /<title[^>]*>([^<]*)<\/title>/i.exec(html)?.[1];
  const image = meta.get("og:image") ?? meta.get("og:image:url") ?? meta.get("twitter:image");
  let imageUrl: string | null = null;
  try {
    const u = image ? new URL(decode(image), url) : null;
    if (u && (u.protocol === "https:" || u.protocol === "http:")) imageUrl = u.toString();
  } catch {
    imageUrl = null;
  }
  return {
    image: imageUrl,
    title: clip(meta.get("og:title") ?? meta.get("twitter:title") ?? title),
    description: clip(meta.get("og:description") ?? meta.get("twitter:description") ?? meta.get("description")),
    site: clip(meta.get("og:site_name")) ?? new URL(url).hostname.replace(/^www\./, ""),
  };
}

/** The image type its first bytes say, among the four a preview may show, or null. A server's
    content-type isn't trusted on its own: what Direx serves back is what the bytes are. */
export function imageType(bytes: Uint8Array): string | null {
  const b = (i: number) => bytes[i];
  if (b(0) === 0x89 && b(1) === 0x50 && b(2) === 0x4e && b(3) === 0x47) return "image/png";
  if (b(0) === 0xff && b(1) === 0xd8 && b(2) === 0xff) return "image/jpeg";
  if (b(0) === 0x47 && b(1) === 0x49 && b(2) === 0x46 && b(3) === 0x38) return "image/gif";
  if (String.fromCharCode(...bytes.slice(0, 4)) === "RIFF" && String.fromCharCode(...bytes.slice(8, 12)) === "WEBP") return "image/webp";
  return null;
}
