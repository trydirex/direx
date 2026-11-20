// SPDX-License-Identifier: AGPL-3.0-only
// Competitor proposals: names Direx found on the Workspace's own site, waiting for a person. A scan
// reads that site's sitemap and each comparison page it names, under robots.txt, with no model. A
// proposal changes nothing: a person uses it to fill the form and adds the competitor, or dismisses it.
import { NotAvailable, noDiscovery, type Discovery } from "../../extensions/index";
import { holdsPersonData, knownNames } from "../../prospecting/index";
import { addScan, addSearchProposals, closeProposals, inWorkspace, lastScan, listRows, openProposals, proposedBefore, reserveSearch, searchesInMonth, type CompetitorsTx, type NewProposal, type ProposalRow } from "../adapters/repo";
import { nameKey, nameOf, namesFromSitemap, ownNames, siteFromLinks, siteKey } from "../domain/own-site";
import { siteReader, type SiteReadDeps } from "./find-pages";

/** The most comparison pages one scan reads. */
const MAX_NAMES = 10;
const TIMEOUT_MS = 30_000;
/** How many companies one paid search asks for. */
export const SEARCH_LIMIT = 10;
export const MAX_TERMS = 3;
/** Direx pays for searches on cloud (founder, 2026-11-20), so each Workspace gets this many a calendar month (UTC). */
export const SEARCHES_PER_MONTH = 5;

export type Proposal = { id: string; name: string; site: string | null; comparisonUrl: string | null; source: "own_site" | "search"; terms: string[] | null; foundAt: Date };
export type ProposalList = { proposals: Proposal[]; site: string | null; scannedAt: Date | null; searchAvailable: boolean; searchesLeft: number };
type SearchRefusal = { ok: false; reason: "bad_terms" | "person_data" | "not_available" | "search_limit" };
const utcMonth = (d: Date) => ({
  start: new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1)),
  end: new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1)),
});
/** The site the Workspace's latest Brand read of a website used, or null when there is none. */
export type WorkspaceSite = (workspaceId: string) => Promise<string | null>;

const view = (p: ProposalRow): Proposal => ({ id: p.id, name: p.name, site: p.site, comparisonUrl: p.comparisonUrl, source: p.kind === "search" ? "search" : "own_site", terms: p.terms, foundAt: p.foundAt });

/** The found companies not proposed, dismissed or on the list before, by name or by site, nor the Workspace itself. */
async function fresh(tx: CompetitorsTx, found: NewProposal[], ownSite: string | null): Promise<NewProposal[]> {
  const listed = await listRows(tx);
  const before = await proposedBefore(tx);
  const keys = new Set([...before.map((p) => p.nameKey), ...listed.map((c) => nameKey(c.name))]);
  const sites = new Set([...before, ...listed.map((c) => ({ site: c.landingUrl })), { site: ownSite }].flatMap((p) => (p.site ? [siteKey(p.site)] : [])));
  return found.filter((f) => f.nameKey && !keys.has(f.nameKey) && !(f.site && sites.has(siteKey(f.site))));
}

export function createProposals(deps: { site: WorkspaceSite; reads?: SiteReadDeps; now?: () => Date; timeoutMs?: number; discovery?: () => Discovery | undefined }) {
  const now = deps.now ?? (() => new Date());
  const discovery = () => deps.discovery?.() ?? noDiscovery;

  async function list(workspaceId: string): Promise<ProposalList> {
    const site = await deps.site(workspaceId);
    const searchAvailable = discovery() !== noDiscovery;
    return inWorkspace(workspaceId, async (tx) => ({
      proposals: (await openProposals(tx)).map(view),
      site,
      scannedAt: site ? await lastScan(tx, site) : null,
      searchAvailable,
      searchesLeft: Math.max(0, SEARCHES_PER_MONTH - (await searchesInMonth(tx, utcMonth(now())))),
    }));
  }

  /** Terms go to a search vendor: 1 to 3 of them, and none holding an email, a web address or a known person's name. */
  async function refuseTerms(workspaceId: string, terms: string[]): Promise<SearchRefusal | null> {
    if (terms.length < 1 || terms.length > MAX_TERMS) return { ok: false, reason: "bad_terms" };
    const names = await inWorkspace(workspaceId, knownNames);
    return terms.some((t) => holdsPersonData(t, names)) ? { ok: false, reason: "person_data" } : null;
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
      await inWorkspace(workspaceId, async (tx) => addScan(tx, workspaceId, site, await fresh(tx, found.map((f) => ({ ...f, nameKey: nameKey(f.name) })), null), now()));
      return list(workspaceId);
    },

    /**
     * One paid search, which Direx pays for: refused past the month's cap. Its estimate is recorded as
     * the spend, with who ran it, whatever it finds.
     */
    async search(workspaceId: string, userId: string, terms: string[]): Promise<ProposalList | SearchRefusal> {
      const refused = await refuseTerms(workspaceId, terms);
      if (refused) return refused;
      const at = now();
      const month = utcMonth(at);
      // Skip quoting if the month is already full. Only the locked reservation can admit a search.
      if ((await inWorkspace(workspaceId, (tx) => searchesInMonth(tx, month))) >= SEARCHES_PER_MONTH) return { ok: false, reason: "search_limit" };
      const provider = discovery();
      let companies: Awaited<ReturnType<Discovery["search"]>>;
      let findId: string;
      try {
        const { usd } = await provider.estimate(terms, SEARCH_LIMIT);
        const confirmedMicros = Math.round(usd * 1_000_000);
        const reserved = await inWorkspace(workspaceId, (tx) => reserveSearch(tx, workspaceId, { terms, confirmedMicros, by: userId }, at, month, SEARCHES_PER_MONTH));
        if (reserved === null) return { ok: false, reason: "search_limit" };
        findId = reserved;
        // The reservation is durable. A discovery error may still have incurred spend.
        companies = await provider.search(workspaceId, terms, SEARCH_LIMIT);
      } catch (e) {
        if (e instanceof NotAvailable) return { ok: false, reason: "not_available" };
        throw e;
      }
      const found = companies.map((c) => ({ name: c.name.trim().slice(0, 100) || c.domain, nameKey: nameKey(c.name || c.domain), site: `https://${c.domain}/`, comparisonUrl: null }));
      const ownSite = await deps.site(workspaceId);
      await inWorkspace(workspaceId, async (tx) => addSearchProposals(tx, workspaceId, findId, await fresh(tx, found, ownSite), now()));
      return list(workspaceId);
    },

    /** False when there is no such open proposal. */
    dismiss: async (workspaceId: string, userId: string, id: string) => (await inWorkspace(workspaceId, (tx) => closeProposals(tx, [id], userId, "dismissed", now()))).length > 0,
  };
}
export type Proposals = ReturnType<typeof createProposals>;
