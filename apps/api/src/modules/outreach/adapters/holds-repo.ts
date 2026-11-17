// SPDX-License-Identifier: AGPL-3.0-only
// Every relationship-hold SQL statement. Addresses arrive here already hashed.
import type { WorkspaceTx } from "@direx/db";
import { correspondents, holdHooks, holdReleases, outreachSettings, relationshipHolds } from "@direx/db/schema-outreach";
import { and, desc, eq, gt, inArray, isNull, max, notInArray, or, sql } from "drizzle-orm";

export type HoldRow = typeof relationshipHolds.$inferSelect;

/** The Workspace's address-hash key, made the first time anything asks; two callers at once get the same one. */
export async function emailHashKey(tx: WorkspaceTx, workspaceId: string, fresh: string, now: Date): Promise<string> {
  const [row] = await tx
    .insert(outreachSettings)
    .values({ workspaceId, emailHashKey: fresh, updatedAt: now })
    .onConflictDoUpdate({ target: outreachSettings.workspaceId, set: { emailHashKey: sql`coalesce(${outreachSettings.emailHashKey}, excluded.email_hash_key)` } })
    .returning({ key: outreachSettings.emailHashKey });
  return row!.key!;
}

export type NewHold = Pick<HoldRow, "workspaceId" | "emailHash" | "domain" | "personId" | "source" | "sourceRef" | "reason" | "startedAt" | "expiresAt" | "createdBy">;

/** Sending a webhook hold again extends its row and never shortens it; a manual hold is always a new row. */
export async function insertHolds(tx: WorkspaceTx, rows: readonly NewHold[]): Promise<void> {
  if (!rows.length) return;
  await tx
    .insert(relationshipHolds)
    .values([...rows])
    .onConflictDoUpdate({
      target: [relationshipHolds.workspaceId, relationshipHolds.source, relationshipHolds.sourceRef, relationshipHolds.emailHash],
      set: { expiresAt: sql`greatest(${relationshipHolds.expiresAt}, excluded.expires_at)`, reason: sql`excluded.reason` },
      setWhere: isNull(relationshipHolds.endedAt),
    });
}

export async function holdsOn(tx: WorkspaceTx, hashes: readonly string[]): Promise<HoldRow[]> {
  if (!hashes.length) return [];
  return tx.select().from(relationshipHolds).where(inArray(relationshipHolds.emailHash, [...hashes]));
}

/** Holds on other people at these domains that may still be running. */
export async function holdsAtDomains(tx: WorkspaceTx, domains: readonly string[], notHashes: readonly string[], now: Date): Promise<HoldRow[]> {
  if (!domains.length) return [];
  return tx
    .select()
    .from(relationshipHolds)
    .where(
      and(
        inArray(relationshipHolds.domain, [...domains]),
        notHashes.length ? notInArray(relationshipHolds.emailHash, [...notHashes]) : undefined,
        gt(relationshipHolds.expiresAt, now),
        or(isNull(relationshipHolds.endedAt), gt(relationshipHolds.endedAt, now)),
      ),
    );
}

export async function endHold(tx: WorkspaceTx, id: string, by: string, now: Date): Promise<HoldRow | null> {
  const [row] = await tx
    .update(relationshipHolds)
    .set({ endedAt: now, endedBy: by })
    .where(and(eq(relationshipHolds.id, id), isNull(relationshipHolds.endedAt)))
    .returning();
  return row ?? null;
}

export async function lastWrittenTo(tx: WorkspaceTx, hashes: readonly string[]): Promise<Date | null> {
  if (!hashes.length) return null;
  const [row] = await tx.select({ at: max(correspondents.lastSeenAt) }).from(correspondents).where(inArray(correspondents.emailHash, [...hashes]));
  return row?.at ?? null;
}

/** The newest date wins, so reading the same Sent mail twice changes nothing. */
export async function recordCorrespondents(tx: WorkspaceTx, workspaceId: string, credentialId: string, rows: readonly { emailHash: string; at: Date }[]): Promise<void> {
  const newest = new Map<string, Date>();
  for (const r of rows) if (!newest.has(r.emailHash) || r.at > newest.get(r.emailHash)!) newest.set(r.emailHash, r.at);
  if (!newest.size) return;
  await tx
    .insert(correspondents)
    .values([...newest].map(([emailHash, lastSeenAt]) => ({ workspaceId, emailHash, source: "sent_mail", credentialId, lastSeenAt })))
    .onConflictDoUpdate({
      target: [correspondents.workspaceId, correspondents.emailHash, correspondents.source],
      set: { lastSeenAt: sql`greatest(${correspondents.lastSeenAt}, excluded.last_seen_at)`, credentialId: sql`excluded.credential_id` },
    });
}

export type HookRow = typeof holdHooks.$inferSelect;

export async function insertHook(tx: WorkspaceTx, row: typeof holdHooks.$inferInsert): Promise<HookRow> {
  const [made] = await tx.insert(holdHooks).values(row).returning();
  return made!;
}

/** The Workspace's working hook, if it has one. */
export async function liveHook(tx: WorkspaceTx): Promise<HookRow | null> {
  const [row] = await tx.select().from(holdHooks).where(isNull(holdHooks.disabledAt)).orderBy(desc(holdHooks.createdAt)).limit(1);
  return row ?? null;
}

export async function hookById(tx: WorkspaceTx, id: string): Promise<HookRow | null> {
  const [row] = await tx.select().from(holdHooks).where(and(eq(holdHooks.id, id), isNull(holdHooks.disabledAt)));
  return row ?? null;
}

export async function insertRelease(tx: WorkspaceTx, row: typeof holdReleases.$inferInsert): Promise<void> {
  await tx.insert(holdReleases).values(row);
}

export async function latestReleases(tx: WorkspaceTx, personIds: readonly string[]): Promise<{ inferred: Date | null; company: Date | null }> {
  const out = { inferred: null as Date | null, company: null as Date | null };
  if (!personIds.length) return out;
  const rows = await tx
    .select({ kind: holdReleases.kind, at: max(holdReleases.releasedAt) })
    .from(holdReleases)
    .where(inArray(holdReleases.personId, [...personIds]))
    .groupBy(holdReleases.kind)
    .orderBy(desc(holdReleases.kind));
  for (const r of rows) if (r.kind === "inferred" || r.kind === "company") out[r.kind] = r.at;
  return out;
}
