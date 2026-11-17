// SPDX-License-Identifier: AGPL-3.0-only
// Every SQL statement for the model tables. Spend itself lives in the ledger's reservations.
import { and, count, desc, eq, gte, inArray, isNull, lt, ne, sql } from "drizzle-orm";
import { withWorkspace, type WorkspaceTx } from "@direx/db";
import { agentModelChoiceRevisions, agentModelChoices, budgetReservations, modelBudgetIncidents, modelCalls, modelCliSignIns, modelConnections, modelSettingsRevisions } from "@direx/db/schema";

export type ModelsTx = WorkspaceTx;
export type NewCall = typeof modelCalls.$inferInsert;
export type CallPatch = Partial<typeof modelCalls.$inferInsert>;

/** A key already used by a call that went out. A refused one may run again once the limit clears. */
export async function liveCallId(tx: WorkspaceTx, idempotencyKey: string): Promise<string | undefined> {
  const [row] = await tx
    .select({ id: modelCalls.id })
    .from(modelCalls)
    .where(and(eq(modelCalls.idempotencyKey, idempotencyKey), ne(modelCalls.status, "refused")));
  return row?.id;
}

export async function writeCall(tx: WorkspaceTx, call: NewCall): Promise<string> {
  const [row] = await tx
    .insert(modelCalls)
    .values(call)
    .onConflictDoUpdate({
      target: [modelCalls.workspaceId, modelCalls.idempotencyKey],
      set: { ...call, refusal: call.refusal ?? null },
    })
    .returning({ id: modelCalls.id });
  return row!.id;
}

export async function patchCall(tx: WorkspaceTx, id: string, patch: CallPatch) {
  await tx.update(modelCalls).set(patch).where(eq(modelCalls.id, id));
}

/** A call still waiting on its provider, with what it holds. Undefined once it has an outcome. */
export const openCall = (workspaceId: string, id: string) =>
  withWorkspace(workspaceId, (tx) => dispatchedCall(tx, id));

export async function dispatchedCall(tx: WorkspaceTx, id: string) {
  const [row] = await tx
    .select({ createdAt: modelCalls.createdAt, reservationId: modelCalls.reservationId, reservedMicros: budgetReservations.reservedMicros })
    .from(modelCalls)
    .innerJoin(budgetReservations, eq(budgetReservations.id, modelCalls.reservationId))
    .where(and(eq(modelCalls.id, id), eq(modelCalls.status, "dispatched")));
  return row;
}

/** What a run's calls have settled or still hold. */
export async function spentOnRun(tx: WorkspaceTx, runId: string): Promise<bigint> {
  const { status, settledMicros, reservedMicros } = budgetReservations;
  const [row] = await tx
    .select({ total: sql<string>`coalesce(sum(case ${status} when 'settled' then ${settledMicros} when 'held' then ${reservedMicros} else 0 end), 0)` })
    .from(modelCalls)
    .innerJoin(budgetReservations, eq(budgetReservations.id, modelCalls.reservationId))
    .where(eq(modelCalls.runId, runId));
  return BigInt(row!.total);
}

export async function purposeCallsBetween(tx: WorkspaceTx, purposes: string[], start: Date, end: Date): Promise<number> {
  const [row] = await tx
    .select({ n: count() })
    .from(modelCalls)
    .where(and(inArray(modelCalls.purpose, purposes), ne(modelCalls.status, "refused"), gte(modelCalls.createdAt, start), lt(modelCalls.createdAt, end)));
  return row!.n;
}

export type Settings = { monthlyBudgetMicros: bigint; allowUnpriced: boolean; adapter?: string | null; adapterModel?: string | null };

export async function latestSettings(tx: WorkspaceTx): Promise<Settings | undefined> {
  const [row] = await tx
    .select({ monthlyBudgetMicros: modelSettingsRevisions.monthlyBudgetMicros, allowUnpriced: modelSettingsRevisions.allowUnpriced, adapter: modelSettingsRevisions.adapter, adapterModel: modelSettingsRevisions.adapterModel })
    .from(modelSettingsRevisions)
    .orderBy(desc(modelSettingsRevisions.id))
    .limit(1);
  return row;
}

/** True when this call opened the incident, so exactly one caller notifies. */
export async function openIncident(tx: WorkspaceTx, workspaceId: string, month: string, threshold: number, at: Date): Promise<boolean> {
  const rows = await tx
    .insert(modelBudgetIncidents)
    .values({ workspaceId, month, threshold, openedAt: at })
    .onConflictDoNothing()
    .returning({ id: modelBudgetIncidents.id });
  return rows.length > 0;
}

