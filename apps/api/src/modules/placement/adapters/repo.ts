// SPDX-License-Identifier: AGPL-3.0-only
// Every placement SQL statement. An answer is never changed or removed; a stop is the only later write.
import { and, count, desc, eq, gte, inArray, isNotNull, isNull, lt, lte, ne, notInArray, or, sql } from "drizzle-orm";
import { withWorkspace, type WorkspaceTx } from "@direx/db";
import { actions, approvals, credentials } from "@direx/db/schema";
import { campaignSteps } from "@direx/db/schema-campaigns";
import { placementContentTests, placementGrants, placementListState, placementProbes } from "@direx/db/schema-placement";

export type PlacementTx = WorkspaceTx;
export type GrantRow = typeof placementGrants.$inferSelect;
export type ContentTestRow = typeof placementContentTests.$inferSelect;
export type ListStateRow = typeof placementListState.$inferSelect;
export type ProbeRow = typeof placementProbes.$inferSelect;

export const inWorkspace = <T>(workspaceId: string, fn: (tx: PlacementTx) => Promise<T>) => withWorkspace(workspaceId, fn);

/** The newest answer for this Mailbox, the one that counts. */
export async function currentGrant(tx: PlacementTx, credentialId: string): Promise<GrantRow | undefined> {
  const [row] = await tx.select().from(placementGrants).where(eq(placementGrants.credentialId, credentialId)).orderBy(desc(placementGrants.seq)).limit(1);
  return row;
}

export async function grantById(tx: PlacementTx, id: string): Promise<GrantRow | undefined> {
  const [row] = await tx.select().from(placementGrants).where(eq(placementGrants.id, id)).limit(1);
  return row;
}

export async function insertGrant(tx: PlacementTx, g: Pick<GrantRow, "workspaceId" | "credentialId" | "answer" | "wordingVersion" | "answeredBy" | "answeredAt">): Promise<GrantRow> {
  const [row] = await tx.insert(placementGrants).values(g).returning();
  return row!;
}

/** Stops a yes not already stopped; undefined when there was none to stop. */
export async function stopGrant(tx: PlacementTx, id: string, s: { stoppedBy: string | null; stoppedAt: Date; stopReason: string }): Promise<GrantRow | undefined> {
  const [row] = await tx
    .update(placementGrants)
    .set(s)
    .where(and(eq(placementGrants.id, id), eq(placementGrants.answer, "yes"), isNull(placementGrants.stoppedAt)))
    .returning();
  return row;
}

export async function insertContentTest(tx: PlacementTx, t: Pick<ContentTestRow, "workspaceId" | "campaignId" | "stepKey" | "receivers" | "wordingVersion" | "saidBy" | "saidAt">): Promise<ContentTestRow> {
  const [row] = await tx.insert(placementContentTests).values(t).returning();
  return row!;
}

/** The newest yes for one Campaign step, the one that counts. */
export async function currentContentTest(tx: PlacementTx, campaignId: string, stepKey: string): Promise<ContentTestRow | undefined> {
  const [row] = await tx
    .select()
    .from(placementContentTests)
    .where(and(eq(placementContentTests.campaignId, campaignId), eq(placementContentTests.stepKey, stepKey)))
    .orderBy(desc(placementContentTests.seq))
    .limit(1);
  return row;
}

export async function contentTestById(tx: PlacementTx, id: string): Promise<ContentTestRow | undefined> {
  const [row] = await tx.select().from(placementContentTests).where(eq(placementContentTests.id, id)).limit(1);
  return row;
}

/** A step a content test may render: an email step written as one template, not cancelled. */
export async function isTemplateStep(tx: PlacementTx, campaignId: string, stepKey: string): Promise<boolean> {
  const [row] = await tx
    .select({ stepKey: campaignSteps.stepKey })
    .from(campaignSteps)
    .where(and(eq(campaignSteps.campaignId, campaignId), eq(campaignSteps.stepKey, stepKey), eq(campaignSteps.type, "email"), eq(campaignSteps.draftingMode, "template"), isNull(campaignSteps.cancelledAt)))
    .limit(1);
  return !!row;
}

/** The Workspace's newest content test yes, whatever its step. */
export async function newestContentTest(tx: PlacementTx): Promise<ContentTestRow | undefined> {
  const [row] = await tx.select().from(placementContentTests).orderBy(desc(placementContentTests.seq)).limit(1);
  return row;
}

