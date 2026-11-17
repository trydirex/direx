// SPDX-License-Identifier: AGPL-3.0-only
// Every ledger SQL statement. Only this file writes actions.state or actions.version
// (the claim token), and every write appends one action_events row.
import { and, asc, eq, inArray, isNull, sql } from "drizzle-orm";
import { withWorkspace, type WorkspaceTx } from "@direx/db";
import { touchField } from "@direx/plugin-sdk/host";
import { actionEvents, actions, approvals, workspaces } from "@direx/db/schema";
import { standingRules } from "@direx/db/schema-rules";
import { canTransition, type State } from "../domain/states";

export type LedgerTx = WorkspaceTx;
export type ActionRow = typeof actions.$inferSelect & { state: State };
export type ApprovalRow = typeof approvals.$inferSelect;
export type EventRow = typeof actionEvents.$inferSelect;
/** Exactly one actor per change: a person, an agent run or the system. */
export type Actor = { userId: string } | { agentRunId: string } | { system: string };

/** Application code reaches the database only through this, never @direx/db directly. */
export function inWorkspace<T>(workspaceId: string, fn: (tx: LedgerTx) => Promise<T>): Promise<T> {
  return withWorkspace(workspaceId, fn);
}

export type NewAction = {
  idempotencyKey: string;
  capability: string;
  dedupeClass: ActionRow["dedupeClass"];
  spec: unknown;
  specHash: string;
  credentialId?: string | null;
};

/** Inserts a draft, or returns the existing row for the same idempotency key, so a retry never creates a second effect. */
export async function insertAction(tx: LedgerTx, workspaceId: string, a: NewAction, actor: Actor, now: Date) {
  const [row] = await tx
    .insert(actions)
    .values({ workspaceId, ...a, state: "draft", createdAt: now, updatedAt: now })
    .onConflictDoNothing({ target: [actions.workspaceId, actions.idempotencyKey] })
    .returning();
  if (row) {
    await appendEvent(tx, row as ActionRow, null, actor, now, {});
    return { row: row as ActionRow, created: true };
  }
  const [existing] = await tx.select().from(actions).where(eq(actions.idempotencyKey, a.idempotencyKey));
  return { row: existing as ActionRow, created: false };
}

/** Takes the row with FOR UPDATE (lock order step 3). Undefined when RLS hides it or it is gone. */
export async function lockAction(tx: LedgerTx, id: string): Promise<ActionRow | undefined> {
  const [row] = await tx.select().from(actions).where(eq(actions.id, id)).for("update");
  return row as ActionRow | undefined;
}

export type ActionState = Pick<ActionRow, "id" | "state" | "holdReason" | "capability" | "spec" | "dueAt" | "outcomeUnknownAt">;

/** A plain read, no lock: for other modules that derive their own state from an Action's. */
export async function readActionStates(tx: LedgerTx, ids: readonly string[]): Promise<Map<string, ActionState>> {
  if (!ids.length) return new Map();
  const rows = await tx
    .select({
      id: actions.id,
      state: actions.state,
      holdReason: actions.holdReason,
      capability: actions.capability,
      spec: actions.spec,
      dueAt: actions.dueAt,
      outcomeUnknownAt: actions.outcomeUnknownAt,
    })
    .from(actions)
    .where(inArray(actions.id, [...ids]));
  return new Map(rows.map((r) => [r.id, r as ActionState]));
}

export async function readAction(tx: LedgerTx, id: string): Promise<ActionRow | undefined> {
  const [row] = await tx.select().from(actions).where(eq(actions.id, id));
  return row as ActionRow | undefined;
}

/** Whether this transaction's Workspace was deleted. RLS shows only its own row. */
export async function workspaceDeleted(tx: LedgerTx): Promise<boolean> {
  const [row] = await tx.select({ deletedAt: workspaces.deletedAt }).from(workspaces);
  return !!row?.deletedAt;
}

export type Change = {
  state: State;
  reason?: string;
  detail?: string;
  /** With a refusal over the account's plan: the plan it needs. */
  plan?: string;
  set?: Partial<typeof actions.$inferInsert>;
  dispatchGapMs?: number;
};

/**
 * Moves a locked row to a new state and bumps version, compared against the version the
 * caller read: the claim token. Returns "stale" when another writer won.
 */
export async function transition(
  tx: LedgerTx,
  row: ActionRow,
  change: Change,
  actor: Actor,
  now: Date,
): Promise<ActionRow | "stale"> {
  if (!canTransition(row.state, change.state)) {
    throw new Error(`ledger: ${row.state} -> ${change.state} is not an allowed transition`);
  }
  const [next] = await tx
    .update(actions)
    .set({
      ...change.set,
      state: change.state,
      holdReason: change.state === "held" ? (change.reason ?? null) : null,
      blockReason: change.state === "blocked" ? (change.reason ?? null) : null,
      reasonDetail: change.detail ?? null,
      reasonPlan: change.plan ?? null,
      version: row.version + 1,
      updatedAt: now,
    })
    .where(and(eq(actions.id, row.id), eq(actions.version, row.version)))
    .returning();
  if (!next) return "stale";
  await appendEvent(tx, next as ActionRow, row.state, actor, now, change);
  return next as ActionRow;
}

