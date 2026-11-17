// SPDX-License-Identifier: AGPL-3.0-only
// Which site a per-address draft reads: the list's value if it has a usable one, otherwise the email's
// domain. The page fetcher still decides whether an address may be read at all.

export function normaliseWebsite(value: string): string | null {
  const trimmed = value.trim();
  if (!trimmed) return null;
  try {
    const url = new URL(/^[a-z][a-z0-9+.-]*:/i.test(trimmed) ? trimmed : `https://${trimmed}`);
    if ((url.protocol !== "http:" && url.protocol !== "https:") || !url.hostname.includes(".")) return null;
    return url.href;
  } catch {
    return null;
  }
}

/** Null means there's no site to read, and the draft is labelled as generic. */
export function websiteFor(email: string, website: string | null | undefined, sharedMail: (domain: string) => boolean): string | null {
  const given = website ? normaliseWebsite(website) : null;
  if (given) return given;
  const domain = email.slice(email.lastIndexOf("@") + 1).trim().toLowerCase();
  return !email.includes("@") || sharedMail(domain) ? null : normaliseWebsite(domain);
}
