// SPDX-License-Identifier: AGPL-3.0-only
// Every standing-rules SQL statement.
import { withSystem, withWorkspace, type WorkspaceTx } from "@direx/db";
import { actions, approvals, items } from "@direx/db/schema";
import { standingRuleRevisions, standingRules, standingRuleUses } from "@direx/db/schema-rules";
import { and, desc, eq, inArray, isNull, sql } from "drizzle-orm";

export type RulesTx = WorkspaceTx;
export type RuleRow = typeof standingRules.$inferSelect;
export const inWorkspace = <T>(workspaceId: string, fn: (tx: RulesTx) => Promise<T>) => withWorkspace(workspaceId, fn);

export const readRule = async (tx: RulesTx, id: string) => (await tx.select().from(standingRules).where(eq(standingRules.id, id)))[0];
export const lockRule = async (tx: RulesTx, id: string) => (await tx.select().from(standingRules).where(eq(standingRules.id, id)).for("no key update"))[0];
export const listRules = (tx: RulesTx) => tx.select().from(standingRules).orderBy(desc(standingRules.grantedAt));
export const activeRulesForStep = (tx: RulesTx, campaignId: string, stepKey: string) =>
  tx.select().from(standingRules).where(and(eq(standingRules.campaignId, campaignId), eq(standingRules.stepKey, stepKey), eq(standingRules.status, "active")));

