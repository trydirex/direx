// SPDX-License-Identifier: AGPL-3.0-only
// A delayed job per hold, inserted with it, that settles a call whose worker died. It
// carries only ids, and the row says what to do, so a call that finished makes it a no-op.
import type { PgBoss } from "pg-boss";
import { z } from "zod";
import { sendJobInTx, type LedgerTx } from "../../ledger/index";

const HOLD_QUEUE = "models.hold_watch";
const Payload = z.strictObject({ workspaceId: z.uuid(), callId: z.uuid() });

export const sendHoldWatch = (boss: PgBoss, tx: LedgerTx, payload: z.infer<typeof Payload>, at: Date): Promise<void> =>
  sendJobInTx(boss, tx, HOLD_QUEUE, Payload.parse(payload), at);

export async function workHoldWatch(boss: PgBoss, settle: (workspaceId: string, callId: string) => Promise<void>): Promise<void> {
  await boss.createQueue(HOLD_QUEUE, { retryLimit: 5, retryDelay: 5, retryBackoff: true });
  await boss.work(HOLD_QUEUE, { pollingIntervalSeconds: 5 }, async (jobs) => {
    for (const job of jobs) {
      const p = Payload.parse(job.data);
      await settle(p.workspaceId, p.callId);
    }
  });
}