export type AdapterChoice = { adapter: string; model: string | null };

/** An agent's own choice, else the Workspace's, else none. */
export const adapterChoice = (workspaceId: string, agent?: string): Promise<AdapterChoice | null> =>
  withWorkspace(workspaceId, async (tx) => {
    const [own] = agent ? await tx.select().from(agentModelChoices).where(eq(agentModelChoices.agent, agent)) : [];
    if (own) return { adapter: own.adapter, model: own.adapterModel };
    const s = await latestSettings(tx);
    return s?.adapter ? { adapter: s.adapter, model: s.adapterModel ?? null } : null;
  });

export const agentChoices = (workspaceId: string) =>
  withWorkspace(workspaceId, (tx) => tx.select({ agent: agentModelChoices.agent, adapter: agentModelChoices.adapter, model: agentModelChoices.adapterModel }).from(agentModelChoices));

export const setAgentChoice = (workspaceId: string, agent: string, adapter: string, adapterModel: string | null, changedBy: string, at: Date, alongside?: (tx: WorkspaceTx) => Promise<unknown>) =>
  withWorkspace(workspaceId, async (tx) => {
    await tx
      .insert(agentModelChoices)
      .values({ workspaceId, agent, adapter, adapterModel, changedBy, changedAt: at })
      .onConflictDoUpdate({ target: [agentModelChoices.workspaceId, agentModelChoices.agent], set: { adapter, adapterModel, changedBy, changedAt: at, pausedAt: null } });
    await tx.insert(agentModelChoiceRevisions).values({ workspaceId, agent, adapter, adapterModel, changedBy, changedAt: at });
    await alongside?.(tx);
  });

export const clearAgentChoice = (workspaceId: string, agent: string, changedBy: string, at: Date) =>
  withWorkspace(workspaceId, async (tx) => {
    await tx.delete(agentModelChoices).where(eq(agentModelChoices.agent, agent));
    await tx.insert(agentModelChoiceRevisions).values({ workspaceId, agent, adapter: null, adapterModel: null, changedBy, changedAt: at });
  });

/** The agent's own choice alone, with whether a cloud run found it paused. */
export const ownChoice = (workspaceId: string, agent: string) =>
  withWorkspace(workspaceId, async (tx) => {
    const [row] = await tx
      .select({ adapter: agentModelChoices.adapter, model: agentModelChoices.adapterModel, pausedAt: agentModelChoices.pausedAt })
      .from(agentModelChoices)
      .where(eq(agentModelChoices.agent, agent));
    return row;
  });

/** True only for the call that paused it, so Admins hear once. */
export const pauseChoice = (workspaceId: string, agent: string, at: Date) =>
  withWorkspace(workspaceId, async (tx) => {
    const rows = await tx
      .update(agentModelChoices)
      .set({ pausedAt: at })
      .where(and(eq(agentModelChoices.agent, agent), isNull(agentModelChoices.pausedAt)))
      .returning({ agent: agentModelChoices.agent });
    return rows.length > 0;
  });

export const resumeChoice = (workspaceId: string, agent: string) =>
  withWorkspace(workspaceId, (tx) => tx.update(agentModelChoices).set({ pausedAt: null }).where(eq(agentModelChoices.agent, agent)));

/** Every set and clear of an agent's choice, oldest first. */
export const agentChoiceRevisions = (workspaceId: string, agent: string) =>
  withWorkspace(workspaceId, (tx) =>
    tx
      .select({ adapter: agentModelChoiceRevisions.adapter, model: agentModelChoiceRevisions.adapterModel, changedBy: agentModelChoiceRevisions.changedBy })
      .from(agentModelChoiceRevisions)
      .where(eq(agentModelChoiceRevisions.agent, agent))
      .orderBy(agentModelChoiceRevisions.id),
  );

export const cliSignIns = (workspaceId: string) =>
  withWorkspace(workspaceId, (tx) =>
    tx
      .select({ id: modelCliSignIns.id, provider: modelCliSignIns.provider, ownerUserId: modelCliSignIns.ownerUserId, credentialId: modelCliSignIns.credentialId, needsItemId: modelCliSignIns.needsItemId })
      .from(modelCliSignIns),
  );

