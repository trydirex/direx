// SPDX-License-Identifier: AGPL-3.0-only
// The one owner of budget reservations. Lock order: workspace row, then run row, then the
// reservation, and withBudget takes the first so no caller ever takes a ledger lock itself.
// No network or model call belongs inside fn.
import { and, eq, gte, lt, sql } from "drizzle-orm";
import { withWorkspace, type WorkspaceTx } from "@direx/db";
import { budgetReservations } from "@direx/db/schema";

export type BudgetKind = "model";

/** The UTC calendar month holding `at`, as [start, next start) and its "YYYY-MM" key. */
export function utcMonth(at: Date) {
  const start = new Date(Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), 1));
  const end = new Date(Date.UTC(at.getUTCFullYear(), at.getUTCMonth() + 1, 1));
  return { start, end, key: start.toISOString().slice(0, 7) };
}

export type BudgetScope = {
  tx: WorkspaceTx;
  /** Settled plus held for the month holding `at`: what admission counts. */
  spent(kind: BudgetKind, at: Date): Promise<bigint>;
  /** Settled alone for that month: what incidents count. */
  settled(kind: BudgetKind, at: Date): Promise<bigint>;
  hold(kind: BudgetKind, micros: bigint, at: Date): Promise<string>;
  /** Records the real spend. On a settled row it corrects it, for a receipt that arrives late. */
  settle(id: string, micros: bigint, at: Date): Promise<void>;
  /** Only for a definite provider error: nothing was charged, even if a sweep charged the row meanwhile. */
  release(id: string, at: Date): Promise<void>;
};

export function withBudget<T>(workspaceId: string, fn: (b: BudgetScope) => Promise<T>): Promise<T> {
  return withWorkspace(workspaceId, async (tx) => {
    await tx.execute(sql`select 1 from workspaces where id = ${workspaceId} for no key update`);
    const sum = async (kind: BudgetKind, at: Date, expr: ReturnType<typeof sql>) => {
      const { start, end } = utcMonth(at);
      const [row] = await tx
        .select({ total: sql<string>`coalesce(sum(${expr}), 0)` })
        .from(budgetReservations)
        .where(and(eq(budgetReservations.kind, kind), gte(budgetReservations.createdAt, start), lt(budgetReservations.createdAt, end)));
      return BigInt(row!.total);
    };
    const { settledMicros: settled, reservedMicros: reserved, status } = budgetReservations;
    return fn({
      tx,
      spent: (kind, at) => sum(kind, at, sql`case ${status} when 'settled' then ${settled} when 'held' then ${reserved} else 0 end`),
      settled: (kind, at) => sum(kind, at, sql`case ${status} when 'settled' then ${settled} else 0 end`),
      async hold(kind, micros, at) {
        const [row] = await tx
          .insert(budgetReservations)
          .values({ workspaceId, kind, reservedMicros: micros, createdAt: at })
          .returning({ id: budgetReservations.id });
        return row!.id;
      },
      async settle(id, micros, at) {
        await tx
          .update(budgetReservations)
          .set({ status: "settled", settledMicros: micros, settledAt: at })
          .where(and(eq(budgetReservations.id, id), sql`${status} <> 'released'`));
      },
      async release(id, at) {
        await tx
          .update(budgetReservations)
          .set({ status: "released", settledMicros: null, settledAt: at })
          .where(eq(budgetReservations.id, id));
      },
    });
  });
}
