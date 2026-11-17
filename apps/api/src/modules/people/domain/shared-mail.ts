// SPDX-License-Identifier: AGPL-3.0-only
// Pure. A shared mail provider's domain belongs to no one company, so it can't identify a company,
// vouch for an address, or tie two people together. Matched exactly or as a parent, so
// mail.yahoo.com counts and a company domain merely containing these words (gmailstudio.com) doesn't.

const SHARED_MAIL_DOMAINS = [
  "aol.com",
  "fastmail.com",
  "gmail.com",
  "gmx.com",
  "googlemail.com",
  "hey.com",
  "hotmail.com",
  "icloud.com",
  "live.com",
  "mail.com",
  "me.com",
  "msn.com",
  "outlook.com",
  "proton.me",
  "protonmail.com",
  "qq.com",
  "yahoo.com",
  "yandex.com",
  "zoho.com",
];

export function sharedMailDomain(domain: string): boolean {
  const d = domain.trim().toLowerCase().replace(/\.$/, "");
  return SHARED_MAIL_DOMAINS.some((s) => d === s || d.endsWith(`.${s}`));
}
