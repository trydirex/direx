// SPDX-License-Identifier: AGPL-3.0-only
// Every docs SQL statement. Sources and rows are kept, never deleted; the app role has no DELETE on them.
import { and, desc, eq, inArray, isNull, sql } from "drizzle-orm";
import { withWorkspace, type WorkspaceTx } from "@direx/db";
import { actions, items } from "@direx/db/schema";
import { docRows, docSources, docWriteGrants } from "@direx/db/schema-docs";

export type DocsTx = WorkspaceTx;
export type SourceRow = typeof docSources.$inferSelect;
export type DocRow = typeof docRows.$inferSelect;
export type GrantRow = typeof docWriteGrants.$inferSelect;
export const inWorkspace = <T>(workspaceId: string, fn: (tx: DocsTx) => Promise<T>) => withWorkspace(workspaceId, fn);

export const sources = (tx: DocsTx) => tx.select().from(docSources);
export const sourceById = async (tx: DocsTx, id: string) => (await tx.select().from(docSources).where(eq(docSources.id, id)))[0];

/** One source per database: saving its mapping again replaces the mapping. */
export async function saveSource(tx: DocsTx, a: { workspaceId: string; externalId: string; title: string; mapping: unknown; setBy: string; now: Date }): Promise<SourceRow> {
  const [row] = await tx
    .insert(docSources)
    .values({ workspaceId: a.workspaceId, externalId: a.externalId, title: a.title, mapping: a.mapping, setBy: a.setBy, createdAt: a.now, updatedAt: a.now })
    .onConflictDoUpdate({ target: [docSources.workspaceId, docSources.externalId], set: { title: a.title, mapping: a.mapping, setBy: a.setBy, updatedAt: a.now } })
    .returning();
  return row!;
}
export const markChecked = (tx: DocsTx, id: string, now: Date) => tx.update(docSources).set({ checkedAt: now, updatedAt: now }).where(eq(docSources.id, id));

export const rowsOf = (tx: DocsTx, sourceId: string) => tx.select().from(docRows).where(eq(docRows.sourceId, sourceId));
export async function insertRow(tx: DocsTx, a: { workspaceId: string; sourceId: string; externalId: string; itemId: string; revision: number; editedAt: Date | null; now: Date }) {
  await tx.insert(docRows).values({ workspaceId: a.workspaceId, sourceId: a.sourceId, externalId: a.externalId, itemId: a.itemId, importedRevision: a.revision, editedAt: a.editedAt, createdAt: a.now, updatedAt: a.now });
}
export async function updateRow(tx: DocsTx, a: { sourceId: string; externalId: string; revision?: number; editedAt: Date | null; flag: "changed_in_source" | null; now: Date }) {
  await tx
    .update(docRows)
    .set({ editedAt: a.editedAt, flag: a.flag, updatedAt: a.now, ...(a.revision !== undefined && { importedRevision: a.revision }) })
    .where(and(eq(docRows.sourceId, a.sourceId), eq(docRows.externalId, a.externalId)));
}

// Status write-back (ADR 0025). An answer is never changed or removed; a stop is the only later write.

/** The newest answer for this source, the one that counts. */
export async function currentGrant(tx: DocsTx, sourceId: string): Promise<GrantRow | undefined> {
  const [row] = await tx.select().from(docWriteGrants).where(eq(docWriteGrants.sourceId, sourceId)).orderBy(desc(docWriteGrants.seq)).limit(1);
  return row;
}
export const grantById = async (tx: DocsTx, id: string): Promise<GrantRow | undefined> => (await tx.select().from(docWriteGrants).where(eq(docWriteGrants.id, id)).limit(1))[0];

export async function insertGrant(tx: DocsTx, g: Pick<GrantRow, "workspaceId" | "sourceId" | "credentialId" | "mappingHash" | "answer" | "wordingVersion" | "answeredBy" | "answeredAt">): Promise<GrantRow> {
  const [row] = await tx.insert(docWriteGrants).values(g).returning();
  return row!;
}

