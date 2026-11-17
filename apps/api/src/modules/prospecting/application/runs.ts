// SPDX-License-Identifier: AGPL-3.0-only
// A run over companies a person pasted or a search found. Each new company gets one row and one queued
// read in the same transaction as the run, so a retry or a double submit finds them known and stores
// nothing twice. A pasted run pays no search vendor. Its only spend is one names run per company read,
// and each of those is capped by the agents module, so the run is bounded by how many companies it takes.
// A search run also pays the search, and takes only the companies its confirmed amount still covers.
import type { PgBoss } from "pg-boss";
import type { Discovery } from "../../extensions/index";
import { sharedMailDomain } from "../../people";
import { addCompanies, addRun, companiesPage, finishRun, inWorkspace, knownCompanies, lockNewCompanies, recentRuns, runWithProgress, uncheckedOfRun, type ProspectingTx } from "../adapters/repo";
import { sendCompanyRead, sendCompanyVerify } from "../adapters/queue";
import { knownNames } from "../adapters/terms-repo";
import { companyDomain, firmName } from "../domain/domains";
import { SIGNAL_TYPES, type SignalType } from "../domain/signals";
import { holdsPersonData } from "../domain/terms";

/** Companies one run may read. */
export const MAX_COMPANIES = 200;
const PAGE = 100;

/**
 * [DEFAULT] worst-case costs per company that the estimate adds to the search, and that a search run's
 * confirmed amount must cover for each company it reads. They are bounds, not prices.
 */
export const ESTIMATE_DEFAULTS = {
  /** One names run per company read, at most what the agents module lets one run spend. */
  namesUsdPerCompany: 1,
  /** Two checks of at most $0.01 each: an unknown is checked once more, or first@ is followed by first.last@. */
  verifyUsdPerAddress: 0.02,
  /** The two people a names run keeps, and two role addresses. */
  addressesPerCompany: 4,
} as const;

export type SearchInput = { terms: string[]; limit: number; signals: string[] };
/** `namesFree` when names runs go to a subscription, which costs no money per run, so the amount covers the search and checks only. */
export type Estimate = { searchUsd: number; namesUsd: number; verifyUsd: number; totalUsd: number; limit: number; namesFree: boolean; defaults: { namesUsdPerCompany: number; verifyUsdPerAddress: number; addressesPerCompany: number } };
export type SearchLine = { domain: string; name: string | null; ok: boolean; companyId?: string; runId?: string; reason?: "already_known" | "over_amount" };
type SearchRefusal = { ok: false; reason: "unknown_signal"; signals: string[] } | { ok: false; reason: "person_data"; terms: string[] } | { ok: false; reason: "below_estimate"; usd: number };
export type SearchResult = { ok: true; runId: string; status: "running" | "done" | "stopped"; searchUsd: number; results: SearchLine[] } | SearchRefusal;

export type PastedLine = { line: number; website: string; ok: boolean; companyId?: string; runId?: string; reason?: "invalid_website" | "duplicate" | "already_known"; sameAs?: number };
export type PastedResult = { ok: true; runId: string | null; results: PastedLine[] } | { ok: false; reason: "empty" | "too_many" | "unknown_signal"; max?: number; signals?: string[] };

// The site as pasted, reduced to where its home page is, so www. or plain http still reach it.
const homeOf = (value: string) => `${new URL(/^[a-z][a-z0-9+.-]*:/i.test(value) ? value : `https://${value}`).origin}/`;
const usdToMicros = (usd: number) => BigInt(Math.round(usd * 1_000_000));
const microsToUsd = (micros: bigint) => Number(micros) / 1_000_000;
const unknownSignals = (signals: string[]) => signals.filter((s) => !(SIGNAL_TYPES as readonly string[]).includes(s));
/** The worst-case bounds, with no money for names runs a subscription answers. */
const boundsFor = (namesFree: boolean) => ({ ...ESTIMATE_DEFAULTS, namesUsdPerCompany: namesFree ? 0 : ESTIMATE_DEFAULTS.namesUsdPerCompany });
const perCompanyMicros = (namesFree: boolean) => {
  const d = boundsFor(namesFree);
  return usdToMicros(d.namesUsdPerCompany + d.verifyUsdPerAddress * d.addressesPerCompany);
};

/** Which domains this Workspace already has, under the lock that keeps two runs from adding the same one. */
async function knownUnderLock(tx: ProspectingTx, workspaceId: string, domains: string[]) {
  await lockNewCompanies(tx, workspaceId);
  return new Map((await knownCompanies(tx, domains)).map((k) => [k.domain, k]));
}

/** Adds the run's new companies and queues one read for each. */
async function addAndQueue(boss: PgBoss, tx: ProspectingTx, workspaceId: string, runId: string, companies: { domain: string; website: string; name?: string | null }[], at: Date) {
  if (!companies.length) return [];
  const added = await addCompanies(tx, workspaceId, runId, companies, at);
  for (const c of added) await sendCompanyRead(boss, tx, { workspaceId, companyId: c.id }, at);
  return added;
}

