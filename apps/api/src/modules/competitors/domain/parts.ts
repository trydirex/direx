// SPDX-License-Identifier: AGPL-3.0-only
// Pure: the parts of a competitor's page that are compared week to week, never the whole page.
// A page is cut into blocks at block tags; the caller turns each block's HTML into text.

export type Block = { tag: string; html: string };
export type Line = { tag: string; text: string };
export type LandingParts = { title: string | null; description: string | null; headline: string | null; subhead: string | null };

/** Never compared as lines: the head (its title is kept apart), scripts, icons, menus and the page's frame, where cookie bars sit. */
export const DROPPED = ["head", "script", "style", "svg", "noscript", "template", "nav", "header", "footer"] as const;
const BLOCK_TAG = /<\/?(p|li|h[1-6]|div|tr|br|dt|dd|section|article)\b[^>]*>/gi;

/** The page's blocks in order. Each starts at a block tag, named by it when it opens one. */
export function blocks(html: string, dropped: readonly string[] = DROPPED): Block[] {
  let body = html.replace(/<!--[\s\S]*?-->/g, " ");
  // Unclosed runs to the end: the reader caps a page, which can cut a large inline script before its close (r64: Canny).
  for (const tag of dropped) body = body.replace(new RegExp(`<${tag}\\b[\\s\\S]*?(<\\/${tag}\\s*>|$)`, "gi"), " ");
  // A line break inside a heading is a space, so "Your fully<br>automated close" stays one headline.
  body = body.replace(/<(h[1-6])\b[^>]*>[\s\S]*?<\/\1\s*>/gi, (h) => h.replace(/<br\b[^>]*>/gi, " "));
  const out: Block[] = [];
  let tag = "";
  let from = 0;
  for (const m of body.matchAll(BLOCK_TAG)) {
    out.push({ tag, html: body.slice(from, m.index) });
    tag = m[0][1] === "/" ? "" : m[1]!.toLowerCase();
    from = m.index + m[0].length;
  }
  out.push({ tag, html: body.slice(from) });
  return out;
}

/** Numeric character references ("&#x2715;", "&#8217;") as characters; a code point that can't exist is dropped. */
const decode = (s: string) =>
  s.replace(/&#(x[0-9a-f]+|\d+);/gi, (_, n: string) => {
    const code = n[0] === "x" || n[0] === "X" ? parseInt(n.slice(1), 16) : Number(n);
    return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : "";
  });
const fold = (s: string) => decode(s).replace(/\s+/g, " ").trim();

/** "3 days ago", "yesterday": words that change every week while nothing happens. */
export const isRelativeTime = (line: string) => /^((\d+|an?|one)\s+(second|minute|hour|day|week|month|year)s?\s+ago|yesterday|today|just now)$/i.test(fold(line));

/** Lines with text, each once, without relative times. */
export function cleanLines(lines: Line[]): Line[] {
  const seen = new Set<string>();
  return lines.flatMap((l) => {
    const text = fold(l.text);
    if (!text || isRelativeTime(text) || seen.has(text)) return [];
    seen.add(text);
    return [{ tag: l.tag, text }];
  });
}

/** A changelog: every line, since a real change can sit in one line of a "General improvements" entry (r64 §8). */
export const changelogLines = (lines: Line[]) => cleanLines(lines).map((l) => l.text);

/** A pricing page: headings and every line with a digit, which holds plan names, prices and limits. */
export const pricingLines = (lines: Line[]) =>
  cleanLines(lines)
    .filter((l) => /^h[1-4]$/.test(l.tag) || /\d/.test(l.text))
    .map((l) => l.text);

/** A landing page: the head's title and description, the first h1 and the first h2 or p after it. */
export function landingParts(lines: Line[], head: { title: string | null; metaDescription: string | null }): LandingParts {
  const kept = cleanLines(lines);
  const at = kept.findIndex((l) => l.tag === "h1");
  const subhead = at < 0 ? undefined : kept.slice(at + 1).find((l) => l.tag === "h2" || l.tag === "p");
  return { title: head.title, description: head.metaDescription, headline: at < 0 ? null : kept[at]!.text, subhead: subhead?.text ?? null };
}
