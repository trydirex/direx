// SPDX-License-Identifier: AGPL-3.0-only
// Every items SQL statement. An Action's state is joined from actions and never written
// here; only a non-Action Item's own state changes in this file.
import { and, asc, count, desc, eq, inArray, isNotNull, isNull, ne, or, sql, type SQL } from "drizzle-orm";
import { withWorkspace, type WorkspaceTx } from "@direx/db";
import { actions, factVersions, facts as factsTable, itemEvents, items, reviewDecisions } from "@direx/db/schema";
import { agentProposals, agentRunParts, agentRuns } from "@direx/db/schema-agents";
import { agentLessonVersions, agentRunLessons } from "@direx/db/schema-lessons";
import type { Actor } from "../../ledger";
import { orderOf, type ListOrder, type ListPoint } from "../domain/list-cursor";
import type { LedgerState, OwnState, VisibleState } from "../domain/state";
import type { Warning } from "../domain/warnings";

export type ItemsTx = WorkspaceTx;
export type ItemRow = typeof items.$inferSelect;
export type ItemEventRow = typeof itemEvents.$inferSelect;
export type JoinedAction = {
  capability: string;
  credentialId: string | null;
  idempotencyKey: string;
  state: LedgerState;
  holdReason: string | null;
  blockReason: string | null;
  reasonDetail: string | null;
  draftVersion: number;
  dueAt: Date | null;
  nextAttemptAt: Date | null;
  decideBy: Date | null;
  snoozedUntil: Date | null;
};
export type JoinedItem = { item: ItemRow; action: JoinedAction | null };

export const inWorkspace = <T>(workspaceId: string, fn: (tx: ItemsTx) => Promise<T>) => withWorkspace(workspaceId, fn);

const JOINED = {
  item: items,
  action: {
    capability: actions.capability,
    credentialId: actions.credentialId,
    idempotencyKey: actions.idempotencyKey,
    state: actions.state,
    holdReason: actions.holdReason,
    blockReason: actions.blockReason,
    reasonDetail: actions.reasonDetail,
    draftVersion: actions.draftVersion,
    dueAt: actions.dueAt,
    nextAttemptAt: actions.nextAttemptAt,
    decideBy: actions.decideBy,
    snoozedUntil: actions.snoozedUntil,
  },
};
const onAction = and(eq(actions.workspaceId, items.workspaceId), eq(actions.id, items.actionId));
const rawState = sql`coalesce(${actions.state}, ${items.state})`;
const timeShown = sql`coalesce(${actions.dueAt}, ${items.plannedAt})`;
const decideBy = sql`coalesce(${actions.decideBy}, ${items.decideBy})`;
const snoozedUntil = sql`coalesce(${actions.snoozedUntil}, ${items.snoozedUntil})`;

/** Needs you: what only a person can move on, unless they snoozed it. A pending retry isn't theirs yet. */
const needsYou = (now: Date) =>
  and(
    or(sql`${rawState} = 'needs_approval'`, and(eq(actions.state, "held"), sql`${actions.nextAttemptAt} is null`)),
    sql`(${snoozedUntil} is null or ${snoozedUntil} <= ${now.toISOString()}::timestamptz)`,
  );

const RAW: Record<VisibleState, string[]> = {
  draft: ["draft"],
  needs_approval: ["needs_approval"],
  scheduled: ["scheduled", "claimed", "dispatching"],
  sent: ["sent"],
  applied: ["applied"],
  held: ["held"],
  blocked: ["blocked"],
  cancelled: ["cancelled"],
};

/**
 * Filters combine; a list matches any of its values. `types` are what the web names a row by: the
 * work area of an Action, the kind of anything else. `campaign` is a Campaign id; `q` matches the
 * title or group label as plain text. `after` is the point the last page ended at, from
 * `parseListCursor` for this filter's order.
 */
export type ListFilter = {
  needsYou?: boolean;
  state?: VisibleState | VisibleState[];
  channels?: string[];
  types?: string[];
  campaign?: string;
  q?: string;
  from?: Date;
  to?: Date;
  after?: ListPoint;
  limit: number;
  now: Date;
};

/** `text` for a LIKE pattern, with LIKE's own characters taken literally. */
const literal = (text: string) => text.replace(/[\\%_]/g, (m) => `\\${m}`);
const anyOf = (values: string[]) => sql.join(values.map((v) => sql`${v}`), sql`, `);