async function appendEvent(
  tx: LedgerTx,
  row: ActionRow,
  from: State | null,
  actor: Actor,
  now: Date,
  change: Pick<Change, "reason" | "detail" | "dispatchGapMs">,
) {
  await tx.insert(actionEvents).values({
    workspaceId: row.workspaceId,
    actionId: row.id,
    fromState: from,
    toState: row.state,
    reason: change.reason ?? null,
    detail: change.detail ?? null,
    version: row.version,
    dispatchGapMs: change.dispatchGapMs ?? null,
    actorUserId: "userId" in actor ? actor.userId : null,
    actorAgentRunId: "agentRunId" in actor ? actor.agentRunId : null,
    actorSystem: "system" in actor ? actor.system : null,
    at: now,
  });
}

export type Triage = { decideBy?: Date | null; snoozedUntil?: Date | null };

/** Not a state change: no version bump and no event. False when RLS hides the Action or it is gone. */
export async function updateTriage(tx: LedgerTx, id: string, t: Triage): Promise<boolean> {
  const rows = await tx.update(actions).set(t).where(eq(actions.id, id)).returning({ id: actions.id });
  return rows.length > 0;
}

export async function insertApproval(tx: LedgerTx, a: typeof approvals.$inferInsert): Promise<ApprovalRow> {
  const [row] = await tx.insert(approvals).values(a).returning();
  return row!;
}

export async function liveApproval(tx: LedgerTx, actionId: string): Promise<ApprovalRow | undefined> {
  const [row] = await tx
    .select()
    .from(approvals)
    .where(and(eq(approvals.actionId, actionId), isNull(approvals.voidedAt)));
  return row;
}

export async function voidLiveApproval(tx: LedgerTx, actionId: string, now: Date): Promise<void> {
  await tx
    .update(approvals)
    .set({ voidedAt: now })
    .where(and(eq(approvals.actionId, actionId), isNull(approvals.voidedAt)));
}

/** Ids of Actions held because their credential could not be used. */
/** Who granted an active rule. The approver of a rule's approval comes from here, never from a caller. */
export async function activeRuleGranter(tx: LedgerTx, ruleId: string): Promise<string | undefined> {
  const [rule] = await tx.select({ grantedBy: standingRules.grantedBy }).from(standingRules).where(and(eq(standingRules.id, ruleId), eq(standingRules.status, "active")));
  return rule?.grantedBy;
}

export async function heldOnCredential(tx: LedgerTx, credentialId: string): Promise<string[]> {
  const rows = await tx
    .select({ id: actions.id })
    .from(actions)
    .where(and(eq(actions.credentialId, credentialId), eq(actions.state, "held"), eq(actions.holdReason, "credential_unavailable")));
  return rows.map((r) => r.id);
}

/** Actions on this credential in one of `states`, with what each does. */
export async function onCredentialIn(tx: LedgerTx, credentialId: string, states: readonly string[]): Promise<{ id: string; capability: string }[]> {
  return tx
    .select({ id: actions.id, capability: actions.capability })
    .from(actions)
    .where(and(eq(actions.credentialId, credentialId), inArray(actions.state, [...states])));
}

type Touched = { actionId: string; personId: string | null };
const touchOf = (spec: unknown) => touchField(spec, "personId") ?? null;

/**
 * A Mailbox check goes to the Mailbox's own address, and a Placement check to a Circle member's, so
 * mail about either is never a reply or a bounce from a Person.
 */
const notProbe = sql`${actions.capability} not like '%/mailbox.probe' and ${actions.capability} not like '%/placement.%'`;

/** Whether one of these Message-IDs belongs to a placement Action. */
export async function isPlacementMessage(tx: LedgerTx, messageIds: string[]): Promise<boolean> {
  if (!messageIds.length) return false;
  const [row] = await tx
    .select({ id: actions.id })
    .from(actions)
    .where(and(inArray(actions.correlationKey, messageIds), sql`${actions.capability} like '%/placement.%'`))
    .limit(1);
  return !!row;
}

/**
 * Whether Sent mail to these recipients is a placement Action's, found by its dispatch time: its
 * Message-ID is stored only after the send settles, and never when reading it back failed.
 */
