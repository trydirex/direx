// SPDX-License-Identifier: AGPL-3.0-only
// The agents.run queue. Every timer is one of these: a job is only a wakeup carrying two ids, and
// the row says what to do, so a job that comes early or twice does nothing. Sent inside the
// transaction that needs it, so a crash can't commit a change and lose its wakeup.
import type { PgBoss } from "pg-boss";
import { z } from "zod";
import { sendJobInTx, type LedgerTx } from "../../ledger/index";

const QUEUE = "agents.run";
export const RunWake = z.strictObject({ workspaceId: z.uuid(), runId: z.uuid() });
export type RunWake = z.infer<typeof RunWake>;

export const sendRunWake = (boss: PgBoss, tx: LedgerTx, payload: RunWake, at: Date): Promise<void> => sendJobInTx(boss, tx, QUEUE, RunWake.parse(payload), at);

export async function workRunWakes(boss: PgBoss, handle: (p: RunWake) => Promise<void>): Promise<void> {
  await boss.createQueue(QUEUE, { retryLimit: 5, retryDelay: 5, retryBackoff: true });
  await boss.work(QUEUE, { pollingIntervalSeconds: 1 }, async (jobs) => {
    for (const job of jobs) await handle(RunWake.parse(job.data));
  });
}
