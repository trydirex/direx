// SPDX-License-Identifier: AGPL-3.0-only
// What Brand and later modules read. A contested fact stays visible on Brand, but nothing
// may rely on it until a person decides.
import { contestedIds, inWorkspace, listLive, readFact, versionsOf, type FactsTx, type LiveFact } from "../adapters/repo";
import { checkCitation, type Citation } from "../domain/citation";
import { bannedIn } from "../domain/claims";

export type FactView = LiveFact & { usable: boolean };

/** The ledger's "fact" snapshot lookup: the live version, or null once it is gone or retired. */
export async function factVersion(tx: FactsTx, id: string): Promise<string | null> {
  const row = await readFact(tx, id);
  return row && !row.retiredAt ? String(row.currentVersion) : null;
}

/** What a person should read before approving work that cited this fact again. */
export async function describeFactChange(tx: FactsTx, entry: { kind: string; id: string }, live: string | null): Promise<string | null> {
  if (entry.kind !== "fact") return null;
  const row = await readFact(tx, entry.id);
  if (!row) return null;
  const name = row.subject ? `${row.field} (${row.subject})` : row.field;
  if (live === null) return `A fact this cites was retired: ${name}. Read it before approving.`;
  const current = (await versionsOf(tx, entry.id)).find((v) => String(v.version) === live);
  return `A fact this cites changed: ${name} is now "${current?.value ?? "unknown"}". Read it before approving.`;
}

/** Whether fact_id@version may be relied on, inside the caller's transaction. */
export async function citationOf(tx: FactsTx, id: string, version: number): Promise<Citation> {
  const row = await readFact(tx, id);
  const contested = await contestedIds(tx);
  return checkCitation(version, row && { currentVersion: row.currentVersion, retired: row.retiredAt !== null, contested: contested.has(id) });
}

export function factReads() {
  return {
    list: (workspaceId: string): Promise<FactView[]> =>
      inWorkspace(workspaceId, async (tx) => {
        const contested = await contestedIds(tx);
        return (await listLive(tx)).map((f) => ({ ...f, usable: !contested.has(f.id) }));
      }),

    history: (workspaceId: string, id: string) => inWorkspace(workspaceId, (tx) => versionsOf(tx, id)),

    /**
     * What a draft may cite. Banned phrases aren't things to say, and a competitor's facts aren't ours
     * to claim (comparative claims wait on counsel), so neither is here.
     */
    usableFacts: (workspaceId: string) =>
      inWorkspace(workspaceId, async (tx) => {
        const contested = await contestedIds(tx);
        return (await listLive(tx))
          .filter((f) => !contested.has(f.id) && f.field !== "never_say" && f.field !== "competitor")
          .map((f) => ({ id: f.id, version: f.currentVersion, field: f.field, subject: f.subject, value: f.value, digest: f.digest }));
      }),

    checkCitation: (workspaceId: string, id: string, version: number): Promise<Citation> =>
      inWorkspace(workspaceId, (tx) => citationOf(tx, id, version)),

    /** A banned phrase stays banned while contested: the stricter reading wins. */
    bannedClaimsIn: (workspaceId: string, text: string) =>
      inWorkspace(workspaceId, async (tx) =>
        bannedIn(
          text,
          (await listLive(tx)).filter((f) => f.field === "never_say").map((f) => f.value),
        ),
      ),
  };
}
