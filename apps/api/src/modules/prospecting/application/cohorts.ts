// SPDX-License-Identifier: AGPL-3.0-only
// Saving and reading cohorts. A cohort holds a filter, never a list of people, so who is in it is
// worked out when someone asks and changes as companies are accepted.
import { addCohort, allCohorts, changeCohort, cohortById, cohortCount, cohortPage, cohortUse } from "../adapters/cohorts-repo";
import { inWorkspace } from "../adapters/repo";
import { parseCohortFilter, storedCohortFilter, type CohortFilter, type CohortFilterRefusal } from "../domain/cohort-filter";

const PAGE = 100;

type Row = { id: string; name: string; filter: unknown; createdBy: string; createdAt: Date; updatedAt: Date };
export type Cohort = { id: string; name: string; filter: CohortFilter; createdBy: string; createdAt: string; updatedAt: string };
export type CohortMember = {
  addressId: string;
  email: string;
  kind: string;
  name: string | null;
  role: string | null;
  source: string;
  pattern: string | null;
  verificationResult: string | null;
  verifiedAt: string | null;
  company: { id: string; domain: string; name: string | null; country: string | null };
  evidence: { pageUrl: string; readAt: string; snapshotId: string };
};
export type CohortMembers = { members: CohortMember[]; next: string | null };
/** How many it matches, how many of those last checked deliverable, and where it was handed over. */
export type CohortStats = {
  count: number;
  deliverable: number;
  inCampaign: number;
  usedBy: { campaignId: string; title: string; people: number; lastAddedAt: string }[];
};
export type SaveResult = { ok: true; cohort: Cohort } | ({ ok: false } & CohortFilterRefusal);

// A filter stored before a field existed comes back with that field empty.
const shape = (r: Row): Cohort => ({ ...r, filter: storedCohortFilter(r.filter), createdAt: r.createdAt.toISOString(), updatedAt: r.updatedAt.toISOString() });

export function createCohorts(deps: { now?: () => Date } = {}) {
  const now = deps.now ?? (() => new Date());

  async function members(workspaceId: string, filter: CohortFilter, cursor?: string): Promise<CohortMembers> {
    const rows = await inWorkspace(workspaceId, (tx) => cohortPage(tx, workspaceId, filter, cursor, PAGE + 1));
    const page = rows.slice(0, PAGE);
    return {
      members: page.map((r) => ({
        addressId: r.addressId,
        email: r.email,
        kind: r.kind,
        name: r.name,
        role: r.role,
        source: r.source,
        pattern: r.pattern,
        verificationResult: r.verificationResult,
        verifiedAt: r.verifiedAt?.toISOString() ?? null,
        company: { id: r.companyId, domain: r.domain, name: r.companyName, country: r.country },
        evidence: { pageUrl: r.pageUrl, readAt: r.readAt.toISOString(), snapshotId: r.snapshotId },
      })),
      next: rows.length > PAGE ? page[PAGE - 1]!.addressId : null,
    };
  }

  return {
    async save(workspaceId: string, a: { name: string; filter: unknown; userId: string }): Promise<SaveResult> {
      const parsed = parseCohortFilter(a.filter);
      if (!parsed.ok) return parsed;
      const row = await inWorkspace(workspaceId, (tx) => addCohort(tx, { workspaceId, name: a.name, filter: parsed.filter, userId: a.userId, now: now() }));
      return { ok: true, cohort: shape(row) };
    },

    /** Null when the cohort isn't in this Workspace. */
    async update(workspaceId: string, id: string, a: { name: string; filter: unknown }): Promise<SaveResult | null> {
      const parsed = parseCohortFilter(a.filter);
      if (!parsed.ok) return parsed;
      const row = await inWorkspace(workspaceId, (tx) => changeCohort(tx, id, { name: a.name, filter: parsed.filter, now: now() }));
      return row ? { ok: true, cohort: shape(row) } : null;
    },

    /** How many a filter matches now, before anyone saves it. */
    async count(workspaceId: string, filter: unknown): Promise<{ ok: true; count: number } | ({ ok: false } & CohortFilterRefusal)> {
      const parsed = parseCohortFilter(filter);
      if (!parsed.ok) return parsed;
      return { ok: true, count: await inWorkspace(workspaceId, (tx) => cohortCount(tx, workspaceId, parsed.filter)) };
    },

    async list(workspaceId: string): Promise<Cohort[]> {
      return (await inWorkspace(workspaceId, allCohorts)).map(shape);
    },

    /** A cohort with its numbers now and one page of who it matches, or null when it isn't in this Workspace. */
    async cohort(workspaceId: string, id: string, cursor?: string): Promise<(Cohort & CohortStats & CohortMembers) | null> {
      const found = await inWorkspace(workspaceId, async (tx) => {
        const row = await cohortById(tx, id);
        if (!row) return null;
        const f = storedCohortFilter(row.filter);
        // A filter that leaves deliverable out has none, without asking.
        const deliverable = f.verification.length && !f.verification.includes("deliverable") ? 0 : await cohortCount(tx, workspaceId, { ...f, verification: ["deliverable"] });
        const use = await cohortUse(tx, id);
        return { row, count: await cohortCount(tx, workspaceId, f), deliverable, inCampaign: use.inCampaign, usedBy: use.usedBy.map((u) => ({ ...u, lastAddedAt: u.lastAddedAt.toISOString() })) };
      });
      if (!found) return null;
      const { row, ...stats } = found;
      const cohort = shape(row);
      return { ...cohort, ...stats, ...(await members(workspaceId, cohort.filter, cursor)) };
    },

    /** One page of who a cohort matches now, for handing them over. Null when it isn't in this Workspace. */
    async cohortMembers(workspaceId: string, cohortId: string, cursor?: string): Promise<CohortMembers | null> {
      const row = await inWorkspace(workspaceId, (tx) => cohortById(tx, cohortId));
      return row ? members(workspaceId, storedCohortFilter(row.filter), cursor) : null;
    },
  };
}

export type Cohorts = ReturnType<typeof createCohorts>;