/** Terms go to a search vendor, so a person's edit is checked again here as the terms run's output was. */
async function refuseTerms(workspaceId: string, a: SearchInput): Promise<SearchRefusal | null> {
  const unknown = unknownSignals(a.signals);
  if (unknown.length) return { ok: false, reason: "unknown_signal", signals: unknown };
  const names = await inWorkspace(workspaceId, knownNames);
  const failing = a.terms.filter((t) => holdsPersonData(t, names));
  return failing.length ? { ok: false, reason: "person_data", terms: failing } : null;
}

/** The worst case of a search run: the search, then every company read and every kept address checked. NotAvailable without discovery. */
export async function estimateSearch(workspaceId: string, discovery: Discovery, a: SearchInput, namesFree = false): Promise<({ ok: true } & Estimate) | SearchRefusal> {
  const refused = await refuseTerms(workspaceId, a);
  if (refused) return refused;
  const { usd: searchUsd } = await discovery.estimate(a.terms, a.limit);
  const d = boundsFor(namesFree);
  const namesUsd = a.limit * d.namesUsdPerCompany;
  const verifyUsd = a.limit * d.addressesPerCompany * d.verifyUsdPerAddress;
  return { ok: true, searchUsd, namesUsd, verifyUsd, totalUsd: microsToUsd(usdToMicros(searchUsd) + usdToMicros(namesUsd) + usdToMicros(verifyUsd)), limit: a.limit, namesFree, defaults: d };
}

/** The most reading one company and checking its addresses can cost, for an estimate of a pasted list. */
export const perCompanyUsd = (namesFree: boolean) => microsToUsd(perCompanyMicros(namesFree));

/** How many runs Find companies lists. */
const RECENT_RUNS = 20;

