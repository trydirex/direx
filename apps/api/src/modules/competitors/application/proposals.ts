// SPDX-License-Identifier: AGPL-3.0-only
// Competitor proposals: names Direx found on the Workspace's own site, waiting for a person. A scan
// reads that site's sitemap and each comparison page it names, under robots.txt, with no model. A
// proposal changes nothing: a person uses it to fill the form and adds the competitor, or dismisses it.
import { NotAvailable, noDiscovery, type Discovery } from "../../extensions/index";
import { holdsPersonData, knownNames } from "../../prospecting/index";
import { addScan, addSearch, closeProposals, inWorkspace, lastScan, listRows, openProposals, proposedBefore, type CompetitorsTx, type NewProposal, type ProposalRow } from "../adapters/repo";
import { nameKey, nameOf, namesFromSitemap, ownNames, siteFromLinks, siteKey } from "../domain/own-site";
import { siteReader, type SiteReadDeps } from "./find-pages";

/** The most comparison pages one scan reads. */
const MAX_NAMES = 10;
const TIMEOUT_MS = 30_000;
/** How many companies one paid search asks for. */
export const SEARCH_LIMIT = 10;
export const MAX_TERMS = 3;

export type Proposal = { id: string; name: string; site: string | null; comparisonUrl: string | null; source: "own_site" | "search"; terms: string[] | null; foundAt: Date };
export type ProposalList = { proposals: Proposal[]; site: string | null; scannedAt: Date | null; searchAvailable: boolean };
type SearchRefusal = { ok: false; reason: "bad_terms" | "person_data" | "not_available" | "below_estimate" };
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
    return inWorkspace(workspaceId, async (tx) => ({ proposals: (await openProposals(tx)).map(view), site, scannedAt: site ? await lastScan(tx, site) : null, searchAvailable }));
  }

  /** Terms go to a search vendor: 1 to 3 of them, and none holding an email, a web address or a known person's name. */
  async function refuseTerms(workspaceId: string, terms: string[]): Promise<SearchRefusal | null> {
    if (terms.length < 1 || terms.length > MAX_TERMS) return { ok: false, reason: "bad_terms" };
    const names = await inWorkspace(workspaceId, knownNames);
    return terms.some((t) => holdsPersonData(t, names)) ? { ok: false, reason: "person_data" } : null;
  }

  /** The search's cost, asked of the search vendor before anything is spent. */
  async function estimate(workspaceId: string, terms: string[]): Promise<{ ok: true; usd: number } | SearchRefusal> {
    const refused = await refuseTerms(workspaceId, terms);
    if (refused) return refused;
    try {
      return { ok: true, usd: (await discovery().estimate(terms, SEARCH_LIMIT)).usd };
    } catch (e) {
      if (e instanceof NotAvailable) return { ok: false, reason: "not_available" };
      throw e;
    }
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

    estimate,

    /** One paid search, once the person confirmed at least its estimate. It is recorded whatever it finds. */
    async search(workspaceId: string, userId: string, terms: string[], confirmedUsd: number): Promise<ProposalList | SearchRefusal> {
      const cost = await estimate(workspaceId, terms);
      if (!cost.ok) return cost;
      if (confirmedUsd < cost.usd) return { ok: false, reason: "below_estimate" };
      const companies = await discovery().search(workspaceId, terms, SEARCH_LIMIT);
      const found = companies.map((c) => ({ name: c.name.trim().slice(0, 100) || c.domain, nameKey: nameKey(c.name || c.domain), site: `https://${c.domain}/`, comparisonUrl: null }));
      const ownSite = await deps.site(workspaceId);
      const confirmedMicros = Math.round(confirmedUsd * 1_000_000);
      await inWorkspace(workspaceId, async (tx) => addSearch(tx, workspaceId, { terms, confirmedMicros, by: userId }, await fresh(tx, found, ownSite), now()));
      return list(workspaceId);
    },

    /** False when there is no such open proposal. */
    dismiss: async (workspaceId: string, userId: string, id: string) => (await inWorkspace(workspaceId, (tx) => closeProposals(tx, [id], userId, "dismissed", now()))).length > 0,
  };
}
export type Proposals = ReturnType<typeof createProposals>;
