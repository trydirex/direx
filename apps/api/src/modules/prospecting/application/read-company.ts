// SPDX-License-Identifier: AGPL-3.0-only
// Reads one company's own site: robots.txt first, then the home page and the pages its links point to
// that a reviewer wants, one at a time. Addresses, notices, signals and the country come from code over
// what the site served. Who works there comes from a names run started once the read is recorded. The
// pages are untrusted, and nothing here acts on their words: they only become rows a person reviews.
import { createHash } from "node:crypto";
import { allowed, capped, linksIn, PAGE_READER_AGENT, robotsFrom, type FetchHtml } from "../../agents/index";
import { companyToRead, inWorkspace, recordRead, type ReadOutcome, type StoredAddress } from "../adapters/repo";
import type { CompanyRead } from "../adapters/queue";
import { classify, extractAddresses, leftOutBecause, pageText } from "../domain/addresses";
import { countryFrom } from "../domain/country";
import { doNotEmailNotice } from "../domain/notice";
import { findSignals, keepQuoted, SIGNAL_TYPES, type SignalType } from "../domain/signals";
import { startNames, type StartNames } from "./names";
import type { OpenReview } from "./review";

/**
 * Without `startNames`, as where no models are set up, each read records its names as skipped.
 * `openReview` makes the company's review Item once nothing is pending.
 */
export type CompanyReaderDeps = { fetchHtml: FetchHtml; startNames?: StartNames; openReview?: OpenReview; now?: () => Date };

/** Pages read per site, the home page included. */
export const MAX_PAGES = 6;
// A page whose text is shorter than this is an app shell that needs JavaScript to show anything.
const MIN_TEXT_CHARS = 100;
// Pages where a firm names its people, publishes addresses, or shows hiring and blog activity.
const WANTED = /\b(about|team|contact|people|staff|careers?|jobs|blog|news)\b/i;

const digestOf = (text: string) => createHash("sha256").update(text).digest("hex");

const pathOf = (url: string) => {
  const u = new URL(url);
  return u.pathname + u.search;
};

/** The wanted links in page order, one per kind of page first, then any others. */
function pagesToRead(links: readonly string[], home: string, room: number): string[] {
  const wanted = links.filter((l) => l !== home && WANTED.test(new URL(l).pathname));
  const kinds = new Set<string>();
  const first = wanted.filter((l) => {
    const kind = WANTED.exec(new URL(l).pathname)![1]!.toLowerCase().replace(/s$/, "");
    return !kinds.has(kind) && kinds.add(kind);
  });
  return [...new Set([...first, ...wanted])].slice(0, room);
}

export function createCompanyReader(deps: CompanyReaderDeps) {
  const now = deps.now ?? (() => new Date());

  async function readSite(website: string, domain: string, signals: readonly SignalType[]): Promise<ReadOutcome> {
    const robotsAnswer = await deps.fetchHtml(website, "/robots.txt");
    const robots = robotsFrom(robotsAnswer.ok ? robotsAnswer : { ok: false, status: robotsAnswer.status });
    if (!allowed(robots, PAGE_READER_AGENT, pathOf(website))) return { status: "not_read", reason: "robots_txt" };
    const home = await deps.fetchHtml(website, website);
    if (!home.ok) return { status: "not_read", reason: home.status === 401 || home.status === 403 ? "refused" : home.reason };
    if (pageText(home.html).length < MIN_TEXT_CHARS) return { status: "not_read", reason: "no_text" };

    const pages = [{ url: home.url, html: home.html }];
    for (const link of pagesToRead(linksIn(home.html, home.url, website), home.url, MAX_PAGES - 1)) {
      if (!allowed(robots, PAGE_READER_AGENT, pathOf(link))) continue;
      const page = await deps.fetchHtml(website, link);
      // One page that fails doesn't make the site unreadable; a redirect can land on a page already read.
      if (page.ok && !pages.some((p) => p.url === page.url)) pages.push({ url: page.url, html: page.html });
    }

    // Code reads the whole page; only the stored copy is cut, so a footer address on a long page counts.
    const full = pages.map((p) => ({ url: p.url, text: pageText(p.html) }));
    const snapshots = full.map((p) => ({ url: p.url, text: capped(p.text) }));
    // A notice anywhere on the site is about the firm's addresses, so it covers each one found.
    const noticeFound = pages.some((p) => doNotEmailNotice(p.html) !== null);
    const addresses = new Map<string, StoredAddress>();
    for (const page of pages) {
      for (const email of extractAddresses(page.html)) {
        if (addresses.has(email)) continue;
        // No one is known yet: the names run may make an unknown address someone's.
        const { kind } = classify(email, []);
        addresses.set(email, {
          email,
          kind,
          name: null,
          role: null,
          pageUrl: page.url,
          noticeFound,
          leftOutReason: leftOutBecause({ email, kind, noticeFound }, domain),
        });
      }
    }
    const read = now();
    return {
      status: "read",
      country: countryFrom(snapshots.map((s) => s.text)),
      pages: snapshots.map((s) => ({ url: s.url, text: s.text, digest: digestOf(s.text) })),
      addresses: [...addresses.values()],
      signals: keepQuoted(findSignals({ pages: full, enabled: signals, now: read }), snapshots),
    };
  }

  /** Reads one company and records what it found. False when there was nothing to read. */
  async function read(job: CompanyRead): Promise<boolean> {
    const company = await inWorkspace(job.workspaceId, (tx) => companyToRead(tx, job.companyId));
    if (!company) return false;
    let recorded = false;
    // A company already read is finished work, apart from its review, which a retried job may still owe.
    if (company.readStatus === "pending") {
      const enabled = SIGNAL_TYPES.filter((t) => company.signals.includes(t));
      const outcome = await readSite(company.website, company.domain, enabled);
      recorded = await inWorkspace(job.workspaceId, (tx) => recordRead(tx, job.workspaceId, job.companyId, outcome, now()));
      // ponytail: a crash between the record and this start leaves the names pending with no run; a sweep of old pending names would cover it. A run that starts and ends without names settles through namesEnded.
      if (recorded && outcome.status === "read") {
        await startNames(deps.startNames, { workspaceId: job.workspaceId, companyId: job.companyId, domain: company.domain, pages: outcome.pages, startedBy: job.startedBy ?? company.confirmedBy, now: now() });
      }
    }
    // Names that were skipped settle here; names a run reads settle in its sink, which opens the review there.
    await deps.openReview?.(job.workspaceId, job.companyId);
    return recorded;
  }

  /** The job's last try failed: the company is recorded as not read, so its review can still open. */
  async function giveUp(job: { workspaceId: string; companyId: string }): Promise<void> {
    await inWorkspace(job.workspaceId, (tx) => recordRead(tx, job.workspaceId, job.companyId, { status: "not_read", reason: "read_failed" }, now()));
    await deps.openReview?.(job.workspaceId, job.companyId);
  }

  return { read, giveUp };
}
