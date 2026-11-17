// SPDX-License-Identifier: AGPL-3.0-only
// DMs a DM step drafted, one per Person. They are never deleted; copied and sent times only move once.
import { personKeys } from "@direx/db/schema";
import { campaignDms } from "@direx/db/schema-campaigns";
import { and, eq, inArray, isNull } from "drizzle-orm";
import type { CampaignsTx } from "./repo";

export type DmRow = typeof campaignDms.$inferSelect;

/** Each record's profile address on one network, from its keys. */
export async function profilesOf(tx: CampaignsTx, personIds: readonly string[], kind: "linkedin" | "x"): Promise<Map<string, string>> {
  if (!personIds.length) return new Map();
  const rows = await tx.select({ personId: personKeys.personId, value: personKeys.value }).from(personKeys).where(and(eq(personKeys.kind, kind), inArray(personKeys.personId, [...personIds])));
  return new Map(rows.map((r) => [r.personId, r.value]));
}

export const dmsOf = (tx: CampaignsTx, campaignId: string, stepKey: string) =>
  tx.select().from(campaignDms).where(and(eq(campaignDms.campaignId, campaignId), eq(campaignDms.stepKey, stepKey))).orderBy(campaignDms.createdAt);

/** One DM; a second for the same Person and step adds nothing. */
export async function insertDm(tx: CampaignsTx, row: Omit<DmRow, "id" | "copiedAt" | "sentAt" | "sentBy">): Promise<DmRow | undefined> {
  const [made] = await tx.insert(campaignDms).values(row).onConflictDoNothing().returning();
  return made;
}

export const readDm = async (tx: CampaignsTx, id: string): Promise<DmRow | undefined> => (await tx.select().from(campaignDms).where(eq(campaignDms.id, id)))[0];

export async function setCopied(tx: CampaignsTx, id: string, at: Date) {
  await tx.update(campaignDms).set({ copiedAt: at }).where(and(eq(campaignDms.id, id), isNull(campaignDms.copiedAt)));
}

export async function setSent(tx: CampaignsTx, id: string, at: Date, userId: string) {
  await tx.update(campaignDms).set({ sentAt: at, sentBy: userId }).where(and(eq(campaignDms.id, id), isNull(campaignDms.sentAt)));
}
