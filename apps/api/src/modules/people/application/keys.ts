// SPDX-License-Identifier: AGPL-3.0-only
// Identity keys, normalised so the same address or ID always compares equal.
import { parsePhoneNumberFromString, type CountryCode } from "libphonenumber-js";

export type KeyKind = "email" | "phone" | "linkedin" | "x" | "hubspot" | "shopify";
export type KeyResult = { ok: true; value: string } | { ok: false; reason: string };

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const LINKEDIN = /^(?:https?:\/\/)?(?:[a-z]{2,3}\.)?linkedin\.com\/in\/([^/?#\s]+)\/?(?:[?#].*)?$/i;
// An X handle is 1 to 15 letters, digits or underscores; X compares them without case.
const X = /^(?:@|(?:https?:\/\/)?(?:(?:www|mobile)\.)?(?:x|twitter)\.com\/)?([a-z0-9_]{1,15})\/?(?:[?#].*)?$/i;

export function normaliseKey(kind: KeyKind, raw: string, opts: { defaultCountry?: CountryCode } = {}): KeyResult {
  const input = raw.trim();
  switch (kind) {
    case "email": {
      const value = input.toLowerCase();
      return EMAIL.test(value) ? { ok: true, value } : { ok: false, reason: "not an email address" };
    }
    case "phone": {
      const phone = parsePhoneNumberFromString(input, opts.defaultCountry);
      if (!phone?.isValid()) {
        return { ok: false, reason: input.startsWith("+") || opts.defaultCountry ? "not a valid phone number" : "a phone number without + needs a default country" };
      }
      return { ok: true, value: phone.number };
    }
    case "linkedin": {
      const slug = LINKEDIN.exec(input)?.[1];
      return slug ? { ok: true, value: `https://www.linkedin.com/in/${slug.toLowerCase()}` } : { ok: false, reason: "not a LinkedIn profile URL" };
    }
    case "x": {
      const handle = X.exec(input)?.[1];
      return handle ? { ok: true, value: `https://x.com/${handle.toLowerCase()}` } : { ok: false, reason: "not an X handle or profile URL" };
    }
    case "hubspot":
    case "shopify":
      return input ? { ok: true, value: input } : { ok: false, reason: "empty id" };
  }
}