/** Stops a yes not already stopped; undefined when there was none to stop. */
export async function stopGrant(tx: DocsTx, id: string, s: { stoppedBy: string | null; stoppedAt: Date; stopReason: string }): Promise<GrantRow | undefined> {
  const [row] = await tx
    .update(docWriteGrants)
    .set(s)
    .where(and(eq(docWriteGrants.id, id), eq(docWriteGrants.answer, "yes"), isNull(docWriteGrants.stoppedAt)))
    .returning();
  return row;
}

/** The source, locked for the rest of the transaction: shared by a write's checks, exclusive by a mapping change. */
export const lockSource = async (tx: DocsTx, id: string, mode: "share" | "update") => (await tx.select().from(docSources).where(eq(docSources.id, id)).for(mode))[0];

/** A new write-back mapping and the credential it writes with; either one changed bumps the version. */
export async function saveWriteBack(tx: DocsTx, id: string, a: { credentialId: string; writeBack: unknown; now: Date }) {
  await tx
    .update(docSources)
    .set({ credentialId: a.credentialId, writeBack: a.writeBack, mappingVersion: sql`${docSources.mappingVersion} + 1`, updatedAt: a.now })
    .where(eq(docSources.id, id));
}

/** Each row of a source with its newest write-back Action, if it has one. */
export function rowsWithWrites(tx: DocsTx, sourceId: string) {
  return tx
    .select({
      row: docRows,
      action: { id: actions.id, state: actions.state, holdReason: actions.holdReason, blockReason: actions.blockReason, reasonDetail: actions.reasonDetail, spec: actions.spec, providerRef: actions.providerRef, updatedAt: actions.updatedAt },
    })
    .from(docRows)
    .leftJoin(actions, eq(actions.id, docRows.writeActionId))
    .where(eq(docRows.sourceId, sourceId));
}

export const rowByKey = async (tx: DocsTx, sourceId: string, externalId: string, lock = false) => {
  const q = tx.select().from(docRows).where(and(eq(docRows.sourceId, sourceId), eq(docRows.externalId, externalId)));
  return (await (lock ? q.for("update") : q))[0];
};

/** What a sent write-back left in the docs tool: its state, option and the edit time it made. */
export async function recordWritten(tx: DocsTx, sourceId: string, externalId: string, w: { writtenState: string | null; writtenOptionId: string; writtenEditedAt: Date | null; now: Date }) {
  await tx
    .update(docRows)
    .set({ writtenState: w.writtenState, writtenOptionId: w.writtenOptionId, writtenEditedAt: w.writtenEditedAt, updatedAt: w.now })
    .where(and(eq(docRows.sourceId, sourceId), eq(docRows.externalId, externalId)));
}

/** The row's next generation and the Action that writes it. */
export async function setWrite(tx: DocsTx, sourceId: string, externalId: string, w: { generation: number; writeActionId: string; now: Date }) {
  await tx
    .update(docRows)
    .set({ generation: w.generation, writeActionId: w.writeActionId, updatedAt: w.now })
    .where(and(eq(docRows.sourceId, sourceId), eq(docRows.externalId, externalId)));
}

/** After a stop: rows whose write-back ended without going out start over under the next yes. */
export async function clearEndedWrites(tx: DocsTx, sourceId: string) {
  const ended = tx.select({ id: actions.id }).from(actions).where(inArray(actions.state, ["cancelled", "blocked"]));
  await tx
    .update(docRows)
    .set({ writeActionId: null })
    .where(and(eq(docRows.sourceId, sourceId), inArray(docRows.writeActionId, ended)));
}

/** The public link a sent post reported, if any. */
export async function postUrl(tx: DocsTx, itemId: string): Promise<string | null> {
  const [row] = await tx.select({ result: actions.result }).from(items).innerJoin(actions, eq(actions.id, items.actionId)).where(eq(items.id, itemId));
  const url = (row?.result as { url?: unknown } | null | undefined)?.url;
  return typeof url === "string" ? url : null;
}
