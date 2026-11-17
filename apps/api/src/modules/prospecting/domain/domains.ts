// SPDX-License-Identifier: AGPL-3.0-only
// A Company is known by one domain per Workspace, so every way of writing its site has to land on the
// same value: lowercase, no www., no port, path or scheme.

/** Null when the value names no company's own site: not http, an IP address, or a shared mail domain. */
export function companyDomain(value: string, sharedMail: (domain: string) => boolean): string | null {
  const trimmed = value.trim();
  if (!trimmed) return null;
  let url: URL;
  try {
    url = new URL(/^[a-z][a-z0-9+.-]*:/i.test(trimmed) ? trimmed : `https://${trimmed}`);
  } catch {
    return null;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return null;
  const host = url.hostname.replace(/\.$/, "").replace(/^www\./, "");
  // The URL parser has already rewritten every IPv4 spelling to dotted decimal and bracketed IPv6.
  if (!host.includes(".") || host.startsWith("[") || /^\d+(\.\d+){3}$/.test(host)) return null;
  return sharedMail(host) ? null : host;
}

export function domainOf(email: string): string {
  return email.slice(email.lastIndexOf("@") + 1).trim().toLowerCase();
}

/** The company's own domain or one of its subdomains, such as mail.acme.com for acme.com. */
export function onCompanyDomain(email: string, company: string): boolean {
  const domain = domainOf(email);
  return email.includes("@") && (domain === company || domain.endsWith(`.${company}`));
}

const TITLE_PARTS = /\s+[|–—:-]\s+|\s*\|\s*/;
const FILLER = /^(home( page)?|welcome)$/i;
const FIRM_MARK = /\b(LLC|LLP|PLLC|Inc|Ltd|CPAs?)\b|\bP\.C\.|\s&\s/;
const compact = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");

/**
 * The part of a search result's page title that names the firm: one its domain spells, else one
 * with a firm's mark (LLC, CPA, "&"). Null when no part does, so the screens show the domain
 * rather than a page's selling line.
 */
// ponytail: a title heuristic; reading the firm's name from the site would cover titles with no mark.
export function firmName(title: string, domain: string): string | null {
  const label = compact(domain.split(".")[0] ?? "");
  const parts = title.replace(/[®™©]/g, "").split(TITLE_PARTS).map((p) => p.trim()).filter((p) => p && !FILLER.test(p));
  const spelled = (p: string) => {
    const whole = compact(p);
    const first = compact(p.split(/\s+/)[0] ?? "");
    return (whole.length >= 4 && label.includes(whole)) || (first.length >= 4 && label.startsWith(first));
  };
  const name = parts.find(spelled) ?? parts.find((p) => FIRM_MARK.test(p));
  return name ? name.slice(0, 200) : null;
}
