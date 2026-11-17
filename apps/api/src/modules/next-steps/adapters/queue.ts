// SPDX-License-Identifier: AGPL-3.0-only
// The next_steps.start queue. A job carries only who accepted which Next step; the Item says what
// to start. It is inserted in the acceptance's transaction, so an accepted card always has its job.
import type { PgBoss } from "pg-boss";
import { z } from "zod";
import { sendJobInTx, type LedgerTx } from "../../ledger/index";

export const START_QUEUE = "next_steps.start";
const RETRY_LIMIT = 3;

export const StartJob = z.strictObject({ workspaceId: z.uuid(), itemId: z.uuid(), userId: z.string().min(1), timeZone: z.string().nullable() });
export type StartJob = z.infer<typeof StartJob>;

export const sendStart = (boss: PgBoss, tx: LedgerTx, job: StartJob, at: Date): Promise<void> => sendJobInTx(boss, tx, START_QUEUE, StartJob.parse(job), at);

/** Runs each job; `lastTry` is true when a throw would not be retried. */
export async function workStarts(boss: PgBoss, run: (job: StartJob, lastTry: boolean) => Promise<void>) {
  await boss.createQueue(START_QUEUE, { retryLimit: RETRY_LIMIT, retryDelay: 10, retryBackoff: true });
  return boss.work(START_QUEUE, { pollingIntervalSeconds: 1, includeMetadata: true }, async (jobs) => {
    for (const job of jobs) await run(StartJob.parse(job.data), job.retryCount >= RETRY_LIMIT);
  });
}
