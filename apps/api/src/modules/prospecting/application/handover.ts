// SPDX-License-Identifier: AGPL-3.0-only
// Handing a cohort to a Campaign. A cohort can hold thousands, so a person's request only queues a job,
// and the job goes through who the cohort matches now in batches the Campaign takes in one call. Only
// an address that is deliverable after a fresh check goes over; a guess never goes over for anyone in
// Canada. The full evidence stays here; the Campaign gets a summary.
import type { VerificationResult } from "@direx/plugin-sdk";
import type { PgBoss } from "pg-boss";
import { MAX_ROWS, type Campaigns, type PersonInput, type PersonResult } from "../../campaigns/index";
import { cohortById } from "../adapters/cohorts-repo";
import { addHandover, addressesOfPerson, keptFor, campaignExists, campaignSkips, canadianAddresses, checkedAt, failHandover, finishHandover, handoverById, handoverCounts, handoverNames, pendingMembers, resultsPage, saveBatch, savePendingBatch, signalsOfPerson, type HandoverResultRow } from "../adapters/handover-repo";
import { HANDOVER_QUEUE, Handover, sendHandover } from "../adapters/queue";
import { inWorkspace } from "../adapters/repo";
import { mayGuessIn } from "../domain/guesses";
import { createCohorts, type CohortMember } from "./cohorts";
import type { Verifier } from "./verify";

const PAGE = 100;
const HOLD_RETRY_MS = 60_000;
type BatchMember = Awaited<ReturnType<typeof pendingMembers>>[number];

/** The first line of what broke, without the values a failed query lists after it. */
export const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e)).split("\nparams:")[0]!.split("\n")[0]!.slice(0, 200);

/**
 * The Campaign's evidence field: how the address was found, its check, and the page it came from. The
 * page address goes last, so if the Campaign has to cut the summary to fit, only the address is cut.
 */
export function evidenceSummary(m: Pick<CohortMember, "source" | "pattern" | "evidence">, result: VerificationResult, verifiedAt: Date | null): string {
  const found = m.source === "guessed" ? `Guessed address (${m.pattern}@) for a person named on the company's site` : "Address published on the company's site";
  const checked = `verified ${result}${verifiedAt ? ` on ${verifiedAt.toISOString().slice(0, 10)}` : ""}`;
  return `${found}; ${checked}; page read ${m.evidence.readAt}, snapshot ${m.evidence.snapshotId}: ${m.evidence.pageUrl}`;
}

// Ours are not_deliverable and guess_in_canada; the rest are the Campaign's: suppressed, already_contacted,
// removed, or why it refused the row.
const leftOut = (addressId: string, reason: string, personId: string | null = null): HandoverResultRow => ({ addressId, status: "left_out", reason, personId, conflictItemId: null, missing: [] });

function fromCampaign(addressId: string, r: PersonResult): HandoverResultRow {
  switch (r.status) {
    case "added":
    case "joined":
      return { addressId, status: r.status, reason: null, personId: r.personId, conflictItemId: null, missing: r.missing };
    case "conflict":
      return { addressId, status: "conflict", reason: null, personId: r.personId, conflictItemId: r.conflictItemId, missing: r.missing };
    case "refused":
      return leftOut(addressId, r.reason);
    default:
      return leftOut(addressId, r.status, r.personId);
  }
}

