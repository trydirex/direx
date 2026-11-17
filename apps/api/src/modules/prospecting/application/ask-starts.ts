// SPDX-License-Identifier: AGPL-3.0-only
// Prospecting's work a person may ask for in Ask (ADR 0008 rule 028): search terms from the Strategy,
// the Audience screen's own call, and reading a company again, which no screen does yet (Ask v2
// spec, decision Q1). A re-read puts the company back to pending and queues its usual read job, so
// its names step follows as it does for a new company, as the person who accepted.
import { createHash } from "node:crypto";
import type { PgBoss } from "pg-boss";
import { z } from "zod";
import { askStart, type AskStart, type WorkReport } from "../../agents/index";
import { companyForReread, inWorkspace, resetRead } from "../adapters/repo";
import { sendCompanyRead } from "../adapters/queue";
import { termsDrafter } from "../definitions/terms-drafter";
import { termsText } from "../domain/terms";
import type { ReadStrategy, Terms } from "./terms";

type Deps = { boss: PgBoss; terms: () => Pick<Terms, "draft">; strategy: ReadStrategy; report: (workspaceId: string, runId: string) => Promise<WorkReport | null>; now?: () => Date };

const RUN = "agent_run";
const READ = "company_read";
type Company = NonNullable<Awaited<ReturnType<typeof companyForReread>>>;
/** A read or its names step still going: there is nothing to start, only something to wait for. */
const busy = (c: Company) => c.readStatus === "pending" || c.namesStatus === "pending";

export function prospectingAskStarts(d: Deps): AskStart[] {
  const now = d.now ?? (() => new Date());
  return [
    askStart({
      id: "draft_terms",
      definition: termsDrafter.id,
      area: "outreach",
      says: "Draft search terms for finding companies, from the Strategy's audience. Args: none.",
      args: z.strictObject({}),
      permission: "item.edit",
      async check(workspaceId) {
        const { current } = await d.strategy(workspaceId);
        if (!current?.whoFor.trim()) return { ok: false, why: "no_strategy" };
        return { ok: true, title: "Draft search terms from the Strategy", basis: `strategy:${createHash("sha256").update(termsText(current)).digest("hex").slice(0, 16)}` };
      },
      async start(workspaceId, _a, by) {
        const r = await d.terms().draft(workspaceId, by.userId, { key: by.key, tainted: by.tainted });
        return r.ok ? { ok: true, work: { kind: RUN, id: r.runId } } : { ok: false, why: r.reason };
      },
      report: (workspaceId, work) => (work.kind === RUN ? d.report(workspaceId, work.id) : Promise.resolve(null)),
    }),
    askStart({
      id: "reread_company",
      definition: "names_reader",
      area: "outreach",
      says: "Read one company's website again and find the names on it, while its review is still open. Args: companyId, from read_companies.",
      args: z.strictObject({ companyId: z.uuid() }),
      permission: "item.edit",
      async check(workspaceId, a) {
        const c = await inWorkspace(workspaceId, (tx) => companyForReread(tx, a.companyId));
        if (!c) return { ok: false, why: "not_found" };
        if (c.state === "accepted" || c.state === "rejected") return { ok: false, why: "already_reviewed" };
        if (busy(c)) return { ok: false, why: "busy" };
        return { ok: true, title: `Read ${c.name ?? c.domain} again and find its names`, basis: `company:${c.updatedAt.toISOString()}` };
      },
      // A retry finds the read it already queued still going, and points at it rather than refusing.
      start: (workspaceId, a, by) =>
        inWorkspace(workspaceId, async (tx) => {
          const c = await companyForReread(tx, a.companyId, true);
          if (!c) return { ok: false, why: "not_found" } as const;
          if (busy(c)) return { ok: true, work: { kind: READ, id: a.companyId } } as const;
          if (c.state === "accepted" || c.state === "rejected") return { ok: false, why: "already_reviewed" } as const;
          const at = now();
          await resetRead(tx, a.companyId, at);
          await sendCompanyRead(d.boss, tx, { workspaceId, companyId: a.companyId, startedBy: by.userId }, at);
          return { ok: true, work: { kind: READ, id: a.companyId } } as const;
        }),
      async report(workspaceId, work) {
        if (work.kind !== READ) return null;
        const c = await inWorkspace(workspaceId, (tx) => companyForReread(tx, work.id));
        if (!c) return null;
        if (busy(c)) return { state: "running", itemIds: [] };
        return { state: c.readStatus === "not_read" ? "failed" : "done", itemIds: c.reviewItemId ? [c.reviewItemId] : [] };
      },
    }),
  ];
}