/** A time as the list cursor keeps it: UTC, to the microsecond. */
const exact = (t: SQL) => sql<string | null>`to_char(${t} at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;
const deadline = sql`coalesce(${decideBy}, 'infinity'::timestamptz)`;
const madeAt = sql`${items.createdAt}`;
const ts = (k: string | null | undefined) => sql`${k ?? null}::timestamptz`;

/**
 * Each order's sort, the key a cursor keeps (`k0`, `k1`), and the rows strictly after a point. One
 * row comparison per order, so a row that changes state never shifts the rows behind it.
 */
const ORDERS: Record<ListOrder, { by: SQL[]; k0: SQL; k1: SQL; after: (p: ListPoint) => SQL }> = {
  // A missing deadline sorts last, as "nulls last" did, inside one comparison.
  needs_you: {
    by: [sql`${deadline} asc`, sql`${madeAt} asc`, sql`${items.id} asc`],
    k0: exact(decideBy),
    k1: exact(madeAt),
    after: (p) => sql`(${deadline}, ${madeAt}, ${items.id}) > (coalesce(${ts(p.key[0])}, 'infinity'::timestamptz), ${ts(p.key[1])}, ${p.id}::uuid)`,
  },
  time: { by: [sql`${timeShown} asc`, sql`${items.id} asc`], k0: exact(timeShown), k1: sql`null`, after: (p) => sql`(${timeShown}, ${items.id}) > (${ts(p.key[0])}, ${p.id}::uuid)` },
  newest: { by: [sql`${madeAt} desc`, sql`${items.id} desc`], k0: exact(madeAt), k1: sql`null`, after: (p) => sql`(${madeAt}, ${items.id}) < (${ts(p.key[0])}, ${p.id}::uuid)` },
};

/**
 * One page of Items and the point it ended at, null on a short page.
 * ponytail: joins actions for the state, fine for a Workspace's few thousand Items; add a partial
 * index on open states when a real Workspace is slow.
 */
export async function listItems(tx: ItemsTx, f: ListFilter): Promise<{ rows: JoinedItem[]; needsYouCount: number; next: ListPoint | null }> {
  const order = orderOf(f);
  const o = ORDERS[order];
  const where: (SQL | undefined)[] = [];
  if (f.needsYou) where.push(needsYou(f.now));
  const states = [f.state ?? []].flat();
  if (states.length) where.push(sql`${rawState} in (${anyOf(states.flatMap((s) => RAW[s]))})`);
  if (f.channels?.length) where.push(sql`${items.channel} in (${anyOf(f.channels)})`);
  if (f.types?.length) where.push(sql`(case when ${items.kind} = 'action' then ${items.workArea} else ${items.kind} end) in (${anyOf(f.types)})`);
  if (f.campaign) where.push(or(eq(items.groupKey, `campaign:${f.campaign}`), sql`${items.groupKey} like ${`${literal(`campaign:${f.campaign}:`)}%`}`));
  if (f.q) where.push(or(sql`${items.title} ilike ${`%${literal(f.q)}%`}`, sql`${items.groupLabel} ilike ${`%${literal(f.q)}%`}`));
  if (f.from) where.push(sql`${timeShown} >= ${f.from.toISOString()}::timestamptz`);
  if (f.to) where.push(sql`${timeShown} < ${f.to.toISOString()}::timestamptz`);
  if (f.after) where.push(o.after(f.after));
  const rows = await tx
    .select({ ...JOINED, k0: sql<string | null>`${o.k0}`, k1: sql<string | null>`${o.k1}` })
    .from(items)
    .leftJoin(actions, onAction)
    .where(and(...where))
    .orderBy(...o.by)
    .limit(f.limit);
  const [count] = await tx.select({ n: sql<number>`count(*)::int` }).from(items).leftJoin(actions, onAction).where(needsYou(f.now));
  const last = rows.length === f.limit ? rows.at(-1) : undefined;
  const next = last ? { order, key: order === "needs_you" ? [last.k0, last.k1] : [last.k0], id: last.item.id } : null;
  return { rows: rows.map(({ k0: _k0, k1: _k1, ...row }) => row) as JoinedItem[], needsYouCount: count!.n, next };
}

/**
 * How much is in Needs you and its next deadline: the earliest decide-by, or the expiry of an
 * approval still pending (`ttlMs` after it was asked). Postgres's least skips nulls.
 */
export async function needsYouSummary(tx: ItemsTx, now: Date, ttlMs: number): Promise<{ count: number; nextDeadline: Date | null }> {
  const expiry = sql`case when ${actions.state} = 'needs_approval' then ${actions.approvalRequestedAt} + ${ttlMs} * interval '1 millisecond' end`;
  const [r] = await tx
    .select({ n: sql<number>`count(*)::int`, next: sql<string | null>`min(least(${decideBy}, ${expiry}))` })
    .from(items)
    .leftJoin(actions, onAction)
    .where(needsYou(now));
  return { count: r!.n, nextDeadline: r!.next === null ? null : new Date(r!.next) };
}

export async function itemIdByAction(tx: ItemsTx, actionId: string): Promise<string | null> {
  const [row] = await tx.select({ id: items.id }).from(items).where(eq(items.actionId, actionId));
  return row?.id ?? null;
}

export async function readItem(tx: ItemsTx, id: string): Promise<JoinedItem | undefined> {
  const [row] = await tx.select(JOINED).from(items).leftJoin(actions, onAction).where(eq(items.id, id));
  return row as JoinedItem | undefined;
}

/**
 * What a draft was written from, as recorded: the Run whose proposal became this Item, the plan that Run read,
 * and the Facts the Item's snapshot cites at the version it cites. Read only; nothing here binds an approval.
 */
export async function readWrittenFrom(tx: ItemsTx, id: string, cited: { id: string; version: number }[]) {
  const [run] = await tx
    .select({ id: agentRuns.id, agent: agentRuns.agent, at: agentRuns.createdAt, kind: agentProposals.kind })
    .from(agentProposals)
    .innerJoin(agentRuns, and(eq(agentRuns.workspaceId, agentProposals.workspaceId), eq(agentRuns.id, agentProposals.runId)))
    .where(eq(agentProposals.itemId, id))
    .orderBy(desc(agentProposals.at))
    .limit(1);
  const [plan] = run ? await tx.select({ id: agentRunParts.refId }).from(agentRunParts).where(and(eq(agentRunParts.runId, run.id), eq(agentRunParts.kind, "plan"))).limit(1) : [];
  const facts = cited.length
    ? await tx
        .select({ id: factsTable.id, version: factVersions.version, field: factsTable.field, subject: factsTable.subject, value: factVersions.value })
        .from(factVersions)
        .innerJoin(factsTable, and(eq(factsTable.workspaceId, factVersions.workspaceId), eq(factsTable.id, factVersions.factId)))
        .where(or(...cited.map((c) => and(eq(factVersions.factId, c.id), eq(factVersions.version, c.version)))))
    : [];
  // The Lessons the Run was given, at the version it read, and whether it was given the Workspace's Tone.
  const lessons = run
    ? await tx
        .select({ id: agentLessonVersions.lessonId, text: agentLessonVersions.text })
        .from(agentRunLessons)
        .innerJoin(agentLessonVersions, and(eq(agentLessonVersions.workspaceId, agentRunLessons.workspaceId), eq(agentLessonVersions.lessonId, agentRunLessons.lessonId), eq(agentLessonVersions.version, agentRunLessons.version)))
        .where(eq(agentRunLessons.runId, run.id))
    : [];
  // A fact proposal is words Direx read on a page, not written in any voice, so its Tone counts for nothing.
  const [tone] = run && run.kind !== "fact_proposal"
    ? await tx
        .select({ id: factsTable.id })
        .from(agentRunParts)
        .innerJoin(factsTable, sql`${factsTable.id}::text = ${agentRunParts.refId}`)
        .where(and(eq(agentRunParts.runId, run.id), eq(agentRunParts.kind, "fact"), eq(factsTable.field, "tone")))
        .limit(1)
    : [];
  return { run: run ? { id: run.id, agent: run.agent, at: run.at } : null, planId: plan?.id ?? null, facts, lessons, voice: !!tone };
}

export type NewDetails = Pick<typeof items.$inferInsert, "title" | "workArea" | "channel" | "groupKey" | "groupLabel" | "plannedAt"> & {
  warnings: Warning[];
  snapshot?: unknown[];
};

/** Inserts an Action's Item, or returns the one already there, so a retried create heals. */
export async function insertActionItem(tx: ItemsTx, workspaceId: string, actionId: string, draftVersion: number, d: NewDetails, now: Date) {
  const values = { workspaceId, kind: "action", actionId, describedDraftVersion: draftVersion, ...d, createdAt: now, updatedAt: now };
  const [row] = await tx.insert(items).values(values).onConflictDoNothing({ target: [items.workspaceId, items.actionId] }).returning();
  if (row) return row;
  const [existing] = await tx.select().from(items).where(eq(items.actionId, actionId));
  return existing!;
}

export async function updateActionDetails(tx: ItemsTx, actionId: string, draftVersion: number, d: Partial<NewDetails>, now: Date) {
  const [row] = await tx
    .update(items)
    .set({ ...d, describedDraftVersion: draftVersion, updatedAt: now })
    .where(eq(items.actionId, actionId))
    .returning();
  return row;
}

export async function setItemWarnings(tx: ItemsTx, id: string, warnings: Warning[], now: Date) {
  await tx.update(items).set({ warnings, updatedAt: now }).where(eq(items.id, id));
}

export async function reviseOwnContent(tx: ItemsTx, id: string, payload: unknown, d: NewDetails, now: Date) {
  await tx.update(items).set({ payload, ...d, updatedAt: now }).where(eq(items.id, id));
}

/** After a changed snapshot: what the next approval binds, and what the person must read first. */
export async function rebindActionItem(tx: ItemsTx, id: string, snapshot: unknown[], warnings: Warning[], now: Date) {
  await tx.update(items).set({ snapshot, warnings, updatedAt: now }).where(eq(items.id, id));
}

export async function insertOwnItem(
  tx: ItemsTx,
  workspaceId: string,
  a: { kind: string; state: OwnState; payload: unknown } & NewDetails,
  actor: Actor,
  now: Date,
) {
  const [row] = await tx.insert(items).values({ workspaceId, ...a, createdAt: now, updatedAt: now }).returning();
  await appendEvent(tx, row!, null, actor, now);
  return row!;
}

/** Holds one group of non-Action Items for this transaction and returns the ones still waiting, so a replacement leaves exactly one. */
export async function lockLiveGroup(tx: ItemsTx, workspaceId: string, kind: string, groupKey: string): Promise<ItemRow[]> {
  await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`items:${workspaceId}:${kind}:${groupKey}`}, 0))`);
  return tx
    .select()
    .from(items)
    .where(and(eq(items.kind, kind), eq(items.groupKey, groupKey), or(eq(items.state, "draft"), eq(items.state, "needs_approval"))))
    .for("update");
}

