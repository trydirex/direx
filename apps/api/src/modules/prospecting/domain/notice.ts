// SPDX-License-Identifier: AGPL-3.0-only
// A site that publishes its addresses but says not to send it marketing email has withdrawn the
// published-address basis for them. The check is narrow on purpose: it needs the notice to be about
// this site's own addresses, so an article giving advice about "do not email" practice doesn't block.
import { pageText } from "./addresses";

const KIND = String.raw`(?:unsolicited|marketing|commercial|promotional|sales|advertising|bulk)`;
const MESSAGES = String.raw`(?:e-?mails?|messages|solicitations?|offers|pitches)`;
const DONT = String.raw`(?:do\s+not|don't|please\s+don't|never)`;
const OURS = String.raw`(?:us|me|this\s+(?:e-?mail\s+)?address|these\s+(?:e-?mail\s+)?addresses|(?:any\s+of\s+)?the\s+(?:e-?mail\s+)?address(?:es)?\s+(?:above|below|on\s+this\s+(?:page|site|website)))`;

const NOTICES = [
  // "Please do not send us unsolicited email", "Do not email us marketing offers"
  new RegExp(String.raw`${DONT}\s+(?:send|e-?mail)\s+${OURS}\s+(?:any\s+)?${KIND}`, "g"),
  // "Do not send marketing emails to this address"
  new RegExp(String.raw`${DONT}\s+send\s+(?:any\s+)?${KIND}\s+${MESSAGES}\s+to\s+${OURS}\b`, "g"),
  // "This address is not to be used for marketing", "Email addresses on this site may not be used for solicitation"
  new RegExp(String.raw`\b(?:address(?:es)?|e-?mails?)\b[^.\n]{0,40}\b(?:not|never)\s+(?:to\s+)?(?:be\s+)?(?:used|intended)\s+for\s+(?:${KIND}|solicitations?)`, "g"),
  // "We do not accept unsolicited sales emails", "We don't want marketing messages"
  new RegExp(String.raw`\bwe\s+(?:do\s+not|don't)\s+(?:accept|want|welcome|respond\s+to)\s+(?:any\s+)?${KIND}\s+(?:\w+\s+)?${MESSAGES}`, "g"),
  // "No unsolicited emails, please" as its own line or sentence, not "we send no marketing emails"
  new RegExp(String.raw`(?:^|[.!?:;|•]\s*)no\s+${KIND}\s+(?:\w+\s+)?${MESSAGES}`, "gm"),
  // "Unsolicited commercial email is not welcome"
  new RegExp(String.raw`\b${KIND}\s+(?:\w+\s+)?${MESSAGES}\s+(?:is|are|will\s+be)\s+(?:not\s+(?:welcome|accepted|permitted|wanted)|prohibited|unwelcome)`, "g"),
  // "We do not consent to receive commercial electronic messages", as Canada's law words it
  new RegExp(String.raw`\b(?:do\s+not|don't)\s+consent\s+to\s+(?:receive|receiving|the\s+receipt\s+of)\s+(?:any\s+)?${KIND}`, "g"),
];

// A notice inside quotation marks is being talked about, not given: an opening quote shortly before it,
// in the same sentence.
function quoted(text: string, at: number): boolean {
  return /(?:["“‘]|(?:^|\s)')[^"”’.!?\n]{0,20}$/.test(text.slice(Math.max(0, at - 30), at));
}

/** The words of the notice when the page tells senders not to market to its addresses, otherwise null. */
export function doNotEmailNotice(html: string): string | null {
  const text = pageText(html).toLowerCase().replace(/’/g, "'");
  for (const notice of NOTICES) {
    for (const m of text.matchAll(notice)) {
      const words = m[0].replace(/^[.!?:;|•\s]+/, "");
      if (!quoted(text, m.index + m[0].length - words.length)) return words;
    }
  }
  return null;
}
