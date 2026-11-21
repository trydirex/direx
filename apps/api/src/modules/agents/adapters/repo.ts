// SPDX-License-Identifier: AGPL-3.0-only
// The only writer of agent_runs. A state change locks the row, compares the claim token and
// bumps it. No network call belongs inside any of this.
import { and, asc, desc, eq, sql } from "drizzle-orm";
import { withSystem, withWorkspace, type WorkspaceTx } from "@direx/db";
import { agentCancellations, agentDriftIncidents, agentProposals, agentRunEvents, agentRunParts, agentRuns, agentSettingRevisions, agentSettings } from "@direx/db/schema-agents";
import type { ManifestPart } from "../domain/manifest";
import { aggregateDigest } from "./digest";
import { isCitation, isQuality } from "../domain/quality";
import { canMove, hasEnded, isIncomplete, type RunStatus } from "../domain/states";

export type RunTx = WorkspaceTx;
export const inWorkspace = <T>(workspaceId: string, fn: (tx: RunTx) => Promise<T>) => withWorkspace(workspaceId, fn);

export type RunRow = typeof agentRuns.$inferSelect;
export type NewRun = typeof agentRuns.$inferInsert;
type Patch = Partial<Pick<RunRow, "statusReason" | "attempt" | "reclaims" | "retries" | "admittedAt" | "resumeAt" | "leaseExpiresAt" | "deadlineAt" | "lessonDigest">>;

export async function lockRun(tx: WorkspaceTx, id: string): Promise<RunRow | undefined> {
  const [row] = await tx.select().from(agentRuns).where(eq(agentRuns.id, id)).for("update");
  return row;
}

export async function readRun(tx: WorkspaceTx, id: string): Promise<RunRow | undefined> {
  const [row] = await tx.select().from(agentRuns).where(eq(agentRuns.id, id));
  return row;
}

/** The new row, or null when this key already has one. */
export async function insertRun(tx: WorkspaceTx, row: NewRun): Promise<RunRow | null> {
  const [made] = await tx.insert(agentRuns).values(row).onConflictDoNothing({ target: [agentRuns.workspaceId, agentRuns.idempotencyKey] }).returning();
  return made ?? null;
}

export async function runByKey(tx: WorkspaceTx, key: string): Promise<RunRow | undefined> {
  const [row] = await tx.select().from(agentRuns).where(eq(agentRuns.idempotencyKey, key));
  return row;
}

/**
 * The one state change. Null means this writer's token is stale, and nothing changed. A move the
 * table forbids throws. Ending a run settles everything that must end with it.
 */
export async function transition(tx: WorkspaceTx, id: string, token: number, to: RunStatus, patch: Patch, at: Date): Promise<RunRow | null> {
  const run = await lockRun(tx, id);
  if (!run || run.version !== token) return null;
  if (!canMove(run.status as RunStatus, to)) throw new Error(`agents: a run can't move from ${run.status} to ${to}`);
  const extra: Partial<RunRow> = {};
  if (hasEnded(to)) {
    const parts = await tx.select({ digest: agentRunParts.digest }).from(agentRunParts).where(eq(agentRunParts.runId, id)).orderBy(asc(agentRunParts.seq));
    extra.aggregateDigest = aggregateDigest(parts);
    extra.endedAt = at;
    extra.leaseExpiresAt = null;
    extra.resumeAt = null;
    // What the run read is kept as kind, id and digest in its manifest (DX-R-0008-025), so its text goes.
    const { text: _text, request: _request, brief: _brief, person: _person, attached: _attached, history: _history, ...kept } = run.input as {
      text?: string;
      request?: string;
      brief?: unknown;
      person?: unknown;
      attached?: unknown;
      history?: unknown;
    };
    extra.input = kept;
    if (isIncomplete(to)) await tx.update(agentProposals).set({ incomplete: true }).where(eq(agentProposals.runId, id));
  }
  const [row] = await tx
    .update(agentRuns)
    .set({ statusReason: null, ...patch, ...extra, status: to, version: token + 1, updatedAt: at })
    .where(eq(agentRuns.id, id))
    .returning();
  return row!;
}

