// SPDX-License-Identifier: AGPL-3.0-only
// The ledger.dispatch queue. A job is only a wakeup carrying a workspace id and an
// Action id; the Action row says what to do. Jobs are inserted inside the ledger
// transaction, so a crash can never commit a state change and lose its wakeup.
import { withSystem } from "@direx/db";
import { sql, type SQL } from "drizzle-orm";
import type { PgBoss } from "pg-boss";
import { z } from "zod";
import type { LedgerTx } from "./ledger-repo";

export const QUEUE = "ledger.dispatch";

export const WakePayload = z.strictObject({ workspaceId: z.uuid(), actionId: z.uuid() });
export type WakePayload = z.infer<typeof WakePayload>;

// pg-boss sends "$1"-style SQL; rebuild it as a drizzle query so it runs on this tx.
function toSql(text: string, values: unknown[] = []): SQL {
  const parts = text.split(/\$(\d+)\b/);
  return sql.join(parts.map((p, i) => (i % 2 === 0 ? sql.raw(p) : sql`${values[Number(p) - 1]}`)));
}

/** Inserts a job in the caller's transaction, so it exists exactly when the transaction commits. */
export async function sendJobInTx(boss: PgBoss, tx: LedgerTx, queue: string, payload: object, at: Date): Promise<void> {
  const db = { executeSql: async (text: string, values?: unknown[]) => tx.execute(toSql(text, values)) };
  await boss.send(queue, payload, { startAfter: at, db });
}

export const sendWake = (boss: PgBoss, tx: LedgerTx, payload: WakePayload, at: Date): Promise<void> =>
  sendJobInTx(boss, tx, QUEUE, WakePayload.parse(payload), at);

export function ensureQueue(boss: PgBoss): Promise<void> {
  return boss.createQueue(QUEUE, { retryLimit: 5, retryDelay: 5, retryBackoff: true });
}

const SWEEP = "ledger.sweep";
const SWEEP_ROWS = 500;

/** Wakes every overdue Action again. The wake carries only ids, and the Action row decides. */
export async function sweepOverdue(boss: PgBoss): Promise<number> {
  const { rows } = await withSystem((tx) => tx.execute(sql`select workspace_id, action_id from system.overdue_actions(${SWEEP_ROWS})`));
  for (const r of rows) await boss.send(QUEUE, WakePayload.parse({ workspaceId: r.workspace_id, actionId: r.action_id }));
  return rows.length;
}

/** Once a minute, so a lost wake delays an Action and never strands it. */
export async function workSweep(boss: PgBoss): Promise<void> {
  await boss.createQueue(SWEEP);
  await boss.schedule(SWEEP, "* * * * *");
  await boss.work(SWEEP, async () => {
    await sweepOverdue(boss);
  });
}

/** Works the queue. A malformed payload fails the job; it is never guessed at. */
export async function workWakes(boss: PgBoss, handle: (p: WakePayload) => Promise<void>): Promise<string> {
  await ensureQueue(boss);
  return boss.work(QUEUE, { pollingIntervalSeconds: 1 }, async (jobs) => {
    for (const job of jobs) await handle(WakePayload.parse(job.data));
  });
}
