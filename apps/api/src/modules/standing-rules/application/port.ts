// SPDX-License-Identifier: AGPL-3.0-only
// What this module asks of campaigns, supplied by the composition root.
import type { RulesTx } from "../adapters/repo";

export type CampaignPort = {
  /** Which step and Person an Action belongs to, and when that Person joined. */
  linkOf(tx: RulesTx, actionId: string): Promise<{ campaignId: string; stepKey: string; joinedAt: Date } | null>;
  stepOf(tx: RulesTx, campaignId: string, stepKey: string): Promise<{ templateRevision: number; citations: { factId: string; version: number }[]; tainted: boolean; draftingAgent: string | null; perPerson: boolean; email: boolean; outsideContent: boolean } | null>;
  actionsIn(tx: RulesTx, campaignId: string, stepKey: string): Promise<string[]>;
  /** Everyone in this campaign who is still active, for the grant form's count. */
  peopleIn(tx: RulesTx, campaignId: string): Promise<number>;
  /** A per-person draft's producer, whether its checks passed on the words it would send now, the campaign's outside-content answer, and a digest of producer and checks. Null for text a person wrote. */
  draftOf(tx: RulesTx, actionId: string): Promise<{ producer: unknown; checksPassed: boolean; outsideContent: boolean; digest: string } | null>;
};