/** Changes to a live claim that aren't state changes: lease, steps, retries. False means the claim is gone. */
export async function patchClaim(tx: WorkspaceTx, id: string, token: number, patch: Partial<Pick<RunRow, "leaseExpiresAt" | "steps" | "retries" | "attempt" | "lastError">>): Promise<boolean> {
  const rows = await tx
    .update(agentRuns)
    .set(patch)
    .where(and(eq(agentRuns.id, id), eq(agentRuns.version, token), eq(agentRuns.status, "running")))
    .returning({ id: agentRuns.id });
  return rows.length === 1;
}

/** Appends one manifest part. Untrusted content taints the run for good, in the same transaction. */
export async function appendPart(tx: WorkspaceTx, run: Pick<RunRow, "id" | "workspaceId">, token: number, part: ManifestPart, at: Date): Promise<boolean> {
  const live = await lockRun(tx, run.id);
  if (!live || live.version !== token || live.status !== "running") return false;
  const [next] = await tx.select({ seq: sql<number>`coalesce(max(${agentRunParts.seq}), 0) + 1` }).from(agentRunParts).where(eq(agentRunParts.runId, run.id));
  await tx.insert(agentRunParts).values({ workspaceId: run.workspaceId, runId: run.id, seq: next!.seq, ...part, at });
  if (part.trust === "untrusted" && !live.tainted) await tx.update(agentRuns).set({ tainted: true }).where(eq(agentRuns.id, run.id));
  return true;
}

export type NewEvent = { kind: "model_call" | "tool_call" | "proposal" | "rejection"; name: string; argumentsDigest?: string; resultDigest?: string; outcome: string; ref?: string; modelCallId?: string };

export async function appendEvent(tx: WorkspaceTx, run: Pick<RunRow, "id" | "workspaceId">, event: NewEvent, at: Date): Promise<void> {
  await lockRun(tx, run.id);
  const [next] = await tx.select({ seq: sql<number>`coalesce(max(${agentRunEvents.seq}), 0) + 1` }).from(agentRunEvents).where(eq(agentRunEvents.runId, run.id));
  await tx.insert(agentRunEvents).values({ workspaceId: run.workspaceId, runId: run.id, seq: next!.seq, ...event, at });
}

/** The proposal's row, new or from an earlier try at this run. */
export async function recordProposal(tx: WorkspaceTx, row: typeof agentProposals.$inferInsert) {
  const [made] = await tx.insert(agentProposals).values(row).onConflictDoNothing().returning();
  if (made) return made;
  const [existing] = await tx
    .select()
    .from(agentProposals)
    .where(and(eq(agentProposals.runId, row.runId), eq(agentProposals.outputKey, row.outputKey)));
  return existing!;
}

export async function settleProposal(tx: WorkspaceTx, runId: string, outputKey: string, settled: { itemId?: string; rejectionCode?: string }) {
  await tx
    .update(agentProposals)
    .set(settled)
    .where(and(eq(agentProposals.runId, runId), eq(agentProposals.outputKey, outputKey)));
}

type OfferKey = Pick<typeof agentProposals.$inferSelect, "targetKind" | "targetId" | "targetStepKey">;
const sameTarget = (t: OfferKey) =>
  and(
    eq(agentProposals.targetKind, t.targetKind!),
    sql`coalesce(${agentProposals.targetId}, '00000000-0000-0000-0000-000000000000'::uuid) = coalesce(${t.targetId}::uuid, '00000000-0000-0000-0000-000000000000'::uuid)`,
    sql`coalesce(${agentProposals.targetStepKey}, '') = coalesce(${t.targetStepKey}::text, '')`,
  );

/** Refuses the proposal and keeps its draft as the target's one open offer, replacing an older one. */
export async function openOffer(tx: WorkspaceTx, runId: string, outputKey: string, o: OfferKey & { body: unknown; at: Date }) {
  await tx.update(agentProposals).set({ offer: "replaced", offerAt: o.at }).where(and(eq(agentProposals.offer, "open"), sameTarget(o)));
  await tx
    .update(agentProposals)
    .set({ rejectionCode: "target_changed", body: o.body, targetKind: o.targetKind, targetId: o.targetId, targetStepKey: o.targetStepKey, offer: "open" })
    .where(and(eq(agentProposals.runId, runId), eq(agentProposals.outputKey, outputKey)));
}

export type ProposalRow = typeof agentProposals.$inferSelect;