export const insertCliSignIn = (workspaceId: string, provider: string, ownerUserId: string | null, credentialId: string, createdBy: string, at: Date) =>
  withWorkspace(workspaceId, (tx) => tx.insert(modelCliSignIns).values({ workspaceId, provider, ownerUserId, credentialId, createdBy, createdAt: at }));

export const deleteCliSignIn = (workspaceId: string, id: string) =>
  withWorkspace(workspaceId, (tx) => tx.delete(modelCliSignIns).where(eq(modelCliSignIns.id, id)));

export const setSignInNeedsItem = (workspaceId: string, id: string, needsItemId: string | null) =>
  withWorkspace(workspaceId, (tx) => tx.update(modelCliSignIns).set({ needsItemId }).where(eq(modelCliSignIns.id, id)));

export const connections = (workspaceId: string) =>
  withWorkspace(workspaceId, (tx) => tx.select({ provider: modelConnections.provider, credentialId: modelConnections.credentialId }).from(modelConnections));

export const setConnection = (workspaceId: string, provider: string, credentialId: string, createdBy: string, at: Date) =>
  withWorkspace(workspaceId, (tx) =>
    tx
      .insert(modelConnections)
      .values({ workspaceId, provider, credentialId, createdBy, createdAt: at })
      .onConflictDoUpdate({ target: [modelConnections.workspaceId, modelConnections.provider], set: { credentialId, createdBy, createdAt: at } }),
  );

export const clearConnection = (workspaceId: string, provider: string) =>
  withWorkspace(workspaceId, (tx) => tx.delete(modelConnections).where(eq(modelConnections.provider, provider)));

export const runCost = (workspaceId: string, runId: string): Promise<bigint> => withWorkspace(workspaceId, (tx) => spentOnRun(tx, runId));
/** Whether a run's model calls went through a person's subscription, which bills nothing per call. */
export const ranOnSubscription = (workspaceId: string, runId: string): Promise<boolean> =>
  withWorkspace(workspaceId, async (tx) => (await tx.select({ id: modelCalls.id }).from(modelCalls).where(and(eq(modelCalls.runId, runId), eq(modelCalls.credentialKind, "cli_subscription"))).limit(1)).length > 0);

export const readSettings = (workspaceId: string) => withWorkspace(workspaceId, latestSettings);

export const insertRevision = (workspaceId: string, s: Settings, changedBy: string, at: Date, alongside?: (tx: WorkspaceTx) => Promise<unknown>) =>
  withWorkspace(workspaceId, async (tx) => {
    await tx.insert(modelSettingsRevisions).values({ workspaceId, ...s, changedBy, createdAt: at });
    await alongside?.(tx);
  });

export const incidents = (workspaceId: string, month: string) =>
  withWorkspace(workspaceId, (tx) =>
    tx
      .select({ threshold: modelBudgetIncidents.threshold, openedAt: modelBudgetIncidents.openedAt })
      .from(modelBudgetIncidents)
      .where(eq(modelBudgetIncidents.month, month))
      .orderBy(modelBudgetIncidents.threshold),
  );

export const usageByPurposeAndModel = (workspaceId: string, start: Date, end: Date) =>
  withWorkspace(workspaceId, (tx) =>
    tx
      .select({
        purpose: modelCalls.purpose,
        model: modelCalls.requestedModel,
        calls: count(),
        costMicros: sql<string>`coalesce(sum(${modelCalls.costMicros}), 0)`,
      })
      .from(modelCalls)
      .where(and(ne(modelCalls.status, "refused"), gte(modelCalls.createdAt, start), lt(modelCalls.createdAt, end)))
      .groupBy(modelCalls.purpose, modelCalls.requestedModel)
      .orderBy(modelCalls.purpose, modelCalls.requestedModel),
  );

export const recentCalls = (workspaceId: string, limit: number, before?: Date) =>
  withWorkspace(workspaceId, (tx) =>
    tx
      .select({
        id: modelCalls.id,
        purpose: modelCalls.purpose,
        model: modelCalls.requestedModel,
        status: modelCalls.status,
        refusal: modelCalls.refusal,
        errorFamily: modelCalls.errorFamily,
        trust: modelCalls.trust,
        inputTokens: modelCalls.inputTokens,
        outputTokens: modelCalls.outputTokens,
        costMicros: modelCalls.costMicros,
        costStatus: modelCalls.costStatus,
        createdAt: modelCalls.createdAt,
      })
      .from(modelCalls)
      .where(before ? lt(modelCalls.createdAt, before) : undefined)
      .orderBy(desc(modelCalls.createdAt))
      .limit(limit),
  );
