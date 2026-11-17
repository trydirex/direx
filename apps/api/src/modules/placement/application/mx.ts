// SPDX-License-Identifier: AGPL-3.0-only
// Placement checks go only to domains whose mail Google receives. A member whose domain fails this
// check, or whose lookup fails, is skipped that day.
import { resolveMx } from "node:dns/promises";

export type ResolveMx = (domain: string) => Promise<{ exchange: string; priority: number }[]>;

/** Google's MX hosts: Gmail's aspmx and its alternates, googlemail.com hosts, and Workspace's smtp.google.com. */
const GOOGLE_MX = /^(?:(?:alt[1-4]\.)?aspmx\.l\.google\.com|[a-z0-9-]+\.googlemail\.com|smtp\.google\.com)$/;

/** Whether every MX record of the domain is a Google host. Another host anywhere in the list could take the mail, so it fails. */
export async function googleMx(domain: string, resolve: ResolveMx = resolveMx): Promise<boolean> {
  try {
    const records = await resolve(domain);
    return records.length > 0 && records.every((r) => GOOGLE_MX.test(r.exchange.toLowerCase().replace(/\.$/, "")));
  } catch {
    return false;
  }
}