export async function lockOwnItem(tx: ItemsTx, id: string): Promise<ItemRow | undefined> {
  const [row] = await tx.select().from(items).where(eq(items.id, id)).for("update");
  return row;
}

/** One more warning on a locked non-Action Item. The version moves, so a decision made without it is refused. */
export async function addOwnWarning(tx: ItemsTx, row: ItemRow, warning: Warning, now: Date) {
  await tx
    .update(items)
    .set({ warnings: [...(row.warnings as Warning[]), warning], version: row.version + 1, updatedAt: now })
    .where(eq(items.id, row.id));
}

/** Moves a locked non-Action Item to a new state, under its version, with one event. */
export async function moveOwnState(tx: ItemsTx, row: ItemRow, state: OwnState, actor: Actor, now: Date): Promise<ItemRow | "stale"> {
  const [next] = await tx
    .update(items)
    .set({ state, version: row.version + 1, updatedAt: now })
    .where(and(eq(items.id, row.id), eq(items.version, row.version)))
    .returning();
  if (!next) return "stale";
  await appendEvent(tx, next, row.state, actor, now);
  return next;
}

async function appendEvent(tx: ItemsTx, row: ItemRow, from: string | null, actor: Actor, now: Date) {
  await tx.insert(itemEvents).values({
    workspaceId: row.workspaceId,
    itemId: row.id,
    fromState: from,
    toState: row.state!,
    version: row.version,
    actorUserId: "userId" in actor ? actor.userId : null,
    actorAgentRunId: "agentRunId" in actor ? actor.agentRunId : null,
    actorSystem: "system" in actor ? actor.system : null,
    at: now,
  });
}

