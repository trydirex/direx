// SPDX-License-Identifier: AGPL-3.0-only
// What code can tell about an address for free, before a vendor is paid to check it: whether it is
// written as an address, and whether its domain takes mail at all.
import { verifyAddressInput, type VerificationResult } from "@direx/plugin-sdk";
import { resolveMx } from "node:dns/promises";
import { domainOf } from "../domain/domains";

type ResolveMx = (domain: string) => Promise<{ exchange: string }[]>;

/** Codes for a domain that doesn't exist, or exists with no mail record. */
const NO_MAIL = new Set(["ENOTFOUND", "ENODATA"]);

/**
 * `invalid` when the address is malformed or its domain has no mail record, `unknown` when DNS
 * didn't answer, and null when a paid check is worth making.
 */
export async function beforePaidCheck(email: string, resolve: ResolveMx = resolveMx): Promise<VerificationResult | null> {
  if (!verifyAddressInput.safeParse({ email }).success) return "invalid";
  let records: { exchange: string }[];
  try {
    records = await resolve(domainOf(email));
  } catch (e) {
    return NO_MAIL.has((e as { code?: string }).code ?? "") ? "invalid" : "unknown";
  }
  // ponytail: a domain with no MX is taken as taking no mail, though mail servers may fall back to its
  // A record. Such domains are rare among companies, and treating them as invalid saves a credit.
  // A null MX, a single "." record, says outright that the domain takes no mail.
  return records.some((r) => r.exchange !== "" && r.exchange !== ".") ? null : "invalid";
}
