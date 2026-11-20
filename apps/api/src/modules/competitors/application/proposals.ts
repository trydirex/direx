// SPDX-License-Identifier: AGPL-3.0-only
// Competitor proposals: names Direx found on the Workspace's own site, waiting for a person. A scan
// reads that site's sitemap and each comparison page it names, under robots.txt, with no model. A
// proposal changes nothing: a person uses it to fill the form and adds the competitor, or dismisses it.
import { addScan, closeProposals, inWorkspace, lastScan, listRows, openProposals, proposedBefore, type ProposalRow } from "../adapters/repo";
import { nameKey, nameOf, namesFromSitemap, ownNames, siteFromLinks, siteKey } from "../domain/own-site";
import { siteReader, type SiteReadDeps } from "./find-pages";

/** The most comparison pages one scan reads. */
const MAX_NAMES = 10;
const TIMEOUT_MS = 30_000;

export type Proposal = { id: string; name: string; site: string | null; comparisonUrl: string | null; source: "own_site" | "search"; terms: string[] | null; foundAt: Date };
export type ProposalList = { proposals: Proposal[]; site: string | null; scannedAt: Date | null };
/** The site the Workspace's latest Brand read of a website used, or null when there is none. */
export type WorkspaceSite = (workspaceId: string) => Promise<string | null>;

const view = (p: ProposalRow): Proposal => ({ id: p.id, name: p.name, site: p.site, comparisonUrl: p.comparisonUrl, source: p.kind === "search" ? "search" : "own_site", terms: p.terms, foundAt: p.foundAt });

export function createProposals(deps: { site: WorkspaceSite; reads?: SiteReadDeps; now?: () => Date; timeoutMs?: number }) {
  const now = deps.now ?? (() => new Date());

  async function list(workspaceId: string): Promise<ProposalList> {
    const site = await deps.site(workspaceId);
    return inWorkspace(workspaceId, async (tx) => ({ proposals: (await openProposals(tx)).map(view), site, scannedAt: site ? await lastScan(tx, site) : null }));
  }

  /** Names from the site's comparison pages, each with the competitor's site when its page links to it. */
  async function read(site: string) {
    const reader = siteReader(site, AbortSignal.timeout(deps.timeoutMs ?? TIMEOUT_MS), deps.reads);
    const named = namesFromSitemap(await reader.sitemap(), ownNames(site)).slice(0, MAX_NAMES);
    return Promise.all(
      named.map(async (n) => ({ name: nameOf(n.slug), comparisonUrl: n.url, site: siteFromLinks(n.slug, ((await reader.links(n.url)) ?? []).map((l) => l.url), site) })),
    );
  }

  return {
    list,

    /** Reads the Workspace's site again and proposes the names not proposed, dismissed or on the list before. */
    async scan(workspaceId: string): Promise<ProposalList | { ok: false; reason: "no_site" | "timed_out" }> {
      const site = await deps.site(workspaceId);
      if (!site) return { ok: false, reason: "no_site" };
      let found: Awaited<ReturnType<typeof read>>;
      try {
        found = await read(site);
      } catch (e) {
        if (e instanceof DOMException && e.name === "TimeoutError") return { ok: false, reason: "timed_out" };
        throw e;
      }
      await inWorkspace(workspaceId, async (tx) => {
        const listed = await listRows(tx);
        const before = await proposedBefore(tx);
        const keys = new Set([...before.map((p) => p.nameKey), ...listed.map((c) => nameKey(c.name))]);
        const sites = new Set([...before, ...listed.map((c) => ({ site: c.landingUrl }))].flatMap((p) => (p.site ? [siteKey(p.site)] : [])));
        const fresh = found.filter((f) => !keys.has(nameKey(f.name)) && !(f.site && sites.has(siteKey(f.site))));
        await addScan(tx, workspaceId, site, fresh.map((f) => ({ ...f, nameKey: nameKey(f.name) })), now());
      });
      return list(workspaceId);
    },

    /** False when there is no such open proposal. */
    dismiss: async (workspaceId: string, userId: string, id: string) => (await inWorkspace(workspaceId, (tx) => closeProposals(tx, [id], userId, "dismissed", now()))).length > 0,
  };
}
export type Proposals = ReturnType<typeof createProposals>;
