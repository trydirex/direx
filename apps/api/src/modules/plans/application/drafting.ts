// SPDX-License-Identifier: AGPL-3.0-only
// What a drafting run is given, and how its output lands. It only ever fills a draft: no Item and no
// version, so a person always reads and submits it. It never replaces what a person saved after the
// run started, and a citation that doesn't hold becomes an assumption rather than a claim.
import type { DraftInput, Sink } from "../../agents";
import type { Facts } from "../../facts";
import { ensureStrategy, fillPlanDraft, fillStrategyDraft, inWorkspace, lockPlan, readingStanding, readPlan, readStrategy, readStrategyVersion } from "../adapters/repo";
import { readingStands } from "../domain/labels";
import type { Basis, PlanBody, StrategyBody } from "../domain/types";

type FactReads = Pick<Facts, "usableFacts" | "checkCitation">;

export function drafting({ facts, now }: { facts: FactReads; now: () => Date }) {
  async function brief(workspaceId: string): Promise<DraftInput["brief"]> {
    const usable = await facts.usableFacts(workspaceId);
    const list = usable.map((f) => `${f.id} version ${f.version}: ${f.field}${f.subject ? ` (${f.subject})` : ""}: ${f.value}`).join("\n");
    return [
      { kind: "date", refId: "today", version: null, text: `Today is ${now().toISOString().slice(0, 10)}.` },
      { kind: "citable_facts", refId: "usable_facts", version: null, text: usable.length ? `Facts you may cite, by id and version:\n${list}` : "There are no Facts to cite yet." },
    ];
  }

  return {
    async strategyDraftInput(workspaceId: string, request: string): Promise<DraftInput> {
      const row = await inWorkspace(workspaceId, readStrategy);
      return { request, brief: await brief(workspaceId), target: { id: row?.id ?? null, draftRevision: row?.draftRevision ?? 0 } };
    },

    async planDraftInput(workspaceId: string, planId: string) {
      const read = await inWorkspace(workspaceId, async (tx) => {
        const row = await readPlan(tx, planId);
        const strategy = await readStrategy(tx);
        const pinned = strategy?.currentVersion == null ? undefined : await readStrategyVersion(tx, strategy.id, strategy.currentVersion);
        return { row, pinned };
      });
      if (!read.row) return { ok: false, reason: "not_found" } as const;
      if (read.row.archivedAt) return { ok: false, reason: "archived" } as const;
      if (!read.row.request) return { ok: false, reason: "no_request" } as const;
      if (!read.pinned) return { ok: false, reason: "no_strategy" } as const;
      const strategy = { kind: "strategy", refId: read.pinned.strategyId, version: String(read.pinned.version), text: `The Strategy, version ${read.pinned.version}:\n${JSON.stringify(read.pinned.body)}` };
      const input: DraftInput = { request: read.row.request, brief: [...(await brief(workspaceId)), strategy], target: { id: planId, draftRevision: read.row.draftRevision } };
      return { ok: true, input, title: read.row.title } as const;
    },
  };
}

// `draftingPlanId` is the plan this draft is for, null for the Strategy: a plan can't rest on its own readings.
async function honest(workspaceId: string, facts: FactReads, basis: Basis, draftingPlanId: string | null): Promise<Basis> {
  if (basis.kind === "reading") {
    const r = await inWorkspace(workspaceId, (tx) => readingStanding(tx, basis.readingId));
    return readingStands(r, draftingPlanId) ? basis : { kind: "assumption" };
  }
  if (basis.kind !== "fact") return basis;
  return (await facts.checkCitation(workspaceId, basis.factId, basis.version)) === "ok" ? basis : { kind: "assumption" };
}

/** The sinks agents hand these proposals to. Safe to call twice: a run that already wrote the draft is done. */
export function planSinks({ facts, now }: { facts: FactReads; now?: () => Date }): { strategy_proposal: Sink; plan_proposal: Sink } {
  const clock = now ?? (() => new Date());
  return {
    async strategy_proposal(workspaceId, proposal, context) {
      const body = proposal.body as StrategyBody;
      const channels = await Promise.all(body.channels.map(async (c) => ({ ...c, basis: await honest(workspaceId, facts, c.basis, null) })));
      const { target } = context.input as DraftInput;
      return inWorkspace(workspaceId, async (tx) => {
        const row = await ensureStrategy(tx, workspaceId, clock());
        if (row.draftRunId === context.runId) return { ok: true, itemId: null };
        if (row.draftRevision !== target.draftRevision) return { ok: false, code: "target_changed" };
        await fillStrategyDraft(tx, row.id, { ...body, channels }, row.draftRevision + 1, context.runId, clock());
        return { ok: true, itemId: null };
      });
    },

    async plan_proposal(workspaceId, proposal, context) {
      const body = proposal.body as PlanBody;
      const { target } = context.input as DraftInput;
      const measures = await Promise.all(body.measures.map(async (m) => ({ ...m, basis: await honest(workspaceId, facts, m.basis, target.id) })));
      return inWorkspace(workspaceId, async (tx) => {
        const row = await lockPlan(tx, target.id!);
        if (!row) return { ok: false, code: "not_found" };
        if (row.archivedAt) return { ok: false, code: "archived" };
        if (row.draftRunId === context.runId) return { ok: true, itemId: null };
        if (row.draftRevision !== target.draftRevision) return { ok: false, code: "target_changed" };
        await fillPlanDraft(tx, row.id, { ...body, measures }, row.draftRevision + 1, context.runId, clock());
        return { ok: true, itemId: null };
      });
    },
  };
}
