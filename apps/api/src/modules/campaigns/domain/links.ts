// SPDX-License-Identifier: AGPL-3.0-only
// Addresses in a draft that came from nowhere the business vouches for. A hostile page can ask a run
// to add its own link, so an address counts only if a Fact names the very same host; anything else
// waits for a person. There is no list of known endings, so evil.shop is an address like any other.
import { sameIgnoringUtm } from "./step-links";

const STOP = `\\s<>"'()\\[\\]`;
const LINK = new RegExp(
  [
    `https?:\\/\\/[^${STOP}]+`,
    `www\\.[^${STOP}]+`,
    `[\\p{L}\\p{N}._%+-]+@[\\p{L}\\p{N}-]+(?:\\.[\\p{L}\\p{N}-]+)+`,
    // A bare name.name: not inside a word, an address or a path, and ending in 2 to 24 letters.
    `(?<![\\p{L}\\p{N}_@./:-])(?:[\\p{L}\\p{N}-]+\\.)+\\p{L}{2,24}(?![\\p{L}\\p{N}_-])(?:\\/[^${STOP}]*)?`,
  ].join("|"),
  "giu",
);
// File names look like addresses. None of these endings is a domain anyone can register.
const FILE_ENDINGS = new Set(["pdf", "doc", "docx", "xls", "xlsx", "ppt", "pptx", "png", "jpg", "jpeg", "gif", "svg", "txt", "csv", "json", "md", "js", "ts", "html", "htm"]);

const lastLabel = (link: string) => /\.(\p{L}+)$/u.exec(link.split(/[/?#]/)[0]!)?.[1]?.toLowerCase();

export const linksIn = (text: string): string[] => {
  // NFKC first, so full-width letters and dots read as the plain ones they stand for.
  const found = text.normalize("NFKC").match(LINK) ?? [];
  const links = found.map((l) => l.replace(/[.,;:!?]+$/, "")).filter((l) => /[:@]/.test(l) || !FILE_ENDINGS.has(lastLabel(l) ?? ""));
  return [...new Set(links)];
};

/** The host an address points at, or null when it can't be read as plain ASCII. */
export const hostOf = (link: string): string | null => {
  const raw = !link.includes("://") && link.includes("@") ? `https://${link.slice(link.lastIndexOf("@") + 1)}` : link.includes("://") ? link : `https://${link}`;
  try {
    // URL turns look-alike letters into xn-- form, and those never match a Fact's host.
    const host = new URL(raw).hostname.toLowerCase().replace(/\.$/, "").replace(/^www\./, "");
    return /^[a-z0-9.-]+$/.test(host) && !host.split(".").some((l) => l.startsWith("xn--")) ? host : null;
  } catch {
    return null;
  }
};

/**
 * `own` holds URLs Direx itself put in the text, such as the page a step waits on. Only that exact URL
 * passes, its utm_ parameters aside; another path on the same host still waits for a person.
 */
export const foreignLinks = (text: string, vouched: string, own: readonly string[] = []): string[] => {
  const allowed = new Set(linksIn(vouched).map(hostOf).filter((h): h is string => h !== null));
  return linksIn(text).filter((l) => {
    if (own.some((o) => sameIgnoringUtm(l, o))) return false;
    const host = hostOf(l);
    return host === null || !allowed.has(host);
  });
};
