// SPDX-License-Identifier: AGPL-3.0-only
// The prospecting.company_read queue. A job carries only the two ids and the company row says what
// to do, so a job that comes twice reads nothing twice. A blocked site is recorded, not thrown, so
// only a failure of Direx itself is retried.
import type { PgBoss } from "pg-boss";
import { z } from "zod";
import { sendJobInTx, type LedgerTx } from "../../ledger/index";

/** Settles a job's row when its last try failed, so the row never waits on a job that won't come. */
export type GiveUp<T> = (payload: T, error: unknown) => Promise<unknown>;

async function workQueue<T>(boss: PgBoss, name: string, parse: (data: unknown) => T, handle: (p: T) => Promise<unknown>, giveUp?: GiveUp<T>): Promise<void> {
  await boss.createQueue(name, { retryLimit: 5, retryDelay: 5, retryBackoff: true });
  await boss.work(name, { pollingIntervalSeconds: 1, includeMetadata: true }, async (jobs) => {
    for (const job of jobs) {
      const payload = parse(job.data);
      try {
        await handle(payload);
      } catch (e) {
        if (giveUp && job.retryCount >= job.retryLimit) await giveUp(payload, e);
        throw e;
      }
    }
  });
}

export const COMPANY_READ_QUEUE = "prospecting.company_read";
/** `startedBy` is set on a re-read a person asked for, whose names step then runs as them. */
export const CompanyRead = z.strictObject({ workspaceId: z.uuid(), companyId: z.uuid(), startedBy: z.uuid().optional() });
export type CompanyRead = z.infer<typeof CompanyRead>;

/** One job at a time per worker, and a job reads its site one page after another. */
export const workCompanyReads = (boss: PgBoss, handle: (p: CompanyRead) => Promise<unknown>, giveUp?: GiveUp<CompanyRead>): Promise<void> =>
  workQueue(boss, COMPANY_READ_QUEUE, (d) => CompanyRead.parse(d), handle, giveUp);

/** Queued in the caller's transaction, so a company row and its read commit together or not at all. */
export const sendCompanyRead = (boss: PgBoss, tx: LedgerTx, payload: CompanyRead, at: Date): Promise<void> => sendJobInTx(boss, tx, COMPANY_READ_QUEUE, CompanyRead.parse(payload), at);

export const COMPANY_VERIFY_QUEUE = "prospecting.company_verify";
export const CompanyVerify = z.strictObject({ workspaceId: z.uuid(), companyId: z.uuid() });
export type CompanyVerify = z.infer<typeof CompanyVerify>;

/** Like a read, a job carries only ids, and what is already recorded on the addresses is not checked again. */
export const workCompanyVerifies = (boss: PgBoss, handle: (p: CompanyVerify) => Promise<unknown>, giveUp?: GiveUp<CompanyVerify>): Promise<void> =>
  workQueue(boss, COMPANY_VERIFY_QUEUE, (d) => CompanyVerify.parse(d), handle, giveUp);

/** Queued in the approval's transaction, so an accepted company always gets its checks. */
export const sendCompanyVerify = (boss: PgBoss, tx: LedgerTx, payload: CompanyVerify, at: Date): Promise<void> => sendJobInTx(boss, tx, COMPANY_VERIFY_QUEUE, CompanyVerify.parse(payload), at);

export const HANDOVER_QUEUE = "prospecting.handover";
export const Handover = z.strictObject({ workspaceId: z.uuid(), handoverId: z.uuid() });
export type Handover = z.infer<typeof Handover>;

/** A hand-over row holds its cursor, so a retried job carries on after the last saved batch. */
export const workHandovers = (boss: PgBoss, handle: (p: Handover) => Promise<unknown>, giveUp?: GiveUp<Handover>): Promise<void> =>
  workQueue(boss, HANDOVER_QUEUE, (d) => Handover.parse(d), handle, giveUp);

/** Queued in the transaction that makes the hand-over row, so neither exists without the other. */
export const sendHandover = (boss: PgBoss, tx: LedgerTx, payload: Handover, at: Date): Promise<void> => sendJobInTx(boss, tx, HANDOVER_QUEUE, Handover.parse(payload), at);