export async function isPlacementSend(tx: LedgerTx, recipients: string[], sentAt: Date): Promise<boolean> {
  if (!recipients.length) return false;
  const at = sentAt.toISOString();
  const [row] = await tx
    .select({ id: actions.id })
    .from(actions)
    .where(
      and(
        sql`${actions.capability} like '%/placement.%'`,
        sql`${actions.spec} -> 'to' @> ${JSON.stringify(recipients)}::jsonb`,
        // Gmail stamps the message during the call, between its first dispatch and its last.
        sql`${actions.firstDispatchedAt} <= ${at}::timestamptz + interval '15 minutes'`,
        sql`${actions.dispatchStartedAt} >= ${at}::timestamptz - interval '15 minutes'`,
      ),
    )
    .limit(1);
  return !!row;
}

/** The sent Action one of these Message-IDs belongs to, if any. */
export async function sentByCorrelation(tx: LedgerTx, messageIds: string[]): Promise<Touched | null> {
  if (!messageIds.length) return null;
  const [row] = await tx
    .select({ id: actions.id, spec: actions.spec })
    .from(actions)
    .where(and(inArray(actions.correlationKey, messageIds), notProbe))
    .limit(1);
  return row ? { actionId: row.id, personId: touchOf(row.spec) } : null;
}

/** A sent Action addressed to this email, if any. */
export async function sentTo(tx: LedgerTx, email: string): Promise<Touched | null> {
  const [row] = await tx
    .select({ id: actions.id, spec: actions.spec })
    .from(actions)
    .where(and(eq(actions.state, "sent"), sql`${actions.spec} -> 'to' @> ${JSON.stringify([email])}::jsonb`, notProbe))
    .limit(1);
  return row ? { actionId: row.id, personId: touchOf(row.spec) } : null;
}

/**
 * Whether this is a Mailbox check this Mailbox sent under this subject: its own probe, come back. The
 * subject is random per probe, and a reply's starts with "Re:", so a Person's mail never matches.
 */
export async function isOwnProbe(tx: LedgerTx, credentialId: string, subject: string): Promise<boolean> {
  const [row] = await tx
    .select({ id: actions.id })
    .from(actions)
    .where(
      and(
        eq(actions.credentialId, credentialId),
        sql`${actions.capability} like '%/mailbox.probe'`,
        sql`${actions.spec} ->> 'subject' = ${subject}`,
      ),
    )
    .limit(1);
  return !!row;
}

/** Held Actions for one reason, with the Person each reaches. */
export async function heldFor(tx: LedgerTx, reason: string) {
  const rows = await tx.select({ id: actions.id, spec: actions.spec, credentialId: actions.credentialId }).from(actions).where(and(eq(actions.state, "held"), eq(actions.holdReason, reason)));
  return rows.flatMap((r) => {
    const personId = touchOf(r.spec);
    return personId ? [{ id: r.id, personId, credentialId: r.credentialId, spec: r.spec }] : [];
  });
}

/** Late Actions: how many reach a Person (emails) and how many don't (posts), and the oldest's time. */
export async function lateCounts(tx: LedgerTx): Promise<{ emails: number; posts: number; oldestDueAt: Date | null }> {
  const rows = await tx.select({ spec: actions.spec, dueAt: actions.dueAt }).from(actions).where(and(eq(actions.state, "held"), eq(actions.holdReason, "late")));
  const emails = rows.filter((r) => touchOf(r.spec)).length;
  const oldest = rows.reduce<Date | null>((min, r) => (r.dueAt && (!min || r.dueAt < min) ? r.dueAt : min), null);
  return { emails, posts: rows.length - emails, oldestDueAt: oldest };
}

/** Late Actions that reach a Person, oldest first, for resuming them together. */
export async function lateEmails(tx: LedgerTx): Promise<{ id: string; capability: string }[]> {
  const rows = await tx.select({ id: actions.id, capability: actions.capability, spec: actions.spec }).from(actions).where(and(eq(actions.state, "held"), eq(actions.holdReason, "late"))).orderBy(asc(actions.dueAt));
  return rows.filter((r) => touchOf(r.spec)).map(({ id, capability }) => ({ id, capability }));
}

/** Every Action held for this reason, emails and posts alike, with its capability. */
export function heldIdsFor(tx: LedgerTx, reason: string): Promise<{ id: string; capability: string }[]> {
  return tx.select({ id: actions.id, capability: actions.capability }).from(actions).where(and(eq(actions.state, "held"), eq(actions.holdReason, reason)));
}

/** The ids of this Workspace's Actions in these states. RLS keeps it to the transaction's Workspace. */
export function idsInStates(tx: LedgerTx, states: readonly string[]): Promise<{ id: string }[]> {
  return tx.select({ id: actions.id }).from(actions).where(inArray(actions.state, [...states]));
}

export function listEvents(tx: LedgerTx, actionId: string): Promise<EventRow[]> {
  return tx.select().from(actionEvents).where(eq(actionEvents.actionId, actionId)).orderBy(asc(actionEvents.id));
}