/** Whether this address signs in to a Mailbox connected in this Workspace and not removed. */
export async function isOwnMailbox(tx: PlacementTx, address: string): Promise<boolean> {
  // ponytail: matches any connected credential by its sign-in address; narrow to mail connections if a non-mail credential ever carries an email address.
  const [row] = await tx
    .select({ id: credentials.id })
    .from(credentials)
    .where(and(isNull(credentials.deletedAt), sql`${credentials.connection} is not null`, sql`lower(trim(coalesce(${credentials.meta}->>'username', ${credentials.key}))) = ${address}`))
    .limit(1);
  return !!row;
}

/** The member list this Workspace last trusted, if any. */
export async function listState(tx: PlacementTx): Promise<ListStateRow | undefined> {
  const [row] = await tx.select().from(placementListState).limit(1);
  return row;
}

/** Records a newly trusted list; never moves the Workspace back to a lower version, unless the release pinned another root. */
export async function saveListState(tx: PlacementTx, s: ListStateRow): Promise<void> {
  await tx
    .insert(placementListState)
    .values(s)
    .onConflictDoUpdate({ target: placementListState.workspaceId, set: { version: s.version, contentHash: s.contentHash, list: s.list, rootChainLength: s.rootChainLength, rootChainHash: s.rootChainHash, pinnedRootHash: s.pinnedRootHash, trustedAt: s.trustedAt }, setWhere: or(lte(placementListState.version, s.version), ne(placementListState.pinnedRootHash, s.pinnedRootHash)) });
}

type ProbeKey = Pick<ProbeRow, "credentialId" | "direction" | "day" | "peer" | "kind">;

export async function probeRow(tx: PlacementTx, k: ProbeKey): Promise<ProbeRow | undefined> {
  const [row] = await tx
    .select()
    .from(placementProbes)
    .where(and(eq(placementProbes.credentialId, k.credentialId), eq(placementProbes.direction, k.direction), eq(placementProbes.day, k.day), eq(placementProbes.peer, k.peer), eq(placementProbes.kind, k.kind)));
  return row;
}

export async function insertProbe(tx: PlacementTx, p: typeof placementProbes.$inferInsert): Promise<ProbeRow> {
  const [row] = await tx.insert(placementProbes).values(p).returning();
  return row!;
}

/** How many checks this Mailbox has made Actions for: on one day, or to one peer of one kind since a day. */
export async function checksMade(tx: PlacementTx, credentialId: string, a: { day: string } | { since: string; peer: string; kind: string }): Promise<number> {
  const when = "day" in a ? eq(placementProbes.day, a.day) : and(gte(placementProbes.day, a.since), eq(placementProbes.peer, a.peer), eq(placementProbes.kind, a.kind));
  const [row] = await tx
    .select({ n: count() })
    .from(placementProbes)
    .where(and(eq(placementProbes.credentialId, credentialId), eq(placementProbes.direction, "send"), isNotNull(placementProbes.actionId), when));
  return row?.n ?? 0;
}

export async function probeByAction(tx: PlacementTx, actionId: string): Promise<ProbeRow | undefined> {
  const [row] = await tx.select().from(placementProbes).where(and(eq(placementProbes.actionId, actionId), eq(placementProbes.direction, "send")));
  return row;
}

/** Whether the Action's live approval binds a snapshot entry of this kind. */
export async function approvalBinds(tx: PlacementTx, actionId: string, kind: string): Promise<boolean> {
  const [row] = await tx.select({ snapshot: approvals.snapshot }).from(approvals).where(and(eq(approvals.actionId, actionId), isNull(approvals.voidedAt)));
  return Array.isArray(row?.snapshot) && (row.snapshot as { kind?: unknown }[]).some((e) => e.kind === kind);
}

/** Sent checks expected before `before` that have not gone out or been recorded as not sent, with their Action's state. */
export async function lateChecks(tx: PlacementTx, before: Date): Promise<{ id: string; actionId: string; state: string; holdReason: string | null }[]> {
  const rows = await tx
    .select({ id: placementProbes.id, actionId: actions.id, state: actions.state, holdReason: actions.holdReason })
    .from(placementProbes)
    .innerJoin(actions, eq(actions.id, placementProbes.actionId))
    .where(and(eq(placementProbes.direction, "send"), isNull(placementProbes.skipReason), lt(placementProbes.expectedAt, before), notInArray(actions.state, ["sent", "dispatching"])));
  return rows;
}

export async function markNotSent(tx: PlacementTx, id: string, reason: string): Promise<void> {
  await tx.update(placementProbes).set({ skipReason: reason }).where(and(eq(placementProbes.id, id), isNull(placementProbes.skipReason)));
}

