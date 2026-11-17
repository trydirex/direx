// SPDX-License-Identifier: AGPL-3.0-only
// Approved SEO briefs. A row is written once, inside the approval's own transaction, and never changed.
import { withWorkspace, type WorkspaceTx } from "@direx/db";
import { items, workspaces } from "@direx/db/schema";
import { agentRuns } from "@direx/db/schema-agents";
import { seoBriefs } from "@direx/db/schema-seo";
import { and, desc, eq, gte, inArray, or, sql } from "drizzle-orm";

/** The Item kind a Brief is. */
export const BRIEF_KIND = "brief";

export const inWorkspace = withWorkspace;
export type SeoTx = WorkspaceTx;
export type NewBrief = Omit<typeof seoBriefs.$inferInsert, "id">;

/** Takes the approval's transaction, so the brief and the Item's move commit or fail together. */
export async function insertBrief(tx: SeoTx, row: NewBrief): Promise<void> {
  await tx.insert(seoBriefs).values(row);
}

/** Every approved Brief, oldest first: what the before and after report reads. */
export function approvedBriefs(workspaceId: string) {
  return inWorkspace(workspaceId, (tx) => tx.select().from(seoBriefs).orderBy(seoBriefs.approvedAt));
}

/** Page URLs with a brief approved at or after since. */
export function pagesDecidedSince(workspaceId: string, since: Date): Promise<string[]> {
  return inWorkspace(workspaceId, async (tx) => {
    const rows = await tx.selectDistinct({ pageUrl: seoBriefs.pageUrl }).from(seoBriefs).where(gte(seoBriefs.approvedAt, since));
    return rows.map((r) => r.pageUrl);
  });
}

/**
 * Pages a run leaves alone: those with a Brief still waiting, and those whose Brief was approved
 * or dismissed since `since`.
 */
export function pagesToSkip(workspaceId: string, since: Date): Promise<string[]> {
  return inWorkspace(workspaceId, async (tx) => {
    const rows = await tx
      .selectDistinct({ page: sql<string>`${items.payload} ->> 'page'` })
      .from(items)
      .where(and(eq(items.kind, BRIEF_KIND), or(inArray(items.state, ["draft", "needs_approval", "scheduled"]), gte(items.updatedAt, since))));
    return rows.map((r) => r.page).filter(Boolean);
  });
}

const WAITING = ["draft", "needs_approval", "scheduled"];

/** A run still going: its Brief, if any, isn't an Item yet. */
const LIVE_RUNS = ["queued", "running", "waiting"];

/** Whether a Brief for this page and search still waits on a person, or is still being written. */
export function briefWaiting(workspaceId: string, agent: string, page: string, query: string): Promise<boolean> {
  return inWorkspace(workspaceId, async (tx) => {
    const [item] = await tx
      .select({ id: items.id })
      .from(items)
      .where(and(eq(items.kind, BRIEF_KIND), inArray(items.state, WAITING), sql`${items.payload} ->> 'page' = ${page}`, sql`${items.payload} ->> 'query' = ${query}`))
      .limit(1);
    if (item) return true;
    const [run] = await tx
      .select({ id: agentRuns.id })
      .from(agentRuns)
      .where(and(eq(agentRuns.agent, agent), inArray(agentRuns.status, LIVE_RUNS), sql`${agentRuns.input} -> 'candidate' ->> 'page' = ${page}`, sql`${agentRuns.input} -> 'candidate' ->> 'query' = ${query}`))
      .limit(1);
    return run !== undefined;
  });
}

/** The page and search of each brief agent run still going, read from the run's own input. */
export function briefsBeingWritten(workspaceId: string, agent: string): Promise<{ page: string; query: string }[]> {
  return inWorkspace(workspaceId, (tx) =>
    tx
      .selectDistinct({ page: sql<string>`${agentRuns.input} -> 'candidate' ->> 'page'`, query: sql<string>`${agentRuns.input} -> 'candidate' ->> 'query'` })
      .from(agentRuns)
      .where(and(eq(agentRuns.agent, agent), inArray(agentRuns.status, LIVE_RUNS))),
  );
}

/** Past Briefs, newest first, with when each was approved. */
export function briefHistory(workspaceId: string, limit: number) {
  return inWorkspace(workspaceId, (tx) =>
    tx
      .select({
        itemId: items.id,
        state: items.state,
        createdAt: items.createdAt,
        page: sql<string>`${items.payload} ->> 'page'`,
        query: sql<string>`${items.payload} ->> 'query'`,
        numbers: sql<Record<string, number> | null>`${items.payload} -> 'numbers'`,
        window: sql<{ startDate: string; endDate: string } | null>`${items.payload} -> 'window'`,
        appliedAt: seoBriefs.approvedAt,
      })
      .from(items)
      .leftJoin(seoBriefs, and(eq(seoBriefs.workspaceId, items.workspaceId), eq(seoBriefs.itemId, items.id)))
      .where(eq(items.kind, BRIEF_KIND))
      .orderBy(desc(items.createdAt))
      .limit(limit),
  );
}

/** The Brief a run already made, so a retried hand-over doesn't make a second. */
export function briefItemForRun(workspaceId: string, runId: string): Promise<string | null> {
  return inWorkspace(workspaceId, async (tx) => {
    const [row] = await tx.select({ id: items.id }).from(items).where(and(eq(items.kind, BRIEF_KIND), sql`${items.payload} ->> 'runId' = ${runId}`)).limit(1);
    return row?.id ?? null;
  });
}

/** The Brief a run made and where it stands, for the Campaign step that started the run. */
export function briefOfRun(workspaceId: string, runId: string): Promise<{ id: string; state: string | null } | null> {
  return inWorkspace(workspaceId, async (tx) => {
    const [row] = await tx.select({ id: items.id, state: items.state }).from(items).where(and(eq(items.kind, BRIEF_KIND), sql`${items.payload} ->> 'runId' = ${runId}`)).limit(1);
    return row ?? null;
  });
}

/** The Workspace's name, a brand term the selectors leave out. */
export function workspaceName(workspaceId: string): Promise<string | null> {
  return inWorkspace(workspaceId, async (tx) => {
    const [row] = await tx.select({ name: workspaces.name }).from(workspaces).where(eq(workspaces.id, workspaceId)).limit(1);
    return row?.name ?? null;
  });
}
