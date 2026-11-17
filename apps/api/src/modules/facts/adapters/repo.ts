// SPDX-License-Identifier: AGPL-3.0-only
// Every facts SQL statement. Versions are only inserted. Items are read, never written, to
// see which contradictions are open, so that can't disagree with the Item's own state.
import { and, asc, eq, inArray, isNull, sql } from "drizzle-orm";
import { withWorkspace, type WorkspaceTx } from "@direx/db";
import { factVersions, facts, items } from "@direx/db/schema";
import type { Actor } from "../../ledger";
import type { Confidence, Field, Source } from "../domain/slots";

export type FactsTx = WorkspaceTx;
export type FactRow = typeof facts.$inferSelect;
export type VersionRow = typeof factVersions.$inferSelect;
export type LiveFact = FactRow & { value: string; source: Source; confidence: Confidence; digest: string };

export const inWorkspace = <T>(workspaceId: string, fn: (tx: FactsTx) => Promise<T>) => withWorkspace(workspaceId, fn);

const live = (tx: FactsTx) =>
  tx
    .select({ fact: facts, value: factVersions.value, source: factVersions.source, confidence: factVersions.confidence, digest: factVersions.digest })
    .from(facts)
    .innerJoin(factVersions, and(eq(factVersions.workspaceId, facts.workspaceId), eq(factVersions.factId, facts.id), eq(factVersions.version, facts.currentVersion)));
type LiveRow = Awaited<ReturnType<typeof live>>[number];
const toLive = (r: LiveRow): LiveFact => ({ ...r.fact, value: r.value, source: r.source as Source, confidence: r.confidence as Confidence, digest: r.digest });

export const listLive = async (tx: FactsTx): Promise<LiveFact[]> =>
  (await live(tx).where(isNull(facts.retiredAt)).orderBy(asc(facts.field), asc(facts.subject))).map(toLive);

export async function liveInSlot(tx: FactsTx, field: Field, subject: string): Promise<LiveFact | undefined> {
  const [r] = await live(tx).where(and(eq(facts.field, field), eq(facts.subject, subject), isNull(facts.retiredAt)));
  return r && toLive(r);
}

export const readFact = async (tx: FactsTx, id: string): Promise<FactRow | undefined> => (await tx.select().from(facts).where(eq(facts.id, id)))[0];

/** The row lock every change takes, so a fact's next version number can't be used twice. */
export const lockFact = async (tx: FactsTx, id: string): Promise<FactRow | undefined> => (await tx.select().from(facts).where(eq(facts.id, id)).for("update"))[0];

export async function lockLiveInSlot(tx: FactsTx, field: Field, subject: string): Promise<FactRow | undefined> {
  const [r] = await tx.select().from(facts).where(and(eq(facts.field, field), eq(facts.subject, subject), isNull(facts.retiredAt))).for("update");
  return r;
}

/** Undefined when a concurrent writer filled the slot first. */
export async function insertFact(tx: FactsTx, workspaceId: string, field: Field, subject: string, now: Date): Promise<FactRow | undefined> {
  const [r] = await tx.insert(facts).values({ workspaceId, field, subject, currentVersion: 1, createdAt: now, updatedAt: now }).onConflictDoNothing().returning();
  return r;
}

export async function advanceFact(tx: FactsTx, id: string, version: number, now: Date) {
  await tx.update(facts).set({ currentVersion: version, updatedAt: now }).where(eq(facts.id, id));
}

export async function retireFact(tx: FactsTx, id: string, by: string | null, now: Date) {
  await tx.update(facts).set({ retiredAt: now, retiredBy: by, updatedAt: now }).where(eq(facts.id, id));
}

export async function insertVersion(
  tx: FactsTx,
  workspaceId: string,
  v: { factId: string; version: number; value: string; source: Source; confidence: Confidence; digest: string },
  actor: Actor,
  now: Date,
) {
  await tx.insert(factVersions).values({
    workspaceId,
    ...v,
    actorUserId: "userId" in actor ? actor.userId : null,
    actorAgentRunId: "agentRunId" in actor ? actor.agentRunId : null,
    actorSystem: "system" in actor ? actor.system : null,
    at: now,
  });
}

export const versionsOf = (tx: FactsTx, factId: string): Promise<VersionRow[]> =>
  tx.select().from(factVersions).where(eq(factVersions.factId, factId)).orderBy(asc(factVersions.version));

/** Facts with a contradiction waiting for a person. */
export async function contestedIds(tx: FactsTx): Promise<Set<string>> {
  const rows = await tx
    .select({ id: sql<string>`${items.payload}->>'factId'` })
    .from(items)
    .where(and(eq(items.kind, "fact_conflict"), eq(items.state, "needs_approval")));
  return new Set(rows.map((r) => r.id));
}

/** A proposal already waiting with these words for this slot, so asking twice creates one Item. */
export async function openProposals(tx: FactsTx, field: Field, subject: string): Promise<{ id: string; kind: string; value: string }[]> {
  return tx
    .select({ id: items.id, kind: items.kind, value: sql<string>`${items.payload}->>'value'` })
    .from(items)
    .where(
      and(
        inArray(items.kind, ["fact_proposal", "fact_conflict"]),
        inArray(items.state, ["draft", "needs_approval"]),
        sql`${items.payload}->>'field' = ${field}`,
        sql`${items.payload}->>'subject' = ${subject}`,
      ),
    );
}