export function createHandovers(deps: { boss: PgBoss; campaigns: () => Pick<Campaigns, "addPeopleRows">; freshResults: Verifier["freshResults"]; now?: () => Date; batchSize?: number }) {
  const now = deps.now ?? (() => new Date());
  const batchSize = Math.min(deps.batchSize ?? MAX_ROWS, MAX_ROWS);
  const cohorts = createCohorts({ now });

  async function handBatch(h: { id: string; campaignId: string; createdBy: string }, workspaceId: string, members: BatchMember[], cursor: string): Promise<"saved" | "operator_hold"> {
    const out = new Map<string, HandoverResultRow>();
    // Checked before verification, so nothing is paid for a guess that can't go over.
    const guesses = members.filter((m) => m.source === "guessed");
    const canadian = await inWorkspace(workspaceId, (tx) => canadianAddresses(tx, guesses.map((m) => m.email)));
    for (const m of guesses) if (!mayGuessIn(m.company.country) || canadian.has(m.email)) out.set(m.addressId, leftOut(m.addressId, "guess_in_canada"));

    const toCheck = members.filter((m) => !out.has(m.addressId)).map((m) => m.addressId);
    const fresh = await deps.freshResults(workspaceId, toCheck);
    if (fresh.status === "operator_hold") return "operator_hold";
    const dates = await inWorkspace(workspaceId, (tx) => checkedAt(tx, toCheck));
    const sendable: { m: BatchMember; row: PersonInput }[] = [];
    for (const m of members) {
      if (out.has(m.addressId)) continue;
      const result = fresh.results.get(m.addressId);
      if (result !== "deliverable") {
        out.set(m.addressId, leftOut(m.addressId, "not_deliverable"));
        continue;
      }
      sendable.push({
        m,
        row: {
          email: m.email,
          firstName: m.name?.split(/\s+/)[0] ?? null,
          company: m.company.name ?? m.company.domain,
          website: m.company.domain,
          // An unknown country adds the Person without one, which keeps them out of drafts until a person enters it.
          country: m.company.country,
          basis: m.source === "guessed" ? "legitimate_interest" : "published_address",
          evidence: evidenceSummary(m, result, dates.get(m.addressId) ?? null),
          // The country is read from the company, and a company page rarely says how the business is set up.
          entityType: "unknown",
          confidence: "inferred",
        },
      });
    }
    if (sendable.length) {
      const added = await deps.campaigns().addPeopleRows(workspaceId, h.campaignId, sendable.map((s) => s.row), { userId: h.createdBy });
      // The Campaign can't be gone (rows are never deleted) and a batch is never over the limit, so this is a fault to retry.
      if (!added.ok) throw new Error(`prospecting: hand-over ${h.id} was refused by the Campaign (${added.reason})`);
      // What went over with each address is kept, so a Person with no country yet can get it back later.
      added.results.forEach((r, i) => out.set(sendable[i]!.m.addressId, { ...fromCampaign(sendable[i]!.m.addressId, r), basis: sendable[i]!.row.basis, evidence: sendable[i]!.row.evidence }));
    }
    const results = members.map((m) => out.get(m.addressId)!);
    await inWorkspace(workspaceId, (tx) => saveBatch(tx, { workspaceId, handoverId: h.id, results, cursor, at: now() }));
    return "saved";
  }

  return {
    /** Queues handing the cohort to the Campaign. Null when either isn't in this Workspace. */
    async start(workspaceId: string, a: { cohortId: string; campaignId: string; userId: string }): Promise<{ handoverId: string } | null> {
      const at = now();
      return inWorkspace(workspaceId, async (tx) => {
        if (!(await cohortById(tx, a.cohortId)) || !(await campaignExists(tx, a.campaignId))) return null;
        const handoverId = await addHandover(tx, { workspaceId, ...a, now: at });
        await sendHandover(deps.boss, tx, { workspaceId, handoverId }, at);
        return { handoverId };
      });
    },

    /**
     * What adding the cohort would do now, writing nothing and paying for no check: the guess and
     * Campaign rules as the job runs them, and each address's last check result. An address not checked
     * yet, or whose check couldn't tell, counts as going over, since the job checks it first; so it's "about".
     * Null when the cohort or the Campaign isn't in this Workspace.
     */
    async preview(workspaceId: string, a: { cohortId: string; campaignId: string }): Promise<{ added: number; skipped: { reason: string; count: number }[] } | null> {
      if (!(await inWorkspace(workspaceId, async (tx) => (await cohortById(tx, a.cohortId)) && (await campaignExists(tx, a.campaignId))))) return null;
      const members: CohortMember[] = [];
      for (let cursor: string | undefined, more = true; more; ) {
        const page = await cohorts.cohortMembers(workspaceId, a.cohortId, cursor);
        members.push(...(page?.members ?? []));
        cursor = page?.next ?? undefined;
        more = !!cursor;
      }
      const why = new Map<string, string>();
      const guesses = members.filter((m) => m.source === "guessed");
      const canadian = await inWorkspace(workspaceId, (tx) => canadianAddresses(tx, guesses.map((m) => m.email)));
      for (const m of guesses) if (!mayGuessIn(m.company.country) || canadian.has(m.email)) why.set(m.addressId, "guess_in_canada");
      for (const m of members) if (!why.has(m.addressId) && m.verificationResult && m.verificationResult !== "deliverable" && m.verificationResult !== "unknown") why.set(m.addressId, "not_deliverable");
      const rest = members.filter((m) => !why.has(m.addressId));
      const campaign = await inWorkspace(workspaceId, (tx) => campaignSkips(tx, a.campaignId, rest.map((m) => m.email)));
      for (const m of rest) {
        const r = campaign.get(m.email);
        if (r) why.set(m.addressId, r);
      }
      const counts = new Map<string, number>();
      for (const r of why.values()) counts.set(r, (counts.get(r) ?? 0) + 1);
      return { added: members.length - why.size, skipped: [...counts].map(([reason, count]) => ({ reason, count })).sort((x, y) => y.count - x.count) };
    },

    /** The job: every batch after the saved cursor, then done. A batch that fails is tried again from its start. */
    async run({ workspaceId, handoverId }: Handover): Promise<void> {
      const h = await inWorkspace(workspaceId, (tx) => handoverById(tx, handoverId));
      if (!h || h.status === "done") return;
      let cursor = h.cursor ?? undefined;
      let pending = h.pendingAddressIds;
      for (let more = true; more; ) {
        let batch: BatchMember[];
        if (pending?.length) {
          const ids = pending;
          batch = await inWorkspace(workspaceId, (tx) => pendingMembers(tx, workspaceId, ids));
          cursor = ids.at(-1)!;
          pending = null;
        } else {
          batch = [];
          while (batch.length < batchSize) {
            const page = await cohorts.cohortMembers(workspaceId, h.cohortId, cursor);
            const taken = page?.members.slice(0, batchSize - batch.length) ?? [];
            batch.push(...taken);
            cursor = taken.at(-1)?.addressId ?? cursor;
            if (taken.length < (page?.members.length ?? 0)) break;
            if (!page?.next) {
              more = false;
              break;
            }
          }
          if (!batch.length) break;
          await inWorkspace(workspaceId, (tx) => savePendingBatch(tx, handoverId, batch.map((m) => m.addressId)));
        }
        if ((await handBatch(h, workspaceId, batch, cursor!)) === "operator_hold") {
          // Upsert one delayed successor. A hold can outlast the queue's normal fault retries.
          const job = Handover.parse({ workspaceId, handoverId });
          await deps.boss.upsert(HANDOVER_QUEUE, job, { singletonKey: handoverId, startAfter: new Date(now().getTime() + HOLD_RETRY_MS) });
          return;
        }
      }
      await inWorkspace(workspaceId, (tx) => finishHandover(tx, handoverId, now()));
    },

    /** The job's last try failed: what was handed over stays, and the hand-over says why it stopped. */
    async giveUp({ workspaceId, handoverId }: Handover, e: unknown): Promise<void> {
      await inWorkspace(workspaceId, (tx) => failHandover(tx, handoverId, errorText(e), now()));
    },

    /** A hand-over, how many addresses ended each way so far, and one page of results. Null when it isn't in this Workspace. */
    async handover(workspaceId: string, id: string, cursor?: string) {
      return inWorkspace(workspaceId, async (tx) => {
        const h = await handoverById(tx, id);
        if (!h) return null;
        const rows = await resultsPage(tx, id, cursor, PAGE + 1);
        const page = rows.slice(0, PAGE);
        const counts = await handoverCounts(tx, id);
        return {
          id: h.id,
          cohortId: h.cohortId,
          campaignId: h.campaignId,
          ...(await handoverNames(tx, id)),
          // Held to these values by the table's checks.
          status: h.status as "running" | "done" | "failed",
          failureReason: h.failureReason,
          createdAt: h.createdAt.toISOString(),
          finishedAt: h.finishedAt?.toISOString() ?? null,
          counts: { added: counts.added, joined: counts.joined, conflict: counts.conflict, leftOut: counts.left_out },
          results: page.map((r) => ({ ...r, status: r.status as HandoverResultRow["status"] })),
          next: rows.length > PAGE ? page[PAGE - 1]!.addressId : null,
        };
      });
    },
  };
}

export type Handovers = ReturnType<typeof createHandovers>;

export type PersonSignal = { type: string; quote: string; pageUrl: string; observedOn: string };

/** The signals of the companies a Person was handed over from. Only an accepted company hands anyone over, so a person confirmed each. */
/** For a Person whose country was entered after the hand-over: the basis and evidence they went over with. */
export const keptEligibility = (workspaceId: string, email: string) => inWorkspace(workspaceId, (tx) => keptFor(tx, email));

export const signalsFor = (workspaceId: string, personId: string): Promise<PersonSignal[]> => inWorkspace(workspaceId, (tx) => signalsOfPerson(tx, personId));

/** Whether a Person came over on a role address, such as sales@, or a guessed one, so the approval can say so. */
export async function addressLabelsFor(workspaceId: string, personId: string): Promise<{ roleAddress: boolean; guessedAddress: boolean }> {
  const rows = await inWorkspace(workspaceId, (tx) => addressesOfPerson(tx, personId));
  return { roleAddress: rows.some((r) => r.kind === "function"), guessedAddress: rows.some((r) => r.source === "guessed") };
}
