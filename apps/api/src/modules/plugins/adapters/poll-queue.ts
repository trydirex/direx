// SPDX-License-Identifier: AGPL-3.0-only
// The plugins.poll queue. A job names one poll trigger in one workspace and the credential
// it polls with (an entity id, never a value); each run enqueues the next one, delayed by
// the trigger's interval.
import type { PgBoss } from "pg-boss";
import { z } from "zod";

export const POLL_QUEUE = "plugins.poll";

export const PollPayload = z.strictObject({
  workspaceId: z.uuid(),
  pluginId: z.string().min(1),
  trigger: z.string().min(1),
  credentialId: z.uuid().nullable().default(null),
});
export type PollPayload = z.output<typeof PollPayload>;

export function ensurePollQueue(boss: PgBoss): Promise<void> {
  return boss.createQueue(POLL_QUEUE);
}

const chainKey = (p: PollPayload) => [p.workspaceId, p.pluginId, p.trigger, p.credentialId ?? ""].join(":");

/** Queues a chain's next run, upserted by the chain's key, so runs that finish at once on two workers agree on one job instead of forking the chain. */
export async function sendPoll(boss: PgBoss, payload: PollPayload, at: Date): Promise<void> {
  const p = PollPayload.parse(payload);
  await boss.upsert(POLL_QUEUE, p, { singletonKey: chainKey(p), startAfter: at });
}

/**
 * Queued, not yet started runs for one trigger. Asked for queued jobs only: findJobs returns at most a page,
 * oldest first, and a chain's finished runs (kept for days) would fill it and hide the queued one.
 */
export async function queuedPolls(boss: PgBoss, payload: PollPayload) {
  const jobs = await boss.findJobs<PollPayload>(POLL_QUEUE, { data: PollPayload.parse(payload), queued: true, limit: 100_000 });
  return jobs.filter((j) => j.state === "created" || j.state === "retry");
}

/** Cancels all but one queued run of a chain, so a chain forked before runs were keyed comes back to one. Returns how many are left. */
export async function trimPolls(boss: PgBoss, payload: PollPayload): Promise<number> {
  const ids = (await queuedPolls(boss, payload)).map((j) => j.id);
  if (ids.length > 1) await boss.cancel(POLL_QUEUE, ids.slice(1));
  return Math.min(ids.length, 1);
}

export async function cancelPolls(boss: PgBoss, payload: PollPayload): Promise<void> {
  const ids = (await queuedPolls(boss, payload)).map((j) => j.id);
  if (ids.length) await boss.cancel(POLL_QUEUE, ids);
}

/** Works the queue. A malformed payload fails the job; it is never guessed at. */
export async function workPolls(boss: PgBoss, handle: (p: PollPayload) => Promise<void>): Promise<string> {
  await ensurePollQueue(boss);
  return boss.work(POLL_QUEUE, { pollingIntervalSeconds: 1 }, async (jobs) => {
    for (const job of jobs) await handle(PollPayload.parse(job.data));
  });
}
