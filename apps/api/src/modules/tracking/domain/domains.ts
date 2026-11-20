// SPDX-License-Identifier: AGPL-3.0-only
// Tracking domains (ADR 0035 rule 007): the hostname form Direx stores and the edge asks about, and
// what a domain's DNS must show before the edge may get a certificate for it.

export type DomainState = "pending" | "dns_ok" | "verified" | "stopped";

/** The label the TXT record sits under: `_direx-tracking.<hostname>`. */
export const TXT_LABEL = "_direx-tracking";

const HOST = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/;

/** Lowercase, punycode, no trailing dot; null when it isn't a hostname of at least two labels. */
export function normalizeHostname(input: string): string | null {
  const raw = input.trim().replace(/\.$/, "");
  // Only a bare hostname: no port, path, credentials or spaces for URL to quietly drop.
  if (!raw || /[/:@?#\s\\]/.test(raw)) return null;
  let ascii: string;
  try {
    ascii = new URL(`http://${raw}`).hostname;
  } catch {
    return null;
  }
  return ascii.length <= 253 && HOST.test(ascii) ? ascii : null;
}

const bare = (name: string) => name.trim().toLowerCase().replace(/\.$/, "");

/** Whether the CNAME points at the deployment's tracking target and a TXT record holds the Workspace's value. */
export function dnsMatches(found: { cname: readonly string[]; txt: readonly string[] }, target: string, value: string): boolean {
  return found.cname.some((c) => bare(c) === bare(target)) && found.txt.some((t) => t.trim() === value);
}