/** Placement Actions whose outcome is unknown: a check, a report, a join or an archive that may have gone out. */
export async function unknownPlacement(tx: PlacementTx): Promise<{ id: string; capability: string }[]> {
  return tx
    .select({ id: actions.id, capability: actions.capability })
    .from(actions)
    .where(and(eq(actions.state, "held"), eq(actions.holdReason, "outcome_unknown"), sql`${actions.capability} ~ '/placement\\.(send|report|join|archive)$'`));
}

/** Records a sent check whose Action was given up on as unknown. */
export async function markUnknown(tx: PlacementTx, actionId: string): Promise<void> {
  await tx
    .update(placementProbes)
    .set({ skipReason: "unknown_outcome" })
    .where(and(eq(placementProbes.actionId, actionId), eq(placementProbes.direction, "send"), isNull(placementProbes.skipReason)));
}

/** Checks this Mailbox expects with an expected time in the range, not skipped. */
export async function expectedChecks(tx: PlacementTx, credentialId: string, from: Date, to: Date): Promise<ProbeRow[]> {
  return tx
    .select()
    .from(placementProbes)
    .where(and(eq(placementProbes.credentialId, credentialId), eq(placementProbes.direction, "receive"), isNull(placementProbes.skipReason), gte(placementProbes.expectedAt, from), lte(placementProbes.expectedAt, to)));
}

/** Expected checks of the Workspace due to be read: expected before `before`, not read, not skipped. */
export async function dueReads(tx: PlacementTx, before: Date): Promise<ProbeRow[]> {
  return tx
    .select()
    .from(placementProbes)
    .where(and(eq(placementProbes.direction, "receive"), isNull(placementProbes.skipReason), isNull(placementProbes.verdict), lte(placementProbes.expectedAt, before)))
    .orderBy(placementProbes.expectedAt);
}

/** Content checks from one sender this Mailbox found, in the inbox or spam, since a day. */
export async function contentFound(tx: PlacementTx, credentialId: string, peer: string, since: string): Promise<number> {
  const [row] = await tx
    .select({ n: count() })
    .from(placementProbes)
    .where(
      and(
        eq(placementProbes.credentialId, credentialId),
        eq(placementProbes.direction, "receive"),
        eq(placementProbes.kind, "content"),
        eq(placementProbes.peer, peer),
        gte(placementProbes.day, since),
        sql`${placementProbes.verdict} in ('primary', 'other_tab', 'spam')`,
      ),
    );
  return row?.n ?? 0;
}

/** Records an expected check's verdict once. */
export async function recordVerdict(tx: PlacementTx, id: string, v: Pick<ProbeRow, "verdict" | "readAt" | "messageId">): Promise<ProbeRow | undefined> {
  const [row] = await tx
    .update(placementProbes)
    .set(v)
    .where(and(eq(placementProbes.id, id), isNull(placementProbes.verdict)))
    .returning();
  return row;
}

export async function probeById(tx: PlacementTx, id: string): Promise<ProbeRow | undefined> {
  const [row] = await tx.select().from(placementProbes).where(eq(placementProbes.id, id));
  return row;
}

export async function recordArchive(tx: PlacementTx, id: string, actionId: string): Promise<void> {
  await tx
    .update(placementProbes)
    .set({ archiveActionId: actionId })
    .where(and(eq(placementProbes.id, id), isNull(placementProbes.archiveActionId)));
}

export async function probeByArchive(tx: PlacementTx, actionId: string): Promise<ProbeRow | undefined> {
  const [row] = await tx.select().from(placementProbes).where(eq(placementProbes.archiveActionId, actionId));
  return row;
}

/** Expected checks of this Mailbox read and not yet reported to their sender, oldest first: a missing one, or one found with its Message-ID. */
export async function unreported(tx: PlacementTx, credentialId: string): Promise<ProbeRow[]> {
  return tx
    .select()
    .from(placementProbes)
    .where(
      and(
        eq(placementProbes.credentialId, credentialId),
        eq(placementProbes.direction, "receive"),
        isNull(placementProbes.skipReason),
        isNull(placementProbes.reportActionId),
        or(eq(placementProbes.verdict, "missing"), and(ne(placementProbes.verdict, "query_failure"), isNotNull(placementProbes.messageId))),
      ),
    )
    .orderBy(placementProbes.day, placementProbes.expectedAt);
}

