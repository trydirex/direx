// SPDX-License-Identifier: AGPL-3.0-only
// The latest proposed search terms, one row per Workspace, and the names they are checked against.
import type { WorkspaceTx } from "@direx/db";
import { prospectPeople, prospectTerms } from "@direx/db/schema-prospecting";
import type { FullName } from "../domain/terms";

export type StoredTerms = { runId: string; terms: string[]; objective: string | null; dropped: number; proposedAt: Date };

// ponytail: reads every name once per terms run; match in SQL if a Workspace's people reach the millions.
export const knownNames = (tx: WorkspaceTx): Promise<FullName[]> => tx.select({ first: prospectPeople.first, last: prospectPeople.last }).from(prospectPeople);

/** A run's terms replace the Workspace's last ones. */
export async function saveTerms(tx: WorkspaceTx, workspaceId: string, t: StoredTerms): Promise<void> {
  await tx
    .insert(prospectTerms)
    .values({ workspaceId, ...t })
    .onConflictDoUpdate({ target: prospectTerms.workspaceId, set: t });
}

export async function readTerms(tx: WorkspaceTx): Promise<StoredTerms | null> {
  const [row] = await tx
    .select({ runId: prospectTerms.runId, terms: prospectTerms.terms, objective: prospectTerms.objective, dropped: prospectTerms.dropped, proposedAt: prospectTerms.proposedAt })
    .from(prospectTerms);
  return row ?? null;
}
