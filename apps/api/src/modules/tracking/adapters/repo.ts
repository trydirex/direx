// SPDX-License-Identifier: AGPL-3.0-only
// Every tracking SQL statement. Inside one Workspace, except the edge's question, which goes through
// the one system function that answers it with yes or no (ADR 0035 rule 021).
import { and, count, eq, ne, sql } from "drizzle-orm";
import { withSystem, withWorkspace, type WorkspaceTx } from "@direx/db";
import { campaigns } from "@direx/db/schema-campaigns";
import { trackedLinks, trackingDomains } from "@direx/db/schema-tracking";

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

/** The edge's question: may it get a certificate for this host? */
export async function hostAllowed(hostname: string): Promise<boolean> {
  const { rows } = await withSystem((tx) => tx.execute(sql`select system.tracking_host_allowed(${hostname}) as ok`));
  return (rows[0] as { ok: boolean } | undefined)?.ok === true;
}
