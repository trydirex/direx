// SPDX-License-Identifier: AGPL-3.0-only
// Every tracking SQL statement. Inside one Workspace, except the edge's question and the redirect's
// lookup, which go through the two system functions that answer with yes or no, or ids (ADR 0035 rule 021).
import { and, count, eq, lt, ne, sql } from "drizzle-orm";
import { withSystem, withWorkspace, type WorkspaceTx } from "@direx/db";
import { actionEvents, actions, items } from "@direx/db/schema";
import { campaignDms, campaigns } from "@direx/db/schema-campaigns";
import { personEligibility } from "@direx/db/schema-outreach";
import { clickCounts, trackedLinkUses, trackedLinks, trackingCounters, trackingDomains } from "@direx/db/schema-tracking";

export type TrackingTx = WorkspaceTx;
export type DomainRow = typeof trackingDomains.$inferSelect;
export type DomainState = "pending" | "dns_ok" | "verified" | "stopped";

export const inWorkspace = <T>(workspaceId: string, fn: (tx: TrackingTx) => Promise<T>) => withWorkspace(workspaceId, fn);

export const listDomains = (tx: TrackingTx): Promise<DomainRow[]> => tx.select().from(trackingDomains).orderBy(trackingDomains.createdAt);

export async function domainById(tx: TrackingTx, id: string): Promise<DomainRow | undefined> {
  const [row] = await tx.select().from(trackingDomains).where(eq(trackingDomains.id, id));
  return row;
}

/** Inserts a domain; "taken" when any Workspace on the deployment already has the hostname. */
export async function insertDomain(tx: TrackingTx, d: { workspaceId: string; hostname: string; txtValue: string; createdBy: string; now: Date }): Promise<DomainRow | "taken"> {
  const [row] = await tx
    .insert(trackingDomains)
    .values({ workspaceId: d.workspaceId, hostname: d.hostname, txtValue: d.txtValue, createdBy: d.createdBy, createdAt: d.now })
    .onConflictDoNothing({ target: trackingDomains.hostname })
    .returning();
  return row ?? "taken";
}

/** Records a check's outcome; a domain stopped meanwhile stays stopped. */
export async function recordCheck(tx: TrackingTx, id: string, state: DomainState, at: Date): Promise<void> {
  await tx
    .update(trackingDomains)
    .set({ state, checkedAt: at })
    .where(and(eq(trackingDomains.id, id), ne(trackingDomains.state, "stopped")));
}

export async function stopDomain(tx: TrackingTx, id: string): Promise<boolean> {
  const rows = await tx.update(trackingDomains).set({ state: "stopped" }).where(eq(trackingDomains.id, id)).returning({ id: trackingDomains.id });
  return rows.length > 0;
}

/** Whether a link or a Campaign uses the domain, which keeps it from being removed (rule 008). */
export async function domainInUse(tx: TrackingTx, id: string): Promise<boolean> {
  const [links] = await tx.select({ n: count() }).from(trackedLinks).where(eq(trackedLinks.domainId, id));
  const [camps] = await tx.select({ n: count() }).from(campaigns).where(eq(campaigns.trackingDomainId, id));
  return (links?.n ?? 0) + (camps?.n ?? 0) > 0;
}

export async function deleteDomain(tx: TrackingTx, id: string): Promise<void> {
  await tx.delete(trackingDomains).where(eq(trackingDomains.id, id));
}

/** A Campaign's two switches and its tracking domain, or undefined when there is no such Campaign. */
export async function campaignTracking(tx: TrackingTx, campaignId: string) {
  const [row] = await tx
    .select({ trackingOn: campaigns.trackingOn, perPersonOn: campaigns.perPersonOn, domainId: trackingDomains.id, hostname: trackingDomains.hostname, state: trackingDomains.state })
    .from(campaigns)
    .leftJoin(trackingDomains, eq(trackingDomains.id, campaigns.trackingDomainId))
    .where(eq(campaigns.id, campaignId));
  return row;
}

/** The Person's country and whether a person stated it, or undefined with no eligibility record. */
export async function countryOf(tx: TrackingTx, personId: string) {
  const [row] = await tx.select({ country: personEligibility.country, confidence: personEligibility.countryConfidence }).from(personEligibility).where(eq(personEligibility.personId, personId));
  return row;
}

/** Reads the original destination of a link on this domain in the current Workspace. */
export async function linkDestination(tx: TrackingTx, domainId: string, id: string): Promise<string | undefined> {
  const [row] = await tx.select({ destination: trackedLinks.destination }).from(trackedLinks)
    .where(and(eq(trackedLinks.domainId, domainId), eq(trackedLinks.id, id)));
  return row?.destination;
}

/** The step's link to this destination: the existing one, else `id` made now. Links never change. */
export async function linkFor(tx: TrackingTx, l: { id: string; workspaceId: string; campaignId: string; stepKey: string; domainId: string; destination: string; checkOnly: boolean; now: Date }): Promise<string> {
  await tx
    .insert(trackedLinks)
    .values({ id: l.id, workspaceId: l.workspaceId, campaignId: l.campaignId, stepKey: l.stepKey, domainId: l.domainId, destination: l.destination, checkOnly: l.checkOnly, createdAt: l.now })
    .onConflictDoNothing();
  const [row] = await tx
    .select({ id: trackedLinks.id })
    .from(trackedLinks)
    .where(and(eq(trackedLinks.campaignId, l.campaignId), eq(trackedLinks.stepKey, l.stepKey), eq(trackedLinks.domainId, l.domainId), eq(trackedLinks.destination, l.destination), eq(trackedLinks.checkOnly, l.checkOnly)));
  return row!.id;
}

