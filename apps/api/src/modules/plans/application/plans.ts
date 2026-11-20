// SPDX-License-Identifier: AGPL-3.0-only
// One marketing plan per campaign. Each version pins the Strategy version it was built on, and a
// plan can't be submitted until the Workspace has an approved Strategy.
import { z } from "zod";
import type { Facts } from "../../facts";
import type { Items } from "../../items";
import {
  archivePlanRow,
  citedReadingRows,
  inWorkspace,
  insertPlan,
  insertPlanVersion,
  latestPlanVersion,
  listPlans,
  lockPlan,
  planVersionsOf,
  progressOf,
  readingsOf,
  readPlan,
  readPlanVersion,
  readStrategy,
  readStrategyVersion,
  setPlanDraft,
  type PlansTx,
} from "../adapters/repo";
import { draftReadings, planCitations, planReadings, planText, stepsOffStrategy } from "../domain/labels";
import { listFields, tracking } from "../domain/tracking";
import type { PlanBody, StrategyBody } from "../domain/types";
import { planBody, whatsMissing } from "./body";
import { digestOf, itemForVersion, PLAN_KIND, waitingItem, type Person } from "./submit";

/**
 * Runs in the new plan's transaction, so the plan and its Campaign are made together or not at all (ADR
 * 0023). Required: plans never imports campaigns, so the composition root hands it in.
 */
export type OnPlanCreated = (tx: PlansTx, p: { workspaceId: string; planId: string; createdBy: string; at: Date }) => Promise<void>;

/**
 * What each cited reading says, so a person reads words instead of an id. An id this Workspace doesn't
 * have, which a body typed by hand can name, comes back not found. The label is the Measure's in the
 * reading's plan as approved now, or its key when that version no longer has it.
 */
export async function citedReadings(tx: PlansTx, ids: string[]) {
  const unique = [...new Set(ids)];
  const rows = await citedReadingRows(tx, unique.filter((id) => z.uuid().safeParse(id).success));
  const byId = new Map(rows.map((r) => [r.id, r]));
  const out = [];
  for (const id of unique) {
    const r = byId.get(id.toLowerCase());
    if (!r) {
      out.push({ id, found: false, measureLabel: null, value: null, source: null, observedOn: null, newer: false });
      continue;
    }
    const measureLabel = (r.body as PlanBody | null)?.measures.find((m) => m.key === r.measureKey)?.label ?? r.measureKey;
    out.push({ id, found: true, measureLabel, value: r.value, source: r.source, observedOn: r.observedOn, newer: !r.isNewest });
  }
  return out;
}
export type CitedReading = Awaited<ReturnType<typeof citedReadings>>[number];

/** A note for each reading the version cites that a newer one for its Measure has replaced. */
export const readingNotes = (ids: string[], cited: CitedReading[]) =>
  cited.filter((c) => c.newer && ids.includes(c.id)).map((c) => ({ kind: "reading_changed" as const, readingId: c.id }));