/** A note on an Item's history that changes nothing about it, such as an undo of what applying it did. */
export async function noteEvent(tx: ItemsTx, row: ItemRow, detail: string, actor: Actor, now: Date) {
  await tx.insert(itemEvents).values({
    workspaceId: row.workspaceId,
    itemId: row.id,
    fromState: row.state,
    toState: row.state!,
    detail,
    version: row.version,
    actorUserId: "userId" in actor ? actor.userId : null,
    actorAgentRunId: "agentRunId" in actor ? actor.agentRunId : null,
    actorSystem: "system" in actor ? actor.system : null,
    at: now,
  });
}

export const listItemEvents = (tx: ItemsTx, itemId: string): Promise<ItemEventRow[]> =>
  tx.select().from(itemEvents).where(eq(itemEvents.itemId, itemId)).orderBy(asc(itemEvents.id));

export type NewDecision = typeof reviewDecisions.$inferInsert;
export async function insertDecision(tx: ItemsTx, d: NewDecision) {
  await tx.insert(reviewDecisions).values(d);
}

/** A reviewer's latest decisions, newest first. A rewrite is not a decision on the Item, so it is left out. */
export async function decisionsOf(tx: ItemsTx, reviewerId: string, limit: number) {
  return tx
    .select()
    .from(reviewDecisions)
    .where(and(eq(reviewDecisions.reviewerId, reviewerId), ne(reviewDecisions.decision, "rewrite")))
    .orderBy(desc(reviewDecisions.decidedAt))
    .limit(limit);
}

