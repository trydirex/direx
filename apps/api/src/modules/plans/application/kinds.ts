// SPDX-License-Identifier: AGPL-3.0-only
// Approving makes one exact version current, in the Item's transaction. It writes rows and nothing
// else: no Action, no reservation, no model or network call.
import { citationOf } from "../../facts";
import type { ItemKind } from "../../items";
import { lockPlan, lockStrategy, readPlanVersion, readStrategyVersion, setPlanCurrent, setStrategyCurrent, type PlansTx } from "../adapters/repo";
import { applyVersion, planCitations, strategyCitations, type Citation } from "../domain/labels";
import type { PlanBody, StrategyBody } from "../domain/types";
import { PLAN_KIND, STRATEGY_KIND, type VersionPayload } from "./submit";

const NOT_FOUND = { ok: false, reason: "not_found" } as const;
const OK = { ok: true } as const;

/**
 * Runs in the approval's transaction, so it must only write rows. Throwing undoes the approval.
 * `previousVersion` is the version this one replaced; `readVersion` reads any version's body in the same transaction.
 */
export type OnPlanApproved = (
  tx: PlansTx,
  p: { workspaceId: string; planId: string; version: number; previousVersion: number | null; ownerUserId: string; approvedBy: string; readVersion: (version: number) => Promise<PlanBody | null> },
) => Promise<void>;

async function refusedCitation(tx: PlansTx, cited: Citation[]) {
  for (const c of cited) {
    if ((await citationOf(tx, c.factId, c.version)) !== "ok") return { ok: false, reason: `citation_not_ok:${c.factId}` } as const;
  }
  return null;
}

/** The Item kinds this module applies. Registered when items is built, so items never imports plans. */
export function planKinds(deps: { now?: () => Date; onPlanApproved?: OnPlanApproved } = {}): Record<string, ItemKind> {
  const now = deps.now ?? (() => new Date());
  return {
    [STRATEGY_KIND]: {
      permission: "item.approve",
      async apply(tx: PlansTx, item) {
        const p = item.payload as VersionPayload;
        const head = await lockStrategy(tx);
        const version = head && (await readStrategyVersion(tx, head.id, p.version));
        if (!head || !version) return NOT_FOUND;
        const fits = applyVersion(version, head.currentVersion);
        if (!fits.ok) return fits;
        const refused = await refusedCitation(tx, strategyCitations(version.body as StrategyBody));
        if (refused) return refused;
        await setStrategyCurrent(tx, head.id, p.version, now());
        return OK;
      },
    },
    [PLAN_KIND]: {
      permission: "item.approve",
      async apply(tx: PlansTx, item, actor) {
        const p = item.payload as VersionPayload;
        const head = await lockPlan(tx, p.targetId);
        const version = head && (await readPlanVersion(tx, head.id, p.version));
        if (!head || !version) return NOT_FOUND;
        if (head.archivedAt) return { ok: false, reason: "archived" };
        const fits = applyVersion(version, head.currentVersion);
        if (!fits.ok) return fits;
        const refused = await refusedCitation(tx, planCitations(version.body as PlanBody));
        if (refused) return refused;
        await setPlanCurrent(tx, head.id, p.version, now());
        await deps.onPlanApproved?.(tx, {
          workspaceId: head.workspaceId,
          planId: head.id,
          version: p.version,
          previousVersion: head.currentVersion,
          ownerUserId: version.actorUserId,
          approvedBy: "userId" in actor ? actor.userId : version.actorUserId,
          readVersion: async (v) => ((await readPlanVersion(tx, head.id, v))?.body as PlanBody | undefined) ?? null,
        });
        return OK;
      },
    },
  };
}
