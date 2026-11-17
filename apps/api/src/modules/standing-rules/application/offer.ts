// SPDX-License-Identifier: AGPL-3.0-only
// After enough unedited approvals in one scope, one suggestion. Its only action opens the grant form,
// because granting needs step-up, which approving an Item doesn't have.
import type { Items, ItemKind } from "../../items";
import { actionItemByItem, activeRulesForStep, inWorkspace, offerFor } from "../adapters/repo";
import type { CampaignPort } from "./port";

export const OFFER_KIND = "standing_rule_offer";
export const OFFER_AT = 20;

export const standingRuleKinds = (): Record<string, ItemKind> => ({
  [OFFER_KIND]: { permission: "rule.grant", apply: async () => ({ ok: false, reason: "grant_form_required" }) },
});

export function offers(d: { port: CampaignPort; items: () => Items; basisFor: (tx: Parameters<CampaignPort["linkOf"]>[0], campaignId: string, stepKey: string) => Promise<{ ok: boolean; approved?: number; revision?: number }> }) {
  return async function onApproved(workspaceId: string, itemId: string): Promise<void> {
    const payload = await inWorkspace(workspaceId, async (tx) => {
      const row = await actionItemByItem(tx, itemId);
      const link = row && (await d.port.linkOf(tx, row.actionId));
      if (!link) return null;
      const basis = await d.basisFor(tx, link.campaignId, link.stepKey);
      if (!basis.ok || basis.approved! < OFFER_AT) return null;
      if ((await activeRulesForStep(tx, link.campaignId, link.stepKey)).length) return null;
      if (await offerFor(tx, OFFER_KIND, link.campaignId, link.stepKey, basis.revision!)) return null;
      return { campaignId: link.campaignId, stepKey: link.stepKey, templateRevision: basis.revision! };
    });
    if (!payload) return;
    // ponytail: two approvals finishing at once can make two offers; a unique index on the payload if that shows up.
    await d.items().createItem(workspaceId, {
      kind: OFFER_KIND,
      payload,
      actor: { system: "standing_rules" },
      details: { title: `You approved ${OFFER_AT} emails in this step without edits. Set up auto-approve?`, warnings: [] },
    });
  };
}
