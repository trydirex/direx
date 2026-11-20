// SPDX-License-Identifier: AGPL-3.0-only
// The module's parts put together, apart from index.ts so routes can name the type.
import type { Facts } from "../../facts";
import type { Items } from "../../items";
import { drafting, type CampaignResults } from "./drafting";
import { ideaStore } from "./ideas";
import { planStore, type OnPlanCreated } from "./plans";
import { strategyStore } from "./strategy";
import { planTracking } from "./tracking";

export function createPlans(deps: { items: () => Items; facts: Facts; onPlanCreated: OnPlanCreated; campaignResults?: CampaignResults; now?: () => Date }) {
  const now = deps.now ?? (() => new Date());
  const parts = { items: deps.items, facts: deps.facts, now };
  // Without campaigns wired in, as in a test that drafts no Campaign, no plan has overlaps.
  const campaignResults = deps.campaignResults ?? (async () => new Map());
  return { ...strategyStore(parts), ...planStore({ ...parts, onPlanCreated: deps.onPlanCreated }), ...planTracking({ now }), ...drafting({ facts: deps.facts, now, campaignResults }), ...ideaStore({ now }) };
}
export type Plans = ReturnType<typeof createPlans>;
