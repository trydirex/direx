// SPDX-License-Identifier: AGPL-3.0-only
// Done and achieved are recorded, append-only, against what the current version plans. Later
// modules can write here too, as a system actor, so a reading always says where it came from.
import type { Actor } from "../../ledger";
import { inWorkspace, insertProgress, insertReading, readPlan, readPlanVersion, type PlansTx, type Writer } from "../adapters/repo";
import type { StepStatus } from "../domain/tracking";
import type { PlanBody } from "../domain/types";

function writerOf(actor: Actor): Writer | null {
  if ("userId" in actor) return { actorUserId: actor.userId, actorSystem: null };
  return "system" in actor ? { actorUserId: null, actorSystem: actor.system } : null;
}

async function currentBody(tx: PlansTx, planId: string): Promise<PlanBody | "not_found" | "not_approved"> {
  const row = await readPlan(tx, planId);
  if (!row) return "not_found";
  const v = row.currentVersion === null ? undefined : await readPlanVersion(tx, planId, row.currentVersion);
  return v ? (v.body as PlanBody) : "not_approved";
}

export function planTracking({ now }: { now: () => Date }) {
  return {
    markStep: (workspaceId: string, planId: string, a: { stepKey: string; status: StepStatus; actor: Actor }) =>
      inWorkspace(workspaceId, async (tx) => {
        const by = writerOf(a.actor);
        if (!by) return { ok: false, reason: "wrong_actor" } as const;
        const body = await currentBody(tx, planId);
        if (typeof body === "string") return { ok: false, reason: body } as const;
        if (!body.steps.some((s) => s.key === a.stepKey)) return { ok: false, reason: "unknown_step" } as const;
        await insertProgress(tx, workspaceId, planId, a.stepKey, a.status, by, now());
        return { ok: true } as const;
      }),

    recordReading: (workspaceId: string, planId: string, a: { measureKey: string; value: string; observedOn: string; note?: string | undefined; actor: Actor }) =>
      inWorkspace(workspaceId, async (tx) => {
        const by = writerOf(a.actor);
        if (!by) return { ok: false, reason: "wrong_actor" } as const;
        const value = a.value.trim();
        if (!value) return { ok: false, reason: "blank_value" } as const;
        const body = await currentBody(tx, planId);
        if (typeof body === "string") return { ok: false, reason: body } as const;
        if (!body.measures.some((m) => m.key === a.measureKey)) return { ok: false, reason: "unknown_measure" } as const;
        await insertReading(tx, workspaceId, planId, { measureKey: a.measureKey, value, observedOn: a.observedOn, note: a.note ?? null }, by, now());
        return { ok: true } as const;
      }),
  };
}
