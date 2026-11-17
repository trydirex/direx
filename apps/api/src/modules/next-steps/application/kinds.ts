// SPDX-License-Identifier: AGPL-3.0-only
// Accepting a Next step. It runs in the approval's transaction, so it only checks that what the card
// was made for still holds and queues the start; the work itself begins after the commit.
import type { PgBoss } from "pg-boss";
import type { Campaigns } from "../../campaigns";
import type { ItemKind } from "../../items";
import type { Plans } from "../../plans";
import { sendStart } from "../adapters/queue";
import { isTimeZone, NEXT_STEP_KIND, needsTimeZone, type NextStep } from "../domain/chain";
import { NextStepPayload } from "./payload";

export type KindDeps = { boss: PgBoss; campaigns: () => Pick<Campaigns, "list" | "campaign">; plans: Pick<Plans, "plan">; now: () => Date };

export function nextStepKinds(d: KindDeps): Record<string, ItemKind> {
  async function stillCurrent(workspaceId: string, s: NextStep): Promise<boolean> {
    if (s.link === "plan_to_templates") {
      // An archived plan's Campaign leaves the list.
      const listed = (await d.campaigns().list(workspaceId)).some((c) => c.id === s.campaignId && c.planId === s.planId);
      return listed && (await d.plans.plan(workspaceId, s.planId))?.currentVersion === s.planVersion;
    }
    const step = (await d.campaigns().campaign(workspaceId, s.campaignId))?.steps.find((x) => x.key === s.stepKey);
    if (s.link === "due_to_drafts") return step?.type === "email" && step.draftingMode === "per_person";
    return step?.templateRevision === s.templateRevision;
  }

  return {
    [NEXT_STEP_KIND]: {
      permission: "item.approve",
      async apply(tx, item, actor, choice) {
        const parsed = NextStepPayload.safeParse(item.payload);
        if (!parsed.success) return { ok: false, reason: "bad_payload" };
        const s = parsed.data;
        if (!("userId" in actor)) return { ok: false, reason: "person_required" };
        if (needsTimeZone(s) && (choice === undefined || !isTimeZone(choice))) return { ok: false, reason: "bad_time_zone" };
        if (!needsTimeZone(s) && choice !== undefined) return { ok: false, reason: "choice_not_allowed" };
        if (!(await stillCurrent(item.workspaceId, s))) return { ok: false, reason: "moved_on" };
        await sendStart(d.boss, tx, { workspaceId: item.workspaceId, itemId: item.id, userId: actor.userId, timeZone: choice ?? null }, d.now());
        return { ok: true };
      },
    },
  };
}
