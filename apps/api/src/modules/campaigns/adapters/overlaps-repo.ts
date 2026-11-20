// SPDX-License-Identifier: AGPL-3.0-only
// The rows behind a Campaign's overlaps: each Touch it made and each Person's first interested reply.
// Kept apart from repo.ts, which is already past its size warning.
import { actionEvents, items } from "@direx/db/schema";
import { campaignActions, campaignDms } from "@direx/db/schema-campaigns";
import { replySignals } from "@direx/db/schema-outreach";
import { and, eq, isNotNull, sql } from "drizzle-orm";
import type { CampaignsTx } from "./repo";

const asDate = (v: string | Date) => new Date(v);

/** Each email Action that reached sent, at its first move there: a resend's later event is no second Touch. */
export const sentEmails = (tx: CampaignsTx, campaignId: string) =>
  tx
    .select({ personId: campaignActions.personId, stepKey: campaignActions.stepKey, at: sql<Date>`min(${actionEvents.at})`.mapWith(asDate) })
    .from(campaignActions)
    .innerJoin(actionEvents, and(eq(actionEvents.actionId, campaignActions.actionId), eq(actionEvents.toState, "sent")))
    .where(eq(campaignActions.campaignId, campaignId))
    .groupBy(campaignActions.actionId, campaignActions.personId, campaignActions.stepKey);

/** DMs a person marked sent; one never marked is no Touch, since Direx can't see it went. */
export const sentDms = (tx: CampaignsTx, campaignId: string) =>
  tx
    .select({ personId: campaignDms.personId, stepKey: campaignDms.stepKey, channel: campaignDms.channel, at: campaignDms.sentAt })
    .from(campaignDms)
    .where(and(eq(campaignDms.campaignId, campaignId), isNotNull(campaignDms.sentAt)));

/**
 * Each Person's first interested reply to this Campaign's email, dated by when the reply came in. A replaced
 * reply Item is cancelled but keeps its payload, so any state counts, as interestedPeople counts them.
 */
export const firstInterested = (tx: CampaignsTx, campaignId: string) =>
  tx
    .select({ personId: campaignActions.personId, at: sql<Date>`min(${replySignals.receivedAt})`.mapWith(asDate) })
    .from(items)
    // Compared as text: another kind's payload may hold ids that aren't uuids.
    .innerJoin(campaignActions, sql`${campaignActions.actionId}::text = ${items.payload}->>'actionId'`)
    .innerJoin(replySignals, sql`${replySignals.id}::text = ${items.payload}->>'signalId'`)
    .where(and(eq(campaignActions.campaignId, campaignId), eq(items.kind, "reply"), sql`${items.payload}->>'label' = 'interested'`))
    .groupBy(campaignActions.personId);
