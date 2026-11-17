// SPDX-License-Identifier: AGPL-3.0-only
// Status write-back (ADR 0025), self-hosted and cloud alike: each docs source with a live yes every 5
// minutes [DEFAULT], and one source soon after a new yes, so its rows show their state at once. Each
// queue, schedule and consumer goes through `later` (ADR 0027 rule 001).
import type { PgBoss } from "pg-boss";
import { z } from "zod";
import type { Later } from "./sweeps";

export const DOCS_WRITE_BACK = "docs.write_back";
export const DOCS_WRITE_BACK_ONE = "docs.write_back_one";
const WriteBackJob = z.strictObject({ workspaceId: z.uuid(), sourceId: z.uuid() });

export function writeBackJobs(d: {
  boss: Pick<PgBoss, "createQueue" | "schedule" | "work">;
  later: Later;
  /** The docs plugin, if one is loaded: the connections it is on, and whether it can write. */
  provider: { connections: string[]; write?: unknown } | undefined;
  connected: (connections: string[]) => Promise<{ workspaceId: string }[]>;
  writeBack: { workspace: (workspaceId: string) => Promise<unknown>; source: (workspaceId: string, sourceId: string) => Promise<unknown> };
}) {
  const { boss, later, provider } = d;
  later(() => boss.createQueue(DOCS_WRITE_BACK));
  later(() => boss.schedule(DOCS_WRITE_BACK, "*/5 * * * *"));
  later(() =>
    boss.work(DOCS_WRITE_BACK, async () => {
      if (!provider?.write) return;
      for (const workspaceId of new Set((await d.connected(provider.connections)).map((m) => m.workspaceId))) await d.writeBack.workspace(workspaceId);
    }),
  );
  later(() => boss.createQueue(DOCS_WRITE_BACK_ONE));
  later(() =>
    boss.work<unknown>(DOCS_WRITE_BACK_ONE, async ([job]) => {
      const p = WriteBackJob.safeParse(job?.data);
      if (p.success) await d.writeBack.source(p.data.workspaceId, p.data.sourceId);
    }),
  );
}