export type UseTarget = { itemId: string } | { actionId: string } | { dmId: string };

/** Records the message (an Item's Action, an Action or a DM) as using each link, in the caller's transaction. */
export async function insertUses(tx: TrackingTx, workspaceId: string, target: UseTarget, inputsHash: string, uses: { linkId: string; tokenHash: string | null; personId: string | null }[], now: Date): Promise<void> {
  if (!uses.length) return;
  let message: { actionId: string } | { dmId: string };
  if ("itemId" in target) {
    const [item] = await tx.select({ actionId: items.actionId }).from(items).where(eq(items.id, target.itemId));
    if (!item?.actionId) throw new Error(`tracking: item ${target.itemId} has no Action`);
    message = { actionId: item.actionId };
  } else message = target;
  await tx.insert(trackedLinkUses).values(uses.map((u) => ({ workspaceId, ...message, linkId: u.linkId, tokenHash: u.tokenHash, personId: u.personId, inputsHash, createdAt: now })));
}

/** The edge's question: may it get a certificate for this host? */
export async function hostAllowed(hostname: string): Promise<boolean> {
  const { rows } = await withSystem((tx) => tx.execute(sql`select system.tracking_host_allowed(${hostname}) as ok`));
  return (rows[0] as { ok: boolean } | undefined)?.ok === true;
}

/** The redirect's one look across Workspaces: the link on this host, and the use a token names. Ids only. */
export async function lookupLink(hostname: string, linkId: string, tokenHash: string | null): Promise<{ workspaceId: string; linkId: string; useId: string | null } | undefined> {
  const { rows } = await withSystem((tx) => tx.execute(sql`select workspace_id, link_id, use_id from system.tracking_link_lookup(${hostname}, ${linkId}, ${tokenHash})`));
  const row = rows[0] as { workspace_id: string; link_id: string; use_id: string | null } | undefined;
  return row && { workspaceId: row.workspace_id, linkId: row.link_id, useId: row.use_id };
}

/**
 * A link's destination and switches, and each of its uses (or only the named one) with its Action's
 * state and send time, or its DM's. An Action's send time is its first move to sent in the ledger.
 */
export async function linkToFollow(tx: TrackingTx, linkId: string, useId: string | null) {
  const [link] = await tx
    .select({ destination: trackedLinks.destination, checkOnly: trackedLinks.checkOnly, trackingOn: campaigns.trackingOn })
    .from(trackedLinks)
    .innerJoin(campaigns, and(eq(campaigns.workspaceId, trackedLinks.workspaceId), eq(campaigns.id, trackedLinks.campaignId)))
    .where(eq(trackedLinks.id, linkId));
  if (!link) return undefined;
  const sentEvent = sql<Date | null>`(select min(${actionEvents.at}) from ${actionEvents} where ${actionEvents.actionId} = ${trackedLinkUses.actionId} and ${actionEvents.toState} = 'sent')`.mapWith((v: string | null) => (v ? new Date(v) : null));
  const uses = await tx
    .select({ actionState: actions.state, actionSentAt: sentEvent, dmId: campaignDms.id, dmSentAt: campaignDms.sentAt })
    .from(trackedLinkUses)
    .leftJoin(actions, and(eq(actions.workspaceId, trackedLinkUses.workspaceId), eq(actions.id, trackedLinkUses.actionId)))
    .leftJoin(campaignDms, and(eq(campaignDms.workspaceId, trackedLinkUses.workspaceId), eq(campaignDms.id, trackedLinkUses.dmId)))
    .where(useId ? and(eq(trackedLinkUses.linkId, linkId), eq(trackedLinkUses.id, useId)) : eq(trackedLinkUses.linkId, linkId));
  return { ...link, uses };
}

/** Adds this request to its link's minute; the minute's count so far. */
export async function bumpCounter(tx: TrackingTx, workspaceId: string, linkId: string, minute: Date): Promise<number> {
  const [row] = await tx
    .insert(trackingCounters)
    .values({ workspaceId, linkId, minute, count: 1 })
    .onConflictDoUpdate({ target: [trackingCounters.workspaceId, trackingCounters.linkId, trackingCounters.minute], set: { count: sql`${trackingCounters.count} + 1` } })
    .returning({ count: trackingCounters.count });
  return row!.count;
}

/** Drops the Workspace's counter minutes before `before`, as the redirect counts. */
export async function pruneCounters(tx: TrackingTx, before: Date): Promise<void> {
  await tx.delete(trackingCounters).where(lt(trackingCounters.minute, before));
}

/** One more click on the link today in this bucket, under this classifier version. */
export async function addClick(tx: TrackingTx, c: { workspaceId: string; linkId: string; day: string; bucket: string; classifierVersion: number }): Promise<void> {
  await tx
    .insert(clickCounts)
    .values({ ...c, count: 1 })
    .onConflictDoUpdate({ target: [clickCounts.workspaceId, clickCounts.linkId, clickCounts.day, clickCounts.bucket, clickCounts.classifierVersion], set: { count: sql`${clickCounts.count} + 1` } });
}