export function createRuns(deps: { boss: PgBoss; now?: () => Date }) {
  const now = deps.now ?? (() => new Date());

  return {
    async startPasted(workspaceId: string, a: { websites: string[]; signals: string[]; confirmedUsd: number; userId: string }): Promise<PastedResult> {
      const unknown = unknownSignals(a.signals);
      if (unknown.length) return { ok: false, reason: "unknown_signal", signals: unknown };
      const lines = a.websites.map((website, i) => ({ line: i + 1, website: website.trim() })).filter((l) => l.website);
      if (!lines.length) return { ok: false, reason: "empty" };

      const first = new Map<string, { line: number; website: string }>();
      const results = new Map<number, PastedLine>();
      for (const l of lines) {
        const domain = companyDomain(l.website, sharedMailDomain);
        if (!domain) results.set(l.line, { ...l, ok: false, reason: "invalid_website" });
        else if (first.has(domain)) results.set(l.line, { ...l, ok: false, reason: "duplicate", sameAs: first.get(domain)!.line });
        else first.set(domain, l);
      }

      const at = now();
      return inWorkspace(workspaceId, async (tx) => {
        const known = await knownUnderLock(tx, workspaceId, [...first.keys()]);
        for (const [domain, l] of first) {
          const k = known.get(domain);
          if (k) results.set(l.line, { ...l, ok: false, reason: "already_known", companyId: k.id, runId: k.runId });
        }
        const fresh = [...first].filter(([domain]) => !known.has(domain));
        if (fresh.length > MAX_COMPANIES) return { ok: false, reason: "too_many", max: MAX_COMPANIES } as const;
        let runId: string | null = null;
        if (fresh.length) {
          runId = await addRun(tx, { workspaceId, source: "pasted", signals: [...new Set(a.signals)], companyLimit: fresh.length, confirmedMicros: usdToMicros(a.confirmedUsd), confirmedBy: a.userId, now: at });
          const added = await addAndQueue(deps.boss, tx, workspaceId, runId, fresh.map(([domain, l]) => ({ domain, website: homeOf(l.website) })), at);
          for (const c of added) {
            const l = first.get(c.domain)!;
            results.set(l.line, { ...l, ok: true, companyId: c.id, runId });
          }
        }
        return { ok: true, runId, results: [...results.values()].sort((x, y) => x.line - y.line) } as const;
      });
    },

    /**
     * One search with the terms a person edited, never Person data, then the pasted path's dedupe. The
     * search is paid whatever it finds, so its estimate is recorded as its cost, and the companies read
     * are those the rest of the confirmed amount covers at worst case. One left over stops the run.
     */
    async startSearch(workspaceId: string, discovery: Discovery, a: SearchInput & { confirmedUsd: number; userId: string; namesFree?: boolean }): Promise<SearchResult> {
      const refused = await refuseTerms(workspaceId, a);
      if (refused) return refused;
      const { usd: searchUsd } = await discovery.estimate(a.terms, a.limit);
      if (a.confirmedUsd < searchUsd) return { ok: false, reason: "below_estimate", usd: searchUsd };
      const limit = Math.min(a.limit, MAX_COMPANIES);
      const found = await discovery.search(workspaceId, a.terms, limit);

      // Only the domain and the title are kept; a result's excerpt and address go no further.
      const byDomain = new Map<string, string | null>();
      for (const f of found) {
        const domain = companyDomain(f.domain, sharedMailDomain);
        if (domain && !byDomain.has(domain) && byDomain.size < limit) byDomain.set(domain, firmName(f.name, domain));
      }

      const at = now();
      const confirmedMicros = usdToMicros(a.confirmedUsd);
      const searchCostMicros = usdToMicros(searchUsd);
      return inWorkspace(workspaceId, async (tx) => {
        const known = await knownUnderLock(tx, workspaceId, [...byDomain.keys()]);
        const fresh = [...byDomain.keys()].filter((d) => !known.has(d));
        const room = confirmedMicros > searchCostMicros ? confirmedMicros - searchCostMicros : 0n;
        const take = fresh.slice(0, Number(room / perCompanyMicros(a.namesFree ?? false)));
        const status = take.length < fresh.length ? "stopped" : take.length ? "running" : "done";
        const runId = await addRun(tx, { workspaceId, source: "search", terms: a.terms, signals: [...new Set(a.signals)], companyLimit: limit, confirmedMicros, searchCostMicros, status, confirmedBy: a.userId, now: at });
        const added = new Map((await addAndQueue(deps.boss, tx, workspaceId, runId, take.map((domain) => ({ domain, website: homeOf(domain), name: byDomain.get(domain)! })), at)).map((c) => [c.domain, c.id]));
        const results = [...byDomain].map(([domain, name]): SearchLine => {
          const k = known.get(domain);
          if (k) return { domain, name, ok: false, reason: "already_known", companyId: k.id, runId: k.runId };
          const id = added.get(domain);
          return id ? { domain, name, ok: true, companyId: id, runId } : { domain, name, ok: false, reason: "over_amount" };
        });
        return { ok: true, runId, status, searchUsd, results } as const;
      });
    },

    /** The latest runs, so a person can find one again. A running run settles to done when it is opened. */
    async runs(workspaceId: string) {
      const rows = await inWorkspace(workspaceId, (tx) => recentRuns(tx, RECENT_RUNS));
      return rows.map(({ run, companies }) => ({
        id: run.id,
        source: run.source,
        terms: run.terms,
        status: run.status,
        confirmedUsd: microsToUsd(run.confirmedMicros),
        vendorCostUsd: microsToUsd(run.searchCostMicros + run.verifyCostMicros),
        companies,
        createdAt: run.createdAt.toISOString(),
        finishedAt: run.finishedAt?.toISOString() ?? null,
      }));
    },

    /** A run and its progress. It is done once every company it found is read and has its names, or says why not. */
    async run(workspaceId: string, runId: string) {
      return inWorkspace(workspaceId, async (tx) => {
        const found = await runWithProgress(tx, runId);
        if (!found) return null;
        const { run, progress } = found;
        let { status, finishedAt } = run;
        if (status === "running" && progress.companies > 0 && progress.readPending === 0 && progress.namesPending === 0) {
          // Settled when someone looks, since the read and names paths each finish one company, never the run.
          finishedAt = now();
          status = "done";
          await finishRun(tx, runId, finishedAt);
        }
        return {
          id: run.id,
          source: run.source,
          terms: run.terms,
          status,
          signals: run.signals as SignalType[],
          confirmedUsd: microsToUsd(run.confirmedMicros),
          vendorCostUsd: microsToUsd(run.searchCostMicros + run.verifyCostMicros),
          confirmedBy: run.confirmedBy,
          createdAt: run.createdAt.toISOString(),
          finishedAt: finishedAt?.toISOString() ?? null,
          progress,
          unchecked: (await uncheckedOfRun(tx, runId)).unchecked,
        };
      });
    },

    /**
     * Queues the checks again for every accepted company of the run, after the checking service refused
     * or answered unknown. Answered addresses aren't checked twice, so this is safe to repeat; it covers a
     * company whose first guess was refused before anything was stored, which no count can see.
     */
    async checkAgain(workspaceId: string, runId: string): Promise<{ queued: number } | null> {
      const at = now();
      return inWorkspace(workspaceId, async (tx) => {
        if (!(await runWithProgress(tx, runId))) return null;
        const { companyIds } = await uncheckedOfRun(tx, runId);
        for (const companyId of companyIds) await sendCompanyVerify(deps.boss, tx, { workspaceId, companyId }, at);
        return { queued: companyIds.length };
      });
    },

    /** One page of the Workspace's companies, or one run's, each saying why it or its addresses were left out, and the cursor for the next. */
    async companies(workspaceId: string, cursor?: string, runId?: string) {
      const { rows, addresses, signals } = await inWorkspace(workspaceId, (tx) => companiesPage(tx, cursor, PAGE + 1, runId));
      const page = rows.slice(0, PAGE);
      const own = <T extends { companyId: string }>(list: T[], id: string) => list.filter((x) => x.companyId === id).map(({ companyId: _, ...x }) => x);
      return {
        companies: page.map((c) => ({ ...c, addresses: own(addresses, c.id), signals: own(signals, c.id) })),
        next: rows.length > PAGE ? page[PAGE - 1]!.id : null,
      };
    },
  };
}

export type Runs = ReturnType<typeof createRuns>;