export function planStore({ items, facts, now, onPlanCreated }: { items: () => Items; facts: Facts; now: () => Date; onPlanCreated: OnPlanCreated }) {
  /** What has moved under a plan since it was approved. Notes only: a plan has no effect to hold. */
  async function notesFor(workspaceId: string, body: PlanBody, pinned: number, strategyCurrent: number | null, cited: CitedReading[]) {
    const notes: { kind: "strategy_changed" | "fact_changed" | "reading_changed"; factId?: string; readingId?: string }[] = [];
    if (strategyCurrent !== pinned) notes.push({ kind: "strategy_changed" });
    for (const c of planCitations(body)) {
      if ((await facts.checkCitation(workspaceId, c.factId, c.version)) !== "ok") notes.push({ kind: "fact_changed", factId: c.factId });
    }
    return [...notes, ...readingNotes(planReadings(body), cited)];
  }

  return {
    /** A plan and its Campaign, in one transaction. The person who starts it owns the Campaign. */
    createPlan: (workspaceId: string, a: { title: string; request?: string | undefined; createdBy: string }) =>
      inWorkspace(workspaceId, async (tx) => {
        const at = now();
        const row = await insertPlan(tx, workspaceId, { title: a.title, request: a.request ?? null, createdBy: a.createdBy }, at);
        await onPlanCreated(tx, { workspaceId, planId: row.id, createdBy: a.createdBy, at });
        return row;
      }),

    /** Plans not archived, each with what its row shows: dates, main measure and channels, from its approved version. */
    plans: (workspaceId: string) =>
      inWorkspace(workspaceId, async (tx) => {
        const rows = await listPlans(tx);
        const readings = await readingsOf(tx);
        const strategy = await readStrategy(tx);
        const sv = strategy?.currentVersion == null ? undefined : await readStrategyVersion(tx, strategy.id, strategy.currentVersion);
        const channels = (sv?.body as StrategyBody | undefined)?.channels ?? [];
        return rows.map((r) => ({ ...r, ...listFields(r.currentBody as PlanBody | null, readings.filter((x) => x.planId === r.id), channels) }));
      }),

    planVersions: (workspaceId: string, id: string) => inWorkspace(workspaceId, (tx) => planVersionsOf(tx, id)),

    /** One plan: its draft, its current version, how that's going and what has moved under it. */
    async plan(workspaceId: string, id: string) {
      const read = await inWorkspace(workspaceId, async (tx) => {
        const row = await readPlan(tx, id);
        if (!row) return undefined;
        const current = row.currentVersion === null ? undefined : await readPlanVersion(tx, id, row.currentVersion);
        const strategy = await readStrategy(tx);
        const cited = await citedReadings(tx, [...(current ? planReadings(current.body as PlanBody) : []), ...draftReadings((row.draft as { measures?: unknown } | null)?.measures)]);
        return { row, current, strategyCurrent: strategy?.currentVersion ?? null, progress: await progressOf(tx, id), readings: await readingsOf(tx, id), cited };
      });
      if (!read) return undefined;
      const body = read.current?.body as PlanBody | undefined;
      return {
        ...read.row,
        missing: whatsMissing(planBody, read.row.draft),
        waiting: await waitingItem(items(), workspaceId, PLAN_KIND, id),
        current: body ?? null,
        strategyVersion: read.current?.strategyVersion ?? null,
        tracking: body ? tracking(body, read.progress, read.readings) : null,
        notes: body ? await notesFor(workspaceId, body, read.current!.strategyVersion, read.strategyCurrent, read.cited) : [],
        citedReadings: read.cited,
      };
    },

    savePlanDraft: (workspaceId: string, id: string, a: { revision: number; body: unknown }) =>
      inWorkspace(workspaceId, async (tx) => {
        const row = await lockPlan(tx, id);
        if (!row) return { ok: false, reason: "not_found" } as const;
        if (row.archivedAt) return { ok: false, reason: "archived" } as const;
        if (row.draftRevision !== a.revision) return { ok: false, reason: "stale_revision" } as const;
        const revision = row.draftRevision + 1;
        await setPlanDraft(tx, id, a.body, revision, now());
        return { ok: true, revision, missing: whatsMissing(planBody, a.body) } as const;
      }),

    async submitPlan(workspaceId: string, id: string, a: { revision: number; actor: Person }) {
      const written = await inWorkspace(workspaceId, async (tx) => {
        const row = await lockPlan(tx, id);
        if (!row) return { ok: false, reason: "not_found" } as const;
        if (row.archivedAt) return { ok: false, reason: "archived" } as const;
        if (row.draftRevision !== a.revision) return { ok: false, reason: "stale_revision" } as const;
        const strategy = await readStrategy(tx);
        if (strategy?.currentVersion == null) return { ok: false, reason: "no_strategy" } as const;
        const parsed = planBody.safeParse(row.draft);
        if (!parsed.success) return { ok: false, reason: "incomplete", missing: whatsMissing(planBody, row.draft) } as const;
        const pinned = (await readStrategyVersion(tx, strategy.id, strategy.currentVersion))!;
        const base = { id, title: row.title, body: parsed.data, strategy: pinned.body as StrategyBody };
        const digest = digestOf(parsed.data);
        const latest = await latestPlanVersion(tx, id);
        if (latest?.digest === digest && latest.version === row.currentVersion) return { ok: false, reason: "no_change" } as const;
        // The same words already waiting keep their version, and itemForVersion keeps their Item.
        if (latest?.digest === digest) return { ok: true, ...base, version: latest.version } as const;
        const version = (latest?.version ?? 0) + 1;
        await insertPlanVersion(tx, { workspaceId, planId: id, version, body: parsed.data, digest, baseVersion: row.currentVersion, strategyId: strategy.id, strategyVersion: strategy.currentVersion, actorUserId: a.actor.userId, at: now() });
        return { ok: true, ...base, version } as const;
      });
      if (!written.ok) return written;
      const banned = await facts.bannedClaimsIn(workspaceId, planText(written.body));
      const off = stepsOffStrategy(written.body, written.strategy);
      const item = await itemForVersion(items(), workspaceId, {
        kind: PLAN_KIND,
        targetId: id,
        version: written.version,
        title: `Plan "${written.title}", version ${written.version}`,
        warnings: [...banned.map((p) => `Uses a banned claim: "${p}"`), ...(off.length ? [`${off.length} step(s) on a channel the Strategy doesn't have`] : [])],
        actor: a.actor,
      });
      return { ok: true, version: written.version, item } as const;
    },

    archivePlan: (workspaceId: string, id: string) =>
      inWorkspace(workspaceId, async (tx) => {
        const row = await lockPlan(tx, id);
        if (!row) return { ok: false, reason: "not_found" } as const;
        if (!row.archivedAt) await archivePlanRow(tx, id, now());
        return { ok: true } as const;
      }),
  };
}
