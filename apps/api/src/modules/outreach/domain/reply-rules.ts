// SPDX-License-Identifier: AGPL-3.0-only
// Pure: what the sender themselves wrote, and whether it plainly asks to stop. A wrong yes is permanent
// and a miss still reaches the model or a person, so these only say yes when they are sure.
import { ORIGINAL_MESSAGE, REPLY_LANGUAGES } from "./reply-languages";

// Our footer asks for a "stop" reply, so a reply that carries it unquoted must not read as one.
const FOOTER = /unsubscribe:?\s*https?:\/\/\S*\/api\/unsubscribe\/|reply\s+["“”']?stop["“”']?\s+and\s+i\s+won['’]?t\s+email\s+you\s+again/i;
const MOBILE_SIGNATURE = /^[ \t]*(?:sent from my \w[^\n]*|get outlook for \w[^\n]*)$/gim;
const FOOTER_LOOKBACK = 400;

function earliestHeader(text: string) {
  let best: { at: number; end: number } | null = null;
  for (const { quoteHeader } of REPLY_LANGUAGES) {
    const m = quoteHeader.exec(text);
    if (m && (!best || m.index < best.at)) best = { at: m.index, end: m.index + m[0].length };
  }
  return best;
}

// A header above ">" lines leaves text below it that the sender wrote, such as an opt-out under the
// quote. A header above unmarked text means all of that text is the quote.
function withoutQuoteHeaders(text: string): string {
  let rest = text;
  for (let h = earliestHeader(rest); h; h = earliestHeader(rest)) {
    const below = rest.slice(h.end);
    const marked = below.trimStart().startsWith(">");
    rest = rest.slice(0, h.at) + (marked ? `\n${below}` : "");
  }
  return rest;
}

function withoutFooter(text: string): string {
  const at = text.search(FOOTER);
  if (at < 0) return text;
  const start = text.lastIndexOf("\n--", at);
  return text.slice(0, start >= 0 && at - start <= FOOTER_LOOKBACK ? start : at);
}

/** Quoted mail always carries our footer, so rules only ever see what the sender wrote. */
export function ownWords(raw: string): string {
  const text = withoutQuoteHeaders(raw.replace(/\r\n/g, "\n"))
    .split("\n")
    .filter((line) => !line.trimStart().startsWith(">"))
    .join("\n");
  const original = text.search(ORIGINAL_MESSAGE);
  return withoutFooter(original >= 0 ? text.slice(0, original) : text)
    .replace(MOBILE_SIGNATURE, "")
    .trim();
}

const flat = (text: string) => text.replace(/[‘’]/g, "'").toLowerCase().replace(/\s+/g, " ").trim();
const LETTER_BEFORE = /\p{L}$/u;
// Scripts written without spaces have no word start to check.
const SPACED = /^[\p{Script=Latin}\s'-]/u;

/** The phrase that plainly asks to stop, or null when these rules can't tell. */
export function optOutPhrase(words: string): string | null {
  const said = flat(words);
  const bare = said.replace(/[^\p{L}\p{N}\s-]/gu, "").trim();
  for (const lang of REPLY_LANGUAGES) {
    if (lang.bare.includes(bare)) return bare;
    for (const phrase of lang.phrases) {
      for (let at = said.indexOf(phrase); at >= 0; at = said.indexOf(phrase, at + 1)) {
        const before = said.slice(0, at);
        const after = said.slice(at + phrase.length);
        if (SPACED.test(phrase) && LETTER_BEFORE.test(before)) continue;
        if (lang.notBefore?.test(before) || lang.notAfter?.test(after)) continue;
        return phrase;
      }
    }
  }
  return null;
}

/** A mail server's own statement that nobody wrote this. */
export function autoSubmitted(header: string | null | undefined): boolean {
  const value = header?.trim().toLowerCase();
  return !!value && value !== "no";
}

/** A subject that looks like an auto-reply. A person can reuse one, so a rule hit still outranks it. */
export function autoSubject(subject: string): boolean {
  const s = subject.toLowerCase();
  return REPLY_LANGUAGES.some((lang) => lang.autoSubjects.some((a) => s.includes(a)));
}

export type RuleOutcome = { status: "opted_out"; quote: string } | { status: "not_opt_out" } | { status: "pending"; words: string };

/** What the rules alone decide about a human reply, in the order intake applies them. */
export function settleByRules(r: { text: string; subject: string; autoSubmitted?: string | null }): RuleOutcome {
  if (autoSubmitted(r.autoSubmitted)) return { status: "not_opt_out" };
  const words = ownWords(r.text);
  if (optOutPhrase(words)) return { status: "opted_out", quote: words };
  if (!words || autoSubject(r.subject)) return { status: "not_opt_out" };
  return { status: "pending", words };
}
