// SPDX-License-Identifier: AGPL-3.0-only
// The ask.start queue. A job carries only who accepted which Ask start; the Item says what to start.
// It is inserted in the acceptance's transaction, so an accepted Item always has its job.
import type { PgBoss } from "pg-boss";
import { z } from "zod";
import { sendJobInTx, type LedgerTx } from "../../ledger/index";

export const ASK_START_QUEUE = "ask.start";
const RETRY_LIMIT = 3;

export const AskStartJob = z.strictObject({ workspaceId: z.uuid(), itemId: z.uuid(), userId: z.string().min(1) });
export type AskStartJob = z.infer<typeof AskStartJob>;

export const sendAskStart = (boss: PgBoss, tx: LedgerTx, job: AskStartJob, at: Date): Promise<void> => sendJobInTx(boss, tx, ASK_START_QUEUE, AskStartJob.parse(job), at);

/** Runs each job; `lastTry` is true when a throw would not be retried. */
export async function workAskStarts(boss: PgBoss, run: (job: AskStartJob, lastTry: boolean) => Promise<void>) {
  await boss.createQueue(ASK_START_QUEUE, { retryLimit: RETRY_LIMIT, retryDelay: 10, retryBackoff: true });
  return boss.work(ASK_START_QUEUE, { pollingIntervalSeconds: 1, includeMetadata: true }, async (jobs) => {
    for (const job of jobs) await run(AskStartJob.parse(job.data), job.retryCount >= RETRY_LIMIT);
  });
}