export async function openOfferFor(tx: WorkspaceTx, target: OfferKey): Promise<ProposalRow | undefined> {
  const [row] = await tx.select().from(agentProposals).where(and(eq(agentProposals.offer, "open"), sameTarget(target)));
  return row;
}

export async function lockProposal(tx: WorkspaceTx, runId: string, outputKey: string): Promise<ProposalRow | undefined> {
  const [row] = await tx.select().from(agentProposals).where(and(eq(agentProposals.runId, runId), eq(agentProposals.outputKey, outputKey))).for("update");
  return row;
}

/** Closes an open offer as used or dismissed; false when it was already closed. */
export async function closeOffer(tx: WorkspaceTx, runId: string, outputKey: string, offer: "used" | "dismissed", by: string, at: Date): Promise<boolean> {
  const closed = await tx
    .update(agentProposals)
    .set({ offer, offerBy: by, offerAt: at })
    .where(and(eq(agentProposals.runId, runId), eq(agentProposals.outputKey, outputKey), eq(agentProposals.offer, "open")))
    .returning({ runId: agentProposals.runId });
  return closed.length > 0;
}

export async function recordCancellation(tx: WorkspaceTx, row: typeof agentCancellations.$inferInsert): Promise<void> {
  await tx.insert(agentCancellations).values(row);
}

/** What admission counts, read under the Workspace lock. */
export async function usage(tx: WorkspaceTx, agent: string, dayStart: Date) {
  const since = dayStart.toISOString();
  const [row] = await tx
    .select({
      agentRunning: sql<number>`(count(*) filter (where ${agentRuns.status} = 'running' and ${agentRuns.agent} = ${agent}))::int`,
      workspaceRunning: sql<number>`(count(*) filter (where ${agentRuns.status} = 'running'))::int`,
      agentToday: sql<number>`(count(*) filter (where ${agentRuns.admittedAt} >= ${since}::timestamptz and ${agentRuns.agent} = ${agent}))::int`,
      workspaceToday: sql<number>`(count(*) filter (where ${agentRuns.admittedAt} >= ${since}::timestamptz))::int`,
    })
    .from(agentRuns);
  return row!;
}

export async function settingsFor(tx: WorkspaceTx, agent: string) {
  const [row] = await tx.select().from(agentSettings).where(eq(agentSettings.agent, agent));
  return row;
}

/** Saves a change and its revision. Returns the new revision number. */
export async function saveSettings(tx: WorkspaceTx, workspaceId: string, agent: string, change: Partial<Pick<typeof agentSettings.$inferInsert, "enabled" | "maxConcurrentRuns" | "maxDailyRuns">>, actorUserId: string, at: Date): Promise<number> {
  const [saved] = await tx
    .insert(agentSettings)
    .values({ workspaceId, agent, ...change, updatedAt: at })
    .onConflictDoUpdate({
      target: [agentSettings.workspaceId, agentSettings.agent],
      set: { ...change, revision: sql`${agentSettings.revision} + 1`, updatedAt: at },
    })
    .returning();
  const { enabled, maxConcurrentRuns, maxDailyRuns, revision } = saved!;
  await tx.insert(agentSettingRevisions).values({ workspaceId, agent, revision, settings: { enabled, maxConcurrentRuns, maxDailyRuns }, actorUserId, at });
  return revision;
}

/** The longest-queued runs, to wake when a slot frees. */
export async function nextQueued(tx: WorkspaceTx, limit: number): Promise<string[]> {
  const rows = await tx.select({ id: agentRuns.id }).from(agentRuns).where(eq(agentRuns.status, "queued")).orderBy(asc(agentRuns.createdAt)).limit(limit);
  return rows.map((r) => r.id);
}

export const recentRuns = (tx: WorkspaceTx, limit: number, agent?: string) =>
  tx.select().from(agentRuns).where(agent ? eq(agentRuns.agent, agent) : undefined).orderBy(desc(agentRuns.createdAt)).limit(limit);
export const partsOf = (tx: WorkspaceTx, id: string) => tx.select().from(agentRunParts).where(eq(agentRunParts.runId, id)).orderBy(asc(agentRunParts.seq));
export const eventsOf = (tx: WorkspaceTx, id: string) => tx.select().from(agentRunEvents).where(eq(agentRunEvents.runId, id)).orderBy(asc(agentRunEvents.seq));
export const proposalsOf = (tx: WorkspaceTx, id: string) => tx.select().from(agentProposals).where(eq(agentProposals.runId, id));

