// SPDX-License-Identifier: AGPL-3.0-only
// What standing rules ask of a campaign. It answers with plain values, so that module knows no tables here.
import { storedSpec } from "@direx/plugin-sdk/host";
import { specHash } from "../../ledger";
import { campaignStepForRule, draftRecordOf, linkOfAction, peopleCount, stepActionIds, type CampaignsTx } from "../adapters/repo";
import type { CheckRecord } from "../domain/checks";
import { checksPassed } from "./draft-checks";
import { withoutFooter } from "./person-drafts";
import type { TemplateBody } from "../definitions/drafter";

export const campaignRulePort = {
  linkOf: (tx: CampaignsTx, actionId: string) => linkOfAction(tx, actionId),
  async stepOf(tx: CampaignsTx, campaignId: string, stepKey: string) {
    const row = await campaignStepForRule(tx, campaignId, stepKey);
    if (!row) return null;
    return {
      templateRevision: row.step.templateRevision,
      citations: (row.step.template as TemplateBody | null)?.citations ?? [],
      tainted: row.tainted ?? false,
      draftingAgent: row.agent,
      perPerson: row.draftingMode === "per_person",
      email: row.step.type === "email",
      outsideContent: row.outsideContent,
    };
  },
  actionsIn: (tx: CampaignsTx, campaignId: string, stepKey: string) => stepActionIds(tx, campaignId, stepKey),
  peopleIn: (tx: CampaignsTx, campaignId: string) => peopleCount(tx, campaignId),
  /**
   * A per-person draft's producer and checks, read against the words the Action would send now. The
   * digest binds both into a rule's approval, so a later swap of either holds the send.
   */
  async draftOf(tx: CampaignsTx, actionId: string) {
    const row = await draftRecordOf(tx, actionId);
    if (!row?.producer) return null;
    const spec = storedSpec("email.send", row.spec);
    const checks = (row.checks ?? null) as CheckRecord | null;
    return {
      producer: row.producer,
      checksPassed: checksPassed(checks, spec.subject ?? "", withoutFooter(spec.text ?? "")),
      outsideContent: row.outsideContent,
      digest: specHash({ producer: row.producer, textDigest: checks?.textDigest ?? null }),
    };
  },
};