/** Held to the end of the transaction, so two people granting at once can't both see an empty step. */
export async function lockStepRules(tx: RulesTx, campaignId: string, stepKey: string) {
  await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`standing_rules:${campaignId}:${stepKey}`}, 0))`);
}

export async function insertRule(tx: RulesTx, values: typeof standingRules.$inferInsert) {
  const [row] = await tx.insert(standingRules).values(values).returning();
  return row!;
}
export async function updateRule(tx: RulesTx, id: string, set: Partial<typeof standingRules.$inferInsert>) {
  const [row] = await tx.update(standingRules).set(set).where(eq(standingRules.id, id)).returning();
  return row!;
}

export type RuleActor = { userId: string } | { system: string };
export async function insertRevision(tx: RulesTx, rule: RuleRow, change: "grant" | "reconfirm" | "suspend" | "revoke", actor: RuleActor, reason: string | null, at: Date) {
  await tx.insert(standingRuleRevisions).values({
    workspaceId: rule.workspaceId,
    ruleId: rule.id,
    revision: rule.revision,
    change,
    reason,
    facts: rule.facts,
    capabilityHash: rule.capabilityHash,
    templateRevision: rule.templateRevision,
    producer: rule.producer,
    actorUserId: "userId" in actor ? actor.userId : null,
    actorSystem: "system" in actor ? actor.system : null,
    at,
  });
}

/** Who stopped a rule and why, from its revoke revision. */
export const stopOf = async (tx: RulesTx, ruleId: string) =>
  (await tx.select({ by: standingRuleRevisions.actorUserId, reason: standingRuleRevisions.reason }).from(standingRuleRevisions).where(and(eq(standingRuleRevisions.ruleId, ruleId), eq(standingRuleRevisions.change, "revoke"))).orderBy(desc(standingRuleRevisions.at)).limit(1))[0];

export const revisionsOf = (tx: RulesTx, ruleId: string) => tx.select().from(standingRuleRevisions).where(eq(standingRuleRevisions.ruleId, ruleId));

export const usesOn = async (tx: RulesTx, ruleId: string, day: string) =>
  (await tx.select({ n: sql<number>`count(*)::int` }).from(standingRuleUses).where(and(eq(standingRuleUses.ruleId, ruleId), eq(standingRuleUses.day, day))))[0]!.n;
export const totalUses = async (tx: RulesTx, ruleId: string) =>
  (await tx.select({ n: sql<number>`count(*)::int` }).from(standingRuleUses).where(eq(standingRuleUses.ruleId, ruleId)))[0]!.n;
export const hasUse = async (tx: RulesTx, ruleId: string, actionId: string) =>
  (await tx.select({ id: standingRuleUses.id }).from(standingRuleUses).where(and(eq(standingRuleUses.ruleId, ruleId), eq(standingRuleUses.actionId, actionId)))).length > 0;
export async function insertUse(tx: RulesTx, a: { workspaceId: string; ruleId: string; actionId: string; day: string; at: Date }) {
  await tx.insert(standingRuleUses).values(a).onConflictDoNothing();
}
export async function deleteUse(tx: RulesTx, ruleId: string, actionId: string) {
  await tx.delete(standingRuleUses).where(and(eq(standingRuleUses.ruleId, ruleId), eq(standingRuleUses.actionId, actionId)));
}

const ACTION_ITEM = {
  itemId: items.id,
  actionId: actions.id,
  state: actions.state,
  capability: actions.capability,
  dedupe: actions.dedupeClass,
  spec: actions.spec,
  draftVersion: actions.draftVersion,
  snapshot: items.snapshot,
  warnings: items.warnings,
  plannedAt: items.plannedAt,
  describedDraftVersion: items.describedDraftVersion,
  ruleNote: items.ruleNote,
};
const fromItems = (tx: RulesTx) => tx.select(ACTION_ITEM).from(items).innerJoin(actions, and(eq(actions.workspaceId, items.workspaceId), eq(actions.id, items.actionId)));
export type ActionItem = Awaited<ReturnType<ReturnType<typeof fromItems>["where"]>>[number];

export const actionItemByItem = async (tx: RulesTx, itemId: string) => (await fromItems(tx).where(eq(items.id, itemId)))[0];
export const actionItemByAction = async (tx: RulesTx, actionId: string) => (await fromItems(tx).where(eq(actions.id, actionId)))[0];
export const waitingAmong = (tx: RulesTx, actionIds: string[]) => (actionIds.length ? fromItems(tx).where(and(inArray(actions.id, actionIds), eq(actions.state, "needs_approval"))) : Promise.resolve([]));

/** Actions among these with a live approval a person made, which is the evidence a rule is granted on. */
export const approvedByAPerson = (tx: RulesTx, actionIds: string[]) =>
  actionIds.length
    ? fromItems(tx)
        .innerJoin(approvals, and(eq(approvals.workspaceId, actions.workspaceId), eq(approvals.actionId, actions.id)))
        .where(and(inArray(actions.id, actionIds), isNull(approvals.voidedAt), isNull(approvals.standingRuleId)))
    : Promise.resolve([]);

export const offerFor = async (tx: RulesTx, kind: string, campaignId: string, stepKey: string, revision: number) =>
  (
    await tx
      .select({ id: items.id })
      .from(items)
      .where(and(eq(items.kind, kind), sql`${items.payload}->>'campaignId' = ${campaignId}`, sql`${items.payload}->>'stepKey' = ${stepKey}`, sql`(${items.payload}->>'templateRevision')::int = ${revision}`))
      .limit(1)
  )[0];

/** The rule behind an Action's live approval, for its history. */
export const liveRuleGranter = async (tx: RulesTx, actionId: string) =>
  (
    await tx
      .select({ grantedBy: standingRules.grantedBy, mode: standingRules.mode, producer: standingRules.producer })
      .from(approvals)
      .innerJoin(standingRules, eq(standingRules.id, approvals.standingRuleId))
      .where(and(eq(approvals.actionId, actionId), isNull(approvals.voidedAt)))
  )[0];

/** A rule's chosen time for an Item it is about to approve. Any earlier note no longer applies. */
export async function setRuleSlot(tx: RulesTx, itemId: string, plannedAt: Date) {
  await tx.update(items).set({ plannedAt, ruleNote: null }).where(eq(items.id, itemId));
}

export async function activeRuleSteps(): Promise<{ workspaceId: string; campaignId: string; stepKey: string }[]> {
  const { rows } = await withSystem((tx) => tx.execute(sql`select workspace_id, campaign_id, step_key from system.active_rule_steps()`));
  return rows.map((r) => ({ workspaceId: r.workspace_id as string, campaignId: r.campaign_id as string, stepKey: r.step_key as string }));
}

export async function setRuleNote(tx: RulesTx, itemId: string, note: string | null) {
  await tx.update(items).set({ ruleNote: note }).where(eq(items.id, itemId));
}