/** One agent version on one route in a Workspace, counted for the drift check (ADR 0008 rule 026). */
export type VersionCounts = {
  agent: string;
  definitionVersion: number;
  routeHash: string;
  firstRunAt: Date;
  /** Runs with at least one proposal. */
  runs: number;
  proposals: number;
  qualityRejections: number;
  /** Runs with a citation refusal or a recorded `citation` event. */
  citationRuns: number;
  /** The median words changed in approved Items these proposals became, and how many were measured. */
  editMedian: number | null;
  edited: number;
};

type VersionKey = { agent: string; version: number; route: string };
const keyOf = (r: VersionKey) => `${r.agent}\u0000${r.version}\u0000${r.route}`;

/**
 * Every agent version and route in this Workspace with its counts. Proposals from before routes were
 * hashed are left out. Codes are classified here, by the domain's lists, so the SQL holds none.
 * review_decisions belongs to items and is only read: an approved Item's edit distance, through item_id.
 */
export async function versionCounts(tx: WorkspaceTx): Promise<VersionCounts[]> {
  const { rows: codes } = await tx.execute<VersionKey & { code: string | null; n: number }>(sql`
    select r.agent, r.definition_version as version, p.route_hash as route, p.rejection_code as code, count(*)::int as n
    from agent_proposals p join agent_runs r on r.workspace_id = p.workspace_id and r.id = p.run_id
    where p.route_hash is not null
    group by 1, 2, 3, 4`);
  const tally = new Map<string, { proposals: number; qualityRejections: number }>();
  for (const c of codes) {
    const t = tally.get(keyOf(c)) ?? { proposals: 0, qualityRejections: 0 };
    t.proposals += c.n;
    if (c.code && isQuality(c.code)) t.qualityRejections += c.n;
    tally.set(keyOf(c), t);
  }
  const citing = [...new Set(codes.flatMap((c) => (c.code && isCitation(c.code) ? [c.code] : [])))];
  const cited = citing.length ? sql`p.rejection_code in (${sql.join(citing.map((c) => sql`${c}`), sql`, `)})` : sql`false`;
  const { rows } = await tx.execute<VersionKey & { runs: number; first_run_at: string | Date; citation_runs: number; edit_median: number | null; edited: number }>(sql`
    select r.agent, r.definition_version as version, p.route_hash as route,
      count(distinct r.id)::int as runs,
      min(r.created_at) as first_run_at,
      (count(distinct r.id) filter (where ${cited} or exists (
        select 1 from agent_run_events e where e.workspace_id = r.workspace_id and e.run_id = r.id and e.kind = 'citation'
      )))::int as citation_runs,
      percentile_cont(0.5) within group (order by d.edit_distance) as edit_median,
      count(d.edit_distance)::int as edited
    from agent_proposals p
    join agent_runs r on r.workspace_id = p.workspace_id and r.id = p.run_id
    left join review_decisions d on d.workspace_id = p.workspace_id and d.item_id = p.item_id
      and d.decision in ('approve', 'edit_approve') and d.edit_distance is not null
    where p.route_hash is not null
    group by 1, 2, 3`);
  return rows.map((r) => ({
    agent: r.agent,
    definitionVersion: r.version,
    routeHash: r.route,
    firstRunAt: new Date(r.first_run_at),
    runs: r.runs,
    ...tally.get(keyOf(r))!,
    citationRuns: r.citation_runs,
    editMedian: r.edit_median === null ? null : Number(r.edit_median),
    edited: r.edited,
  }));
}

/** True when this version and measure had no incident yet, so its Owners haven't been told. */
export async function openDriftIncident(tx: WorkspaceTx, row: typeof agentDriftIncidents.$inferInsert): Promise<boolean> {
  const made = await tx.insert(agentDriftIncidents).values(row).onConflictDoNothing().returning({ id: agentDriftIncidents.id });
  return made.length > 0;
}

/** The live Workspaces with a proposal whose route is known, across Workspaces, for the drift check. Ids only. */
export async function driftWorkspaces(): Promise<string[]> {
  const { rows } = await withSystem((tx) => tx.execute<{ workspace_id: string }>(sql`select workspace_id from system.drift_workspaces()`));
  return rows.map((r) => r.workspace_id);
}
