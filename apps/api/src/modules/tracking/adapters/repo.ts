// SPDX-License-Identifier: AGPL-3.0-only
// Every tracking SQL statement. Inside one Workspace, except the edge's question, which goes through
// the one system function that answers it with yes or no (ADR 0035 rule 021).
import { and, count, eq, ne, sql } from "drizzle-orm";
import { withSystem, withWorkspace, type WorkspaceTx } from "@direx/db";
import { items } from "@direx/db/schema";
import { campaigns } from "@direx/db/schema-campaigns";
import { personEligibility } from "@direx/db/schema-outreach";
import { trackedLinkUses, trackedLinks, trackingDomains } from "@direx/db/schema-tracking";

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

/** The step's link to this destination: the existing one, else `id` made now. Links never change. */
export async function linkFor(tx: TrackingTx, l: { id: string; workspaceId: string; campaignId: string; stepKey: string; domainId: string; destination: string; now: Date }): Promise<string> {
  await tx
    .insert(trackedLinks)
    .values({ id: l.id, workspaceId: l.workspaceId, campaignId: l.campaignId, stepKey: l.stepKey, domainId: l.domainId, destination: l.destination, createdAt: l.now })
    .onConflictDoNothing();
  const [row] = await tx
    .select({ id: trackedLinks.id })
    .from(trackedLinks)
    .where(and(eq(trackedLinks.campaignId, l.campaignId), eq(trackedLinks.stepKey, l.stepKey), eq(trackedLinks.domainId, l.domainId), eq(trackedLinks.destination, l.destination), eq(trackedLinks.checkOnly, false)));
  return row!.id;
}

/** Records the Item's Action as using each link, in the caller's transaction. */
export async function insertUses(tx: TrackingTx, workspaceId: string, itemId: string, inputsHash: string, uses: { linkId: string; tokenHash: string | null; personId: string | null }[], now: Date): Promise<void> {
  if (!uses.length) return;
  const [item] = await tx.select({ actionId: items.actionId }).from(items).where(eq(items.id, itemId));
  if (!item?.actionId) throw new Error(`tracking: item ${itemId} has no Action`);
  await tx.insert(trackedLinkUses).values(uses.map((u) => ({ workspaceId, actionId: item.actionId, linkId: u.linkId, tokenHash: u.tokenHash, personId: u.personId, inputsHash, createdAt: now })));
}

/** The edge's question: may it get a certificate for this host? */
export async function hostAllowed(hostname: string): Promise<boolean> {
  const { rows } = await withSystem((tx) => tx.execute(sql`select system.tracking_host_allowed(${hostname}) as ok`));
  return (rows[0] as { ok: boolean } | undefined)?.ok === true;
}
