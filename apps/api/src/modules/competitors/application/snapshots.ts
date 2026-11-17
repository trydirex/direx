// SPDX-License-Identifier: AGPL-3.0-only
// The weekly read: each competitor page once a week, its kept parts (or why the read failed) stored as
// a snapshot, and what changed since the last good read of the same URL stored as Changes citing both.
// No model sees any of it here.
import { weekOf } from "../../seo/index";
import { changesSince, competitorWorkspaces, hasSnapshot, inWorkspace, insertChanges, insertSnapshot, lastGood, lastReads, listRows, type CompetitorRow, type NewChange } from "../adapters/repo";
import { SOURCES, type Source } from "../domain/competitor";
import { changelogChange, LANDING_MEMORY, landingChanges, pricingChange, type ChangeDetail } from "../domain/diff";
import type { LandingParts } from "../domain/parts";
import type { ReadPage } from "./competitors";
import { partsOf } from "./parts";

const DAY_MS = 86_400_000;
/** How far back the Brand page lists Changes. */
export const CHANGES_SHOWN_DAYS = 28;

export type ReadOutcome = "already_read" | "failed" | "baseline" | "unchanged" | "changed" | "no_url";

function changesOf(source: Source, history: { parts: unknown }[], parts: unknown): ChangeDetail[] {
  const last = history[0];
  if (!last) return [];
  if (source === "landing") return landingChanges(history.map((h) => h.parts as LandingParts), parts as LandingParts);
  const lines = (p: unknown) => (p as { lines: string[] }).lines;
  const one = source === "changelog" ? changelogChange(lines(last.parts), lines(parts)) : pricingChange(lines(last.parts), lines(parts));
  return one ? [one] : [];
}

/** `afterRead` runs once a Workspace's pages are read: the classifier's start. */
export function createSnapshots(deps: { readPage: ReadPage; now?: () => Date; afterRead?: (workspaceId: string) => Promise<unknown> }) {
  const now = deps.now ?? (() => new Date());

  async function readOne(workspaceId: string, competitor: CompetitorRow, source: Source): Promise<ReadOutcome> {
    const url = competitor[`${source}Url`];
    if (!url) return "no_url";
    const week = weekOf(now());
    if (await inWorkspace(workspaceId, (tx) => hasSnapshot(tx, competitor.id, source, week))) return "already_read";
    // The read is outside the transaction: it can take as long as the page reader's time limit.
    const read = await deps.readPage(url);
    const at = now();
    return inWorkspace(workspaceId, async (tx) => {
      const base = { workspaceId, competitorId: competitor.id, source, url, week, readAt: at };
      if (!read.ok) {
        const saved = await insertSnapshot(tx, { ...base, failure: read.detail ? `${read.reason}: ${read.detail}` : read.reason, parts: null });
        return saved ? "failed" : "already_read";
      }
      const parts = partsOf(source, read);
      const history = await lastGood(tx, competitor.id, source, url, LANDING_MEMORY);
      const saved = await insertSnapshot(tx, { ...base, finalUrl: read.finalUrl, truncated: read.truncated, failure: null, parts });
      if (!saved) return "already_read";
      if (history.length === 0) return "baseline";
      const rows: NewChange[] = changesOf(source, history, parts).map((detail) => ({
        workspaceId,
        competitorId: competitor.id,
        source,
        beforeSnapshotId: history[0]!.id,
        afterSnapshotId: saved.id,
        detail,
        createdAt: at,
      }));
      await insertChanges(tx, rows);
      return rows.length > 0 ? "changed" : "unchanged";
    });
  }

  /** Every page of every competitor in one Workspace, one at a time, so a site sees one read at once. */
  async function readWorkspace(workspaceId: string) {
    for (const competitor of await inWorkspace(workspaceId, listRows)) {
      for (const source of SOURCES) await readOne(workspaceId, competitor, source);
    }
  }

  return {
    readOne,
    readWorkspace,
    /** The weekly job: every Workspace with competitors, a failure in one not stopping the rest. */
    async weekly() {
      for (const workspaceId of await competitorWorkspaces()) {
        try {
          await readWorkspace(workspaceId);
          await deps.afterRead?.(workspaceId);
        } catch (e) {
          console.error(`competitor read: workspace ${workspaceId}:`, e);
        }
      }
    },
    lastReads: (workspaceId: string) => inWorkspace(workspaceId, lastReads),
    recentChanges: (workspaceId: string, competitorId: string) => inWorkspace(workspaceId, (tx) => changesSince(tx, competitorId, new Date(now().getTime() - CHANGES_SHOWN_DAYS * DAY_MS))),
  };
}
export type Snapshots = ReturnType<typeof createSnapshots>;
