// SPDX-License-Identifier: AGPL-3.0-only
// A Mailbox's domain report, read from DNS when asked: the domain of the address it sends from, and
// the provider its connection says it uses, so SPF and DKIM are checked against that provider.
import { resolveMx, resolveTxt } from "node:dns/promises";
import { credentialSettings } from "../../credentials";
import { sharedMailDomain } from "../../people";
import { inWorkspace } from "../adapters/repo";
import { domainReport, type DomainDns, type DomainReport, type MailProvider } from "../domain/domain-report";

const PROVIDERS: Record<string, MailProvider> = { google: "google", microsoft: "microsoft" };
const nodeDns: DomainDns = { mx: resolveMx, txt: resolveTxt };

export function createMailboxDomains(deps: { dns?: DomainDns } = {}) {
  const dns = deps.dns ?? nodeDns;
  return {
    /** The report for the Mailbox's domain, or null when there is no such Mailbox or no address to read a domain from. */
    async report(workspaceId: string, credentialId: string): Promise<DomainReport | null> {
      const s = await inWorkspace(workspaceId, (tx) => credentialSettings(tx, credentialId));
      const address = s && String(s.meta.username ?? s.key).trim().toLowerCase();
      const domain = address?.match(/^[^@\s]+@([^@\s]+\.[^@\s]+)$/)?.[1];
      if (!s || !domain) return null;
      return domainReport(domain, dns, { consumer: sharedMailDomain(domain), provider: (s.connection && PROVIDERS[s.connection]) || null });
    },
  };
}
export type MailboxDomains = ReturnType<typeof createMailboxDomains>;
