// SPDX-License-Identifier: AGPL-3.0-only
// The module's parts put together, apart from index.ts so routes can name the type.
import type { KeptEligibility } from "./people";
import { planChanges } from "./plan-change";
import type { Facts } from "../../facts";
import type { Items } from "../../items";
import type { Outreach, OutsideTouches } from "../../outreach";
import type { Plans } from "../../plans";
import { campaignAnchor } from "./anchor";
import { briefSteps, type BriefPort } from "./brief-steps";
import { campaignStore, type PostPort } from "./campaigns";
import { clipSteps, type ClipPort } from "./clip-steps";
import { campaignCoordination } from "./coordination";
import { campaignDrafting, type OnOutsideContentChanged, type OnSetupChanged, type OnTemplateSaved, type StartDraft } from "./drafting";
import { dmSteps } from "./dms";
import { importDrafting } from "./import-drafting";
import { makeDrafting } from "./make-drafts";
import { campaignPeople } from "./people";
import { personDrafting, type AddressLabelsFor, type RunCaps, type SignalsFor } from "./person-drafts";
import { campaignReadings } from "./readings";
import { stepOutputs } from "./step-links";
import { campaignWriteUps } from "./write-up";

export function createCampaigns(deps: { plans: Plans; facts: Facts; items: () => Items; outreach: () => Outreach; startDraft: () => StartDraft; posts?: () => PostPort; clips?: () => ClipPort | undefined; briefs?: () => BriefPort | undefined; now?: () => Date; signalsFor?: SignalsFor; addressLabelsFor?: AddressLabelsFor; keptEligibility?: KeptEligibility; onOutsideContentChanged?: OnOutsideContentChanged; outsideTouches?: () => Pick<OutsideTouches, "log">; onTemplateSaved?: OnTemplateSaved; onSetupChanged?: OnSetupChanged; runCaps?: RunCaps }) {
  const now = deps.now ?? (() => new Date());
  const outsideTouches =
    deps.outsideTouches ??
    (() => {
      throw new Error("marking a DM sent needs outside touches, which the composition root passes in");
    });
  const briefs = briefSteps({ plans: deps.plans, briefs: deps.briefs, now });
  const make = makeDrafting({ plans: deps.plans, facts: deps.facts, items: deps.items, outreach: deps.outreach, now, onTemplateSaved: deps.onTemplateSaved });
  const drafting = campaignDrafting({ plans: deps.plans, facts: deps.facts, startDraft: deps.startDraft, now, onOutsideContentChanged: deps.onOutsideContentChanged, onSetupChanged: deps.onSetupChanged, posts: deps.posts });
  const person = personDrafting({ plans: deps.plans, facts: deps.facts, items: deps.items, outreach: deps.outreach, startDraft: deps.startDraft, now, signalsFor: deps.signalsFor ?? (async () => []), addressLabelsFor: deps.addressLabelsFor ?? (async () => ({ roleAddress: false, guessedAddress: false })), runCaps: deps.runCaps, redraftPost: drafting.redraftPost });
  const timing = importDrafting({ plans: deps.plans, make, person, items: deps.items, now });
  const anchor = campaignAnchor({ plans: deps.plans, items: deps.items, now });
  // Each of these can change what a Campaign's drafting waits on, so its waiting-on Item is refreshed
  // after it. Only suggests, so a failed refresh is logged and never undoes the change.
  const refreshed =
    <A extends unknown[], R extends { ok: boolean }>(f: (workspaceId: string, campaignId: string, ...rest: A) => Promise<R>) =>
    async (workspaceId: string, campaignId: string, ...rest: A): Promise<R> => {
      const r = await f(workspaceId, campaignId, ...rest);
      if (r.ok) await timing.refreshWaiting(workspaceId, campaignId).catch((e) => console.error("campaigns: waiting-on refresh failed", campaignId, e));
      return r;
    };
  // A plan change that uses the plan's new text saves it the way a person would, refresh included.
  const changes = planChanges({ plans: deps.plans, facts: deps.facts, items: deps.items, saveTemplate: refreshed(make.saveTemplate), now });
  const api = {
    ...dmSteps({ facts: deps.facts, outreach: deps.outreach, outsideTouches, now }),
    ...campaignStore({ plans: deps.plans, facts: deps.facts, items: deps.items, outreach: deps.outreach, posts: deps.posts, now, onSetupChanged: deps.onSetupChanged }),
    ...clipSteps({ plans: deps.plans, facts: deps.facts, items: deps.items, posts: deps.posts, clips: deps.clips, now }),
    ...campaignPeople({ outreach: deps.outreach, items: deps.items, now, keptEligibility: deps.keptEligibility }),
    ...drafting,
    ...make,
    ...campaignCoordination({ plans: deps.plans, items: deps.items, now }),
    ...briefs,
    ...stepOutputs({ plans: deps.plans, now, briefApproved: briefs.briefApproved }),
    ...person,
    ...timing,
    ...anchor,
    ...changes,
    ...campaignReadings({ plans: deps.plans, now }),
  };
  const writeUps = campaignWriteUps({ plans: deps.plans, overlaps: api.overlaps, startDraft: deps.startDraft, now });
  return {
    ...api,
    ...writeUps,
    // The 06:00 pass: readings first, then the write-ups that are due once they're in.
    countReadings: async () => {
      await api.countReadings();
      await writeUps.writeUpsDue();
    },
    addPeople: refreshed(api.addPeople),
    addPeopleRows: refreshed(api.addPeopleRows),
    setupStep: refreshed(api.setupStep),
    setDraftingMode: refreshed(api.setDraftingMode),
    setStepDraftingMode: refreshed(api.setStepDraftingMode),
    saveTemplate: refreshed(api.saveTemplate),
    // An output can be the launch the Campaign follows, and arriving late moves everything with it.
    recordOutput: refreshed(async (workspaceId: string, campaignId: string, stepKey: string, url: string, actor: { userId: string }) => {
      const r = await api.recordOutput(workspaceId, campaignId, stepKey, url, actor);
      if (r.ok) await anchor.followAnchorOutput(workspaceId, campaignId, actor).catch((e) => console.error("campaigns: following the launch failed", campaignId, e));
      return r;
    }),
    confirmDrafting: refreshed(api.confirmDrafting),
  };
}
export type Campaigns = ReturnType<typeof createCampaigns>;
