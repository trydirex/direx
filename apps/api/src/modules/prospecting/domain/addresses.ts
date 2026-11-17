// SPDX-License-Identifier: AGPL-3.0-only
// Addresses come from the page HTML, never from a model, so only what a site really publishes is kept.
// Sites hide addresses from scrapers in a few usual ways, and each is undone here.
import { onCompanyDomain } from "./domains";

export type KnownName = { first: string; last: string };
export type Classified = { kind: "named"; name: KnownName } | { kind: "function" | "generic" | "unknown" };
export type AddressKind = Classified["kind"];
export type FoundAddress = { email: string; kind: AddressKind; noticeFound: boolean };
export type LeftOutReason = "other_domain" | "generic_address" | "do_not_email_notice";

// Only named entities that turn up in hidden addresses and ordinary text; anything else stays as written.
const ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
  commat: "@",
  period: ".",
  lowbar: "_",
  hyphen: "-",
  dash: "-",
  plus: "+",
};

export function decodeEntities(text: string): string {
  return text.replace(/&(?:#x([0-9a-f]{1,6});?|#(\d{1,7});?|([a-z]+);)/gi, (whole, hex?: string, dec?: string, name?: string) => {
    if (name) return ENTITIES[name.toLowerCase()] ?? whole;
    const code = hex ? parseInt(hex, 16) : Number(dec);
    return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : whole;
  });
}

/** The page as readable text: scripts and styles dropped, each tag a line break, entities decoded. */
export function pageText(html: string): string {
  return decodeEntities(html.replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, " ").replace(/<[^>]*>/g, "\n"))
    .replace(/[^\S\n]+/g, " ")
    .replace(/ ?\n[\s]*/g, "\n")
    .trim();
}

// Cloudflare's email protection XORs each byte with the first one and writes the result as hex.
function cloudflare(hex: string): string {
  const key = parseInt(hex.slice(0, 2), 16);
  let out = "";
  for (let i = 2; i < hex.length; i += 2) out += String.fromCharCode(parseInt(hex.slice(i, i + 2), 16) ^ key);
  return out;
}

function percentDecoded(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    // A stray % that isn't an escape is read as written.
    return value;
  }
}

const AT = String.raw`(?:\s*[\[({]\s*at\s*[\])}]\s*|@)`;
const DOT = String.raw`(?:\s*[\[({]\s*dot\s*[\])}]\s*|\.)`;
// Bounded parts keep a long run of letters, such as an inline base64 image, from making the scan quadratic.
const ADDRESS = new RegExp(String.raw`(?<![a-z0-9._+-])([a-z0-9._+-]{1,64})${AT}([a-z0-9-]{1,63}(?:${DOT}[a-z0-9-]{1,63}){1,8})`, "gi");
const BRACKET_DOT = new RegExp(DOT, "gi");
// Retina image names such as logo@2x.png look like addresses.
const FILE_ENDINGS = new Set(["png", "jpg", "jpeg", "gif", "svg", "webp", "avif", "ico", "css", "js", "json", "pdf"]);

/** Each distinct address published on the page, lowercased, in the order first seen. */
export function extractAddresses(html: string): string[] {
  const decoded = decodeEntities(html);
  const hidden = [
    ...[...html.matchAll(/data-cfemail\s*=\s*["']?([0-9a-f]+)/gi)].map((m) => m[1]!),
    ...[...html.matchAll(/\/cdn-cgi\/l\/email-protection#([0-9a-f]+)/gi)].map((m) => m[1]!),
  ]
    .filter((hex) => hex.length >= 4 && hex.length % 2 === 0)
    .map(cloudflare);
  const mailto = [...decoded.matchAll(/mailto:([^"'\s<>?]+)/gi)].map((m) => percentDecoded(m[1]!).replace(/,/g, " "));
  const found = new Set<string>();
  for (const m of [decoded, ...hidden, ...mailto].join("\n").matchAll(ADDRESS)) {
    const local = m[1]!.replace(/^\.+|\.+$/g, "").toLowerCase();
    const domain = m[2]!.replace(BRACKET_DOT, ".").toLowerCase();
    const ending = domain.slice(domain.lastIndexOf(".") + 1);
    if (local && /^[a-z]{2,}$/.test(ending) && !FILE_ENDINGS.has(ending)) found.add(`${local}@${domain}`);
  }
  return [...found];
}

// Local parts are compared with dots, dashes, underscores and any +tag removed, so first.last and
// first_last are one pattern.
const FUNCTION = new Set(["sales", "partnerships", "marketing", "growth", "founders", "hello"]);
const GENERIC = new Set([
  "info", "contact", "contactus", "office", "admin", "administrator", "support", "help", "helpdesk", "service",
  "services", "customerservice", "customersupport", "cs", "careers", "career", "jobs", "hr", "recruiting",
  "recruitment", "talent", "press", "media", "pr", "news", "newsletter", "billing", "accounts", "accounting",
  "invoices", "invoice", "payments", "payroll", "finance", "ap", "ar", "noreply", "donotreply", "mailer",
  "mailerdaemon", "postmaster", "hostmaster", "webmaster", "abuse", "security", "privacy", "legal", "compliance",
  "dpo", "gdpr", "team", "mail", "email", "hi", "hey", "general", "inquiries", "inquiry", "enquiries", "enquiry",
  "questions", "reception", "frontdesk", "main", "staff", "intake", "appointments", "bookings", "booking",
  "orders", "shop", "store", "feedback", "events", "it", "tech", "ops", "operations", "clients", "client",
  "documents", "docs", "receipts",
]);
// Words that mark a mailbox as shared even with something added, such as officeinfo or support2.
const GENERIC_PARTS = ["noreply", "donotreply", "info", "contact", "support", "admin", "enquir", "inquir"];

function squash(value: string): string {
  return value
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/[^a-z]/g, "");
}

/** Named when the local part is a known person's first, first.last, firstlast, flast or firstl. */
export function classify(email: string, names: KnownName[]): Classified {
  const raw = email.slice(0, email.lastIndexOf("@")).toLowerCase().replace(/\+.*$/, "");
  const local = raw.replace(/[._-]/g, "");
  for (const name of names) {
    const first = squash(name.first);
    const last = squash(name.last);
    if (!first) continue;
    const forms = last ? [first, first + last, first[0]! + last, first + last[0]!] : [first];
    if (forms.includes(local)) return { kind: "named", name };
  }
  if (FUNCTION.has(local)) return { kind: "function" };
  if (GENERIC.has(local) || GENERIC.has(local.replace(/\d+$/, "")) || GENERIC_PARTS.some((p) => local.includes(p))) {
    return { kind: "generic" };
  }
  return { kind: "unknown" };
}

export function leftOutBecause(a: FoundAddress, companyDomain: string): LeftOutReason | null {
  if (!onCompanyDomain(a.email, companyDomain)) return "other_domain";
  if (a.noticeFound) return "do_not_email_notice";
  return a.kind === "generic" ? "generic_address" : null;
}
