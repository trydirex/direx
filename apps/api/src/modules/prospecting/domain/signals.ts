// SPDX-License-Identifier: AGPL-3.0-only
// Signals a company read shows a person: the firm is hiring, or its blog has gone quiet. Code finds each one
// in the page text and quotes it, so a reviewer reads the words on the page. A model never supplies a signal.

export const SIGNAL_TYPES = ["hiring", "stale_blog"] as const;
export type SignalType = (typeof SIGNAL_TYPES)[number];
/** `observedOn` (YYYY-MM-DD) is the day the page was read for hiring, and the newest post's date for a stale blog. */
export type Signal = { type: SignalType; quote: string; pageUrl: string; observedOn: string };
export type PageText = { url: string; text: string };

export const STALE_AFTER_DAYS = 180;
const DAY_MS = 86_400_000;
const MAX_QUOTE = 300;

// "Hiring" alone is too loose: a recruiter "helps clients with hiring". The firm has to say it about itself, or list openings.
const HIRING = /\b(?:we(?:'|’)re|we are) (?:currently |now |actively |also )?hiring\b|\bnow hiring\b|\b(?:open|current) (?:positions|roles|openings|vacancies)\b|\bjob openings\b/i;
// Only a careers page earns a bare call to apply; elsewhere it could be a newsletter or a programme.
const APPLY = /\b(?:apply (?:now|today|here)|view (?:the )?(?:role|job|position))\b/i;
const NOT_HIRING = /\b(?:not|no longer) (?:currently )?(?:hiring|accepting applications)\b|\bno (?:current |open )*(?:positions|roles|openings|vacancies|jobs)\b|\bhas been filled\b/i;
const CLOSING = /\b(?:closing date|closes|closed|apply by|deadline)\b/i;
// A date beside these words is about the page or the firm, not a post.
const NOT_A_POST = /\b(?:updated|modified|revised|effective|copyright|founded|established)\b|©/i;
const BLOG_PATH = /\/(?:blog|news|insights|articles|posts|journal)(?:\/|$)/i;
const CAREERS_PATH = /\/(?:careers?|jobs?|join-us|work-with-us|vacancies)(?:\/|$)/i;

const MONTH = "(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)";
// Numeric dates with slashes are left out: 04/05/2025 reads differently in the US and in Europe.
const DATE = new RegExp(`\\b(\\d{4})-(\\d{2})-(\\d{2})\\b|\\b${MONTH}\\.? (\\d{1,2})(?:st|nd|rd|th)?,? (\\d{4})\\b|\\b(\\d{1,2})(?:st|nd|rd|th)? ${MONTH}\\.?,? (\\d{4})\\b`, "gi");
const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];

const squash = (s: string) => s.replace(/\s+/g, " ").trim();
const isoDay = (d: Date) => d.toISOString().slice(0, 10);
// Each piece is squashed after splitting at whitespace, so it is always a substring of the squashed page.
const sentences = (text: string) => text.split(/\n+|(?<=[.!?])\s+/).map(squash).filter(Boolean);

function pathOf(url: string): string {
  try {
    return new URL(url).pathname;
  } catch {
    return "";
  }
}

function quoteAround(sentence: string, at: number): string {
  if (sentence.length <= MAX_QUOTE) return sentence;
  const start = Math.max(0, at - MAX_QUOTE / 2);
  return sentence.slice(start, start + MAX_QUOTE).trim();
}

function datesIn(sentence: string): { day: Date; at: number }[] {
  const out: { day: Date; at: number }[] = [];
  for (const m of sentence.matchAll(DATE)) {
    const [y, mo, d] = m[1]
      ? [Number(m[1]), Number(m[2]) - 1, Number(m[3])]
      : m[4]
        ? [Number(m[6]), MONTHS.indexOf(m[4].slice(0, 3).toLowerCase()), Number(m[5])]
        : [Number(m[9]), MONTHS.indexOf(m[8]!.slice(0, 3).toLowerCase()), Number(m[7])];
    const day = new Date(Date.UTC(y, mo, d));
    // Date.UTC rolls 31 February into March, so a date that doesn't exist is dropped here.
    if (day.getUTCMonth() === mo && day.getUTCDate() === d) out.push({ day, at: m.index });
  }
  return out;
}

function hiring(pages: readonly PageText[], now: Date): Signal | null {
  for (const page of pages) {
    const path = pathOf(page.url);
    // An article about hiring is not an opening.
    if (BLOG_PATH.test(path)) continue;
    const lines = sentences(page.text);
    const expired = (line: string) => CLOSING.test(line) && datesIn(line).some((d) => isoDay(d.day) < isoDay(now));
    if (lines.some((line) => NOT_HIRING.test(line) || expired(line))) continue;
    const patterns = CAREERS_PATH.test(path) ? [HIRING, APPLY] : [HIRING];
    for (const line of lines) {
      for (const pattern of patterns) {
        const m = pattern.exec(line);
        if (m) return { type: "hiring", quote: quoteAround(line, m.index), pageUrl: page.url, observedOn: isoDay(now) };
      }
    }
  }
  return null;
}

function staleBlog(pages: readonly PageText[], now: Date, staleAfterDays: number): Signal | null {
  let newest: { day: Date; at: number; line: string; url: string } | null = null;
  for (const page of pages) {
    if (!BLOG_PATH.test(pathOf(page.url))) continue;
    for (const line of sentences(page.text)) {
      if (NOT_A_POST.test(line)) continue;
      for (const d of datesIn(line)) {
        // A future date is an event or a typo, not a post.
        if (d.day > now) continue;
        if (!newest || d.day > newest.day) newest = { ...d, line, url: page.url };
      }
    }
  }
  // No dated post means nothing is confirmed, so there's no signal either way. Age counts whole days.
  if (!newest || Date.parse(isoDay(now)) - newest.day.getTime() <= staleAfterDays * DAY_MS) return null;
  return { type: "stale_blog", quote: quoteAround(newest.line, newest.at), pageUrl: newest.url, observedOn: isoDay(newest.day) };
}

export function findSignals(a: { pages: readonly PageText[]; enabled: readonly SignalType[]; now: Date; staleAfterDays?: number }): Signal[] {
  const found = [
    a.enabled.includes("hiring") ? hiring(a.pages, a.now) : null,
    a.enabled.includes("stale_blog") ? staleBlog(a.pages, a.now, a.staleAfterDays ?? STALE_AFTER_DAYS) : null,
  ];
  return found.filter((s) => s !== null);
}

/** Whether the quote appears word for word in the snapshot, ignoring only differences in whitespace. */
export function onSnapshot(quote: string, snapshotText: string): boolean {
  const q = squash(quote);
  return q !== "" && squash(snapshotText).includes(q);
}

/** Drops any signal whose quote isn't on the snapshot of its own page. */
export function keepQuoted(signals: readonly Signal[], snapshots: readonly PageText[]): Signal[] {
  return signals.filter((s) => snapshots.some((p) => p.url === s.pageUrl && onSnapshot(s.quote, p.text)));
}