/** Every reason recorded on one Campaign step's drafts, one per decision that gave one. */
export async function stepReasons(tx: ItemsTx, campaignId: string, stepKey: string): Promise<string[]> {
  const rows = await tx
    .select({ reason: reviewDecisions.reason })
    .from(reviewDecisions)
    .where(and(eq(reviewDecisions.campaignId, campaignId), eq(reviewDecisions.stepKey, stepKey), isNotNull(reviewDecisions.reason)));
  return rows.map((r) => r.reason as string);
}

/** Every edit phrase recorded on one Campaign step's drafts. */
export async function stepEditPhrases(tx: ItemsTx, campaignId: string, stepKey: string): Promise<string[][]> {
  const rows = await tx
    .select({ phrases: reviewDecisions.editPhrases })
    .from(reviewDecisions)
    .where(and(eq(reviewDecisions.campaignId, campaignId), eq(reviewDecisions.stepKey, stepKey)));
  return rows.map((r) => r.phrases);
}

export async function setPlannedAt(tx: ItemsTx, id: string, plannedAt: Date, now: Date) {
  await tx.update(items).set({ plannedAt, updatedAt: now }).where(eq(items.id, id));
}

export async function setOwnTriage(tx: ItemsTx, id: string, t: { decideBy?: Date | null; snoozedUntil?: Date | null }) {
  await tx.update(items).set(t).where(eq(items.id, id));
}


/** This transaction's snapshot: the oldest transaction still running, and the next to start. */
export async function snapshotBounds(tx: ItemsTx): Promise<{ xmin: bigint; xmax: bigint }> {
  const { rows } = await tx.execute(sql`select pg_snapshot_xmin(pg_current_snapshot())::text as xmin, pg_snapshot_xmax(pg_current_snapshot())::text as xmax`);
  const r = rows[0] as { xmin: string; xmax: string };
  return { xmin: BigInt(r.xmin), xmax: BigInt(r.xmax) };
}

/**
 * Item state changes after `after`, from transactions older than `before`, oldest first. A note that
 * changes no state isn't a change, so it is left out.
 */
export function changesAfter(tx: ItemsTx, after: { tx: bigint; id: number }, before: bigint, limit: number) {
  return tx
    .select({ tx: itemEvents.tx, id: itemEvents.id, itemId: itemEvents.itemId, kind: items.kind, from: itemEvents.fromState, to: itemEvents.toState, at: itemEvents.at })
    .from(itemEvents)
    .innerJoin(items, and(eq(items.workspaceId, itemEvents.workspaceId), eq(items.id, itemEvents.itemId)))
    .where(
      and(
        sql`(${itemEvents.tx}, ${itemEvents.id}) > (${after.tx.toString()}::xid8, ${after.id})`,
        sql`${itemEvents.tx} < ${before.toString()}::xid8`,
        sql`${itemEvents.fromState} is distinct from ${itemEvents.toState}`,
      ),
    )
    .orderBy(asc(itemEvents.tx), asc(itemEvents.id))
    .limit(limit);
}

/** How many of these Items still wait for a person, using the ledger state for Actions. */
export async function countWaiting(tx: ItemsTx, itemIds: readonly string[]): Promise<number> {
  if (!itemIds.length) return 0;
  const [r] = await tx
    .select({ n: count() })
    .from(items)
    .leftJoin(actions, onAction)
    .where(and(inArray(items.id, [...itemIds]), sql`${rawState} in ('draft', 'needs_approval')`));
  return r!.n;
}