/** Names the report Action on the expected checks it carries. */
export async function recordReport(tx: PlacementTx, ids: string[], actionId: string): Promise<void> {
  if (!ids.length) return;
  await tx
    .update(placementProbes)
    .set({ reportActionId: actionId })
    .where(and(inArray(placementProbes.id, ids), isNull(placementProbes.reportActionId)));
}

/** The idempotency key of one Mailbox's report to one sender on one day; its prefix counts the day's reports. */
export const reportKey = (credentialId: string, day: string, sender = "") => `placement_report:${credentialId}:${day}:${sender}`;

/** How many reports this Mailbox made Actions for on one day. */
export async function reportsMade(tx: PlacementTx, credentialId: string, day: string): Promise<number> {
  const [row] = await tx
    .select({ n: count() })
    .from(actions)
    .where(sql`${actions.idempotencyKey} like ${`${reportKey(credentialId, day)}%`}`);
  return row?.n ?? 0;
}

/** Whether a report Action carries checks this Mailbox expected. */
export async function isReportOf(tx: PlacementTx, actionId: string, credentialId: string | null): Promise<boolean> {
  if (!credentialId) return false;
  const [row] = await tx
    .select({ id: placementProbes.id })
    .from(placementProbes)
    .where(and(eq(placementProbes.reportActionId, actionId), eq(placementProbes.credentialId, credentialId), eq(placementProbes.direction, "receive")))
    .limit(1);
  return !!row;
}

/**
 * Counts one report entry, once, on the check of its kind this Mailbox sent to `receiver` that day under
 * that list version, not skipped and not counted before. An entry with a Message-ID counts on the check
 * whose Action read back that Message-ID; a missing entry has none and counts on the check whose Action
 * was sent. The once key makes that one check at most. Whether it counted.
 */
export async function countReported(tx: PlacementTx, credentialId: string, receiver: string, e: { list_version: number; day: string; kind: string; message_id: string | null; verdict: string }, at: Date): Promise<boolean> {
  if (!e.message_id && e.verdict !== "missing") return false;
  const rows = await tx
    .update(placementProbes)
    .set({ reportedVerdict: e.verdict, reportedAt: at, ...(e.message_id ? { messageId: e.message_id } : {}) })
    .from(actions)
    .where(
      and(
        eq(actions.id, placementProbes.actionId),
        e.message_id ? eq(actions.correlationKey, e.message_id) : eq(actions.state, "sent"),
        sql`${actions.capability} like '%/placement.send'`,
        eq(placementProbes.credentialId, credentialId),
        eq(placementProbes.direction, "send"),
        eq(placementProbes.peer, receiver),
        eq(placementProbes.day, e.day),
        eq(placementProbes.listVersion, e.list_version),
        eq(placementProbes.kind, e.kind),
        isNull(placementProbes.skipReason),
        isNull(placementProbes.reportedAt),
      ),
    )
    .returning({ id: placementProbes.id });
  return rows.length > 0;
}

/** This Mailbox's sent checks, counted by ISO week, kind and the verdict reported for them (null when none is counted yet). */
export async function sentByWeek(tx: PlacementTx, credentialId: string): Promise<{ week: string; kind: string; verdict: string | null; n: number }[]> {
  const week = sql<string>`to_char(${placementProbes.day}, 'IYYY-"W"IW')`;
  return tx
    .select({ week, kind: placementProbes.kind, verdict: placementProbes.reportedVerdict, n: count() })
    .from(placementProbes)
    .innerJoin(actions, eq(actions.id, placementProbes.actionId))
    .where(and(eq(placementProbes.credentialId, credentialId), eq(placementProbes.direction, "send"), isNull(placementProbes.skipReason), eq(actions.state, "sent")))
    .groupBy(week, placementProbes.kind, placementProbes.reportedVerdict);
}

/** What this Mailbox reported to senders, newest first: each check a report carried, with that report's state. */
export async function reportsSent(tx: PlacementTx, credentialId: string, limit: number) {
  return tx
    .select({ sender: placementProbes.peer, day: placementProbes.day, kind: placementProbes.kind, verdict: placementProbes.verdict, state: actions.state, holdReason: actions.holdReason, at: actions.updatedAt })
    .from(placementProbes)
    .innerJoin(actions, eq(actions.id, placementProbes.reportActionId))
    .where(and(eq(placementProbes.credentialId, credentialId), eq(placementProbes.direction, "receive")))
    .orderBy(desc(placementProbes.day), placementProbes.peer, placementProbes.kind)
    .limit(limit);
}
