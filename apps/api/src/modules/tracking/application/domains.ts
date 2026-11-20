// SPDX-License-Identifier: AGPL-3.0-only
// A Workspace's tracking domains (ADR 0035 rules 007 and 008): add one, check its DNS and then a TLS
// handshake, stop it for new links, or remove it while nothing uses it. And the edge's question.
import { randomBytes } from "node:crypto";
import type { DnsLookup } from "../adapters/dns";
import * as repo from "../adapters/repo";
import { dnsMatches, normalizeHostname, TXT_LABEL, type DomainState } from "../domain/domains";

export type DomainView = {
  id: string;
  hostname: string;
  state: DomainState;
  cnameTarget: string | null;
  txtName: string;
  txtValue: string;
  checkedAt: string | null;
};

/** What a check found. A failing check never moves a domain back, so links already sent keep working. */
export type CheckResult = "verified" | "dns_ok" | "dns_mismatch" | "stopped" | "not_configured";

export type TrackingDomains = ReturnType<typeof createTrackingDomains>;

export function createTrackingDomains(deps: { dns: DnsLookup; target: () => string | null; now?: () => Date }) {
  const now = deps.now ?? (() => new Date());
  const view = (d: repo.DomainRow): DomainView => ({
    id: d.id,
    hostname: d.hostname,
    state: d.state as DomainState,
    cnameTarget: deps.target(),
    txtName: `${TXT_LABEL}.${d.hostname}`,
    txtValue: d.txtValue,
    checkedAt: d.checkedAt?.toISOString() ?? null,
  });
  const record = (workspaceId: string, id: string, state: DomainState) => repo.inWorkspace(workspaceId, (tx) => repo.recordCheck(tx, id, state, now()));

  return {
    list: (workspaceId: string) => repo.inWorkspace(workspaceId, async (tx) => (await repo.listDomains(tx)).map(view)),

    /** Adds a hostname; "taken" when any Workspace on the deployment has it already. */
    async add(workspaceId: string, userId: string, hostname: string): Promise<DomainView | "invalid" | "taken" | "not_configured"> {
      const host = normalizeHostname(hostname);
      if (!host) return "invalid";
      if (!deps.target()) return "not_configured";
      const row = await repo.inWorkspace(workspaceId, (tx) => repo.insertDomain(tx, { workspaceId, hostname: host, txtValue: randomBytes(16).toString("base64url"), createdBy: userId, now: now() }));
      return row === "taken" ? row : view(row);
    },

    /**
     * Resolves the CNAME and TXT records. Once both match, the domain is `dns_ok`, which lets the edge
     * get a certificate, and a successful handshake then marks it `verified`. Lookups run outside any
     * transaction.
     */
    async check(workspaceId: string, id: string): Promise<CheckResult | null> {
      const d = await repo.inWorkspace(workspaceId, (tx) => repo.domainById(tx, id));
      if (!d) return null;
      if (d.state === "stopped") return "stopped";
      const target = deps.target();
      if (!target) return "not_configured";
      const state = d.state as DomainState;
      if (!dnsMatches(await deps.dns.records(d.hostname), target, d.txtValue)) {
        await record(workspaceId, id, state);
        return "dns_mismatch";
      }
      if (state === "verified") {
        await record(workspaceId, id, "verified");
        return "verified";
      }
      // Committed before the handshake, so the edge's ask says yes and the certificate can be had.
      await record(workspaceId, id, "dns_ok");
      if (!(await deps.dns.handshake(d.hostname))) return "dns_ok";
      await record(workspaceId, id, "verified");
      return "verified";
    },

    /** Stops a domain for new links; links already sent keep resolving (rule 008). */
    stop: (workspaceId: string, id: string): Promise<boolean> => repo.inWorkspace(workspaceId, (tx) => repo.stopDomain(tx, id)),

    /** Removes a domain nothing uses; "in_use" while a link or a Campaign names it (rule 008). */
    remove: (workspaceId: string, id: string): Promise<"removed" | "in_use" | null> =>
      repo.inWorkspace(workspaceId, async (tx) => {
        if (!(await repo.domainById(tx, id))) return null;
        if (await repo.domainInUse(tx, id)) return "in_use";
        await repo.deleteDomain(tx, id);
        return "removed";
      }),

    /** The edge's question, answered with yes or no only. */
    async allowed(hostname: string): Promise<boolean> {
      const host = normalizeHostname(hostname);
      return host ? repo.hostAllowed(host) : false;
    },
  };
}
