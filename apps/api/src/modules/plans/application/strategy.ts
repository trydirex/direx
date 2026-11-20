// SPDX-License-Identifier: AGPL-3.0-only
// One Strategy per Workspace. A person edits the draft and submits it as a version; only approving
// that version makes it current.
import type { Facts } from "../../facts";
import type { Items } from "../../items";
import { ensureStrategy, inWorkspace, insertStrategyVersion, latestStrategyVersion, lockStrategy, readStrategy, readStrategyVersion, setStrategyDraft, strategyVersionsOf } from "../adapters/repo";
import { draftReadings, strategyReadings, strategyText } from "../domain/labels";
import type { StrategyBody } from "../domain/types";
import { strategyBody, whatsMissing } from "./body";
import { citedReadings, readingNotes } from "./plans";
import { digestOf, itemForVersion, STRATEGY_KIND, waitingItem, type Person } from "./submit";

export function strategyStore({ items, facts, now }: { items: () => Items; facts: Facts; now: () => Date }) {
  return {
    async strategy(workspaceId: string) {
      const read = await inWorkspace(workspaceId, async (tx) => {
        const row = await readStrategy(tx);
        if (!row) return { id: null, currentVersion: null, current: null, draft: null, draftRevision: 0, missing: whatsMissing(strategyBody, null), notes: [], citedReadings: [] };
        const current = row.currentVersion === null ? undefined : await readStrategyVersion(tx, row.id, row.currentVersion);
        const body = (current?.body as StrategyBody | undefined) ?? null;
        // Nothing else moves under a Strategy, so a replaced reading is its only note.
        const cites = body ? strategyReadings(body) : [];
        const cited = await citedReadings(tx, [...cites, ...draftReadings((row.draft as { channels?: unknown } | null)?.channels)]);
        return { id: row.id, currentVersion: row.currentVersion, current: body, draft: row.draft, draftRevision: row.draftRevision, missing: whatsMissing(strategyBody, row.draft), notes: readingNotes(cites, cited), citedReadings: cited };
      });
      return { ...read, waiting: read.id ? await waitingItem(items(), workspaceId, STRATEGY_KIND, read.id) : null };
    },

    strategyVersions: (workspaceId: string) =>
      inWorkspace(workspaceId, async (tx) => {
        const row = await readStrategy(tx);
        return row ? strategyVersionsOf(tx, row.id) : [];
      }),

    /** A draft can be partial. `revision` is the one the person was editing. */
    saveStrategyDraft: (workspaceId: string, a: { revision: number; body: unknown }) =>
      inWorkspace(workspaceId, async (tx) => {
        const row = await ensureStrategy(tx, workspaceId, now());
        if (row.draftRevision !== a.revision) return { ok: false, reason: "stale_revision" } as const;
        const revision = row.draftRevision + 1;
        await setStrategyDraft(tx, row.id, a.body, revision, now());
        return { ok: true, revision, missing: whatsMissing(strategyBody, a.body) } as const;
      }),

    async submitStrategy(workspaceId: string, a: { revision: number; actor: Person }) {
      const written = await inWorkspace(workspaceId, async (tx) => {
        const row = await lockStrategy(tx);
        if (!row) return { ok: false, reason: "not_found" } as const;
        if (row.draftRevision !== a.revision) return { ok: false, reason: "stale_revision" } as const;
        const parsed = strategyBody.safeParse(row.draft);
        if (!parsed.success) return { ok: false, reason: "incomplete", missing: whatsMissing(strategyBody, row.draft) } as const;
        const digest = digestOf(parsed.data);
        const latest = await latestStrategyVersion(tx, row.id);
        if (latest?.digest === digest && latest.version === row.currentVersion) return { ok: false, reason: "no_change" } as const;
        // The same words already waiting keep their version, and itemForVersion keeps their Item.
        if (latest?.digest === digest) return { ok: true, id: row.id, version: latest.version, body: parsed.data } as const;
        const version = (latest?.version ?? 0) + 1;
        await insertStrategyVersion(tx, { workspaceId, strategyId: row.id, version, body: parsed.data, digest, baseVersion: row.currentVersion, actorUserId: a.actor.userId, at: now() });
        return { ok: true, id: row.id, version, body: parsed.data } as const;
      });
      if (!written.ok) return written;
      const banned = await facts.bannedClaimsIn(workspaceId, strategyText(written.body));
      const item = await itemForVersion(items(), workspaceId, {
        kind: STRATEGY_KIND,
        targetId: written.id,
        version: written.version,
        title: `Strategy, version ${written.version}`,
        warnings: banned.map((p) => `Uses a banned claim: "${p}"`),
        actor: a.actor,
      });
      return { ok: true, version: written.version, item } as const;
    },
  };
}
