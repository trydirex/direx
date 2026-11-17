// SPDX-License-Identifier: AGPL-3.0-only
// What verification reads and writes. Each check is stored with its cost in one transaction, so a
// retried job finds it done and pays for nothing twice.
import type { WorkspaceTx } from "@direx/db";
import { prospectAddresses, prospectCompanies, prospectPeople, prospectRuns, prospectSnapshots } from "@direx/db/schema-prospecting";
import { and, asc, eq, inArray, isNull, sql } from "drizzle-orm";

export async function companyToVerify(tx: WorkspaceTx, companyId: string) {
  const [row] = await tx
    .select({ state: prospectCompanies.state, domain: prospectCompanies.domain, country: prospectCompanies.country, runId: prospectCompanies.firstRunId })
    .from(prospectCompanies)
    .where(eq(prospectCompanies.id, companyId));
  return row ?? null;
}

/** Everything guessing and checking decide from: the company's addresses, people and pages. */
export async function companyEvidence(tx: WorkspaceTx, companyId: string) {
  const addresses = await tx
    .select({
      id: prospectAddresses.id,
      email: prospectAddresses.email,
      source: prospectAddresses.source,
      name: prospectAddresses.name,
      leftOutReason: prospectAddresses.leftOutReason,
      noticeFound: prospectAddresses.noticeFound,
      verificationResult: prospectAddresses.verificationResult,
    })
    .from(prospectAddresses)
    .where(eq(prospectAddresses.companyId, companyId))
    .orderBy(asc(prospectAddresses.email));
  const people = await tx
    .select({ first: prospectPeople.first, last: prospectPeople.last, role: prospectPeople.role })
    .from(prospectPeople)
    .where(eq(prospectPeople.companyId, companyId))
    .orderBy(asc(prospectPeople.createdAt), asc(prospectPeople.id));
  const pages = await tx
    .select({ id: prospectSnapshots.id, text: prospectSnapshots.text, readAt: prospectSnapshots.readAt })
    .from(prospectSnapshots)
    .where(eq(prospectSnapshots.companyId, companyId))
    .orderBy(asc(prospectSnapshots.readAt), asc(prospectSnapshots.id));
  return { addresses, people, pages };
}

async function addCost(tx: WorkspaceTx, runId: string, costMicros: number, now: Date): Promise<void> {
  if (costMicros <= 0) return;
  await tx
    .update(prospectRuns)
    .set({ verifyCostMicros: sql`${prospectRuns.verifyCostMicros} + ${BigInt(costMicros)}`, updatedAt: now })
    .where(eq(prospectRuns.id, runId));
}

/** Stores one check of an existing address, and what it cost on the run that found the company. */
export async function recordCheck(tx: WorkspaceTx, c: { addressId: string; runId: string; result: string; costMicros: number; at: Date }): Promise<void> {
  await tx.update(prospectAddresses).set({ verificationResult: c.result, verifiedAt: c.at }).where(eq(prospectAddresses.id, c.addressId));
  await addCost(tx, c.runId, c.costMicros, c.at);
}

export type GuessRow = {
  workspaceId: string;
  companyId: string;
  email: string;
  pattern: string;
  name: string;
  role: string | null;
  snapshotId: string;
  readAt: Date;
  noticeFound: boolean;
  leftOutReason: string | null;
  verificationResult: string | null;
};

/**
 * Stores a guess once, or the new answer for a guess stored as unknown. False when the same address
 * is already there with an answer, which also keeps its cost off the run.
 */
export async function recordGuess(tx: WorkspaceTx, g: GuessRow, c: { runId: string; costMicros: number; at: Date }): Promise<boolean> {
  const verifiedAt = g.verificationResult === null ? null : c.at;
  const added = await tx
    .insert(prospectAddresses)
    .values({ ...g, kind: "named", source: "guessed", verifiedAt, createdAt: c.at })
    .onConflictDoUpdate({
      target: [prospectAddresses.workspaceId, prospectAddresses.companyId, prospectAddresses.email],
      set: { verificationResult: g.verificationResult, leftOutReason: g.leftOutReason, verifiedAt },
      setWhere: and(eq(prospectAddresses.source, "guessed"), eq(prospectAddresses.verificationResult, "unknown")),
    })
    .returning({ id: prospectAddresses.id });
  if (added.length) await addCost(tx, c.runId, c.costMicros, c.at);
  return added.length > 0;
}

/** Kept addresses of accepted companies among these ids, with the run that pays for a fresh check. */
export async function keptAddresses(tx: WorkspaceTx, ids: string[]) {
  if (!ids.length) return [];
  return tx
    .select({ id: prospectAddresses.id, email: prospectAddresses.email, result: prospectAddresses.verificationResult, verifiedAt: prospectAddresses.verifiedAt, runId: prospectCompanies.firstRunId })
    .from(prospectAddresses)
    .innerJoin(prospectCompanies, and(eq(prospectCompanies.workspaceId, prospectAddresses.workspaceId), eq(prospectCompanies.id, prospectAddresses.companyId)))
    .where(and(inArray(prospectAddresses.id, ids), isNull(prospectAddresses.leftOutReason), eq(prospectCompanies.state, "accepted")));
}
