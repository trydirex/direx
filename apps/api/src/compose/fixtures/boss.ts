// SPDX-License-Identifier: AGPL-3.0-only
// Test only: a pg-boss that records the queues, crons and handlers an area registers, and the `later`
// that collects its starts, so a test can run the starts and then call any handler directly.
import type { PgBoss } from "pg-boss";

type Handler = (jobs: { data: unknown }[]) => Promise<unknown>;

export function recordedBoss() {
  const queues: string[] = [];
  const crons = new Map<string, string>();
  const handlers = new Map<string, Handler>();
  const sent: { queue: string; data: unknown }[] = [];
  const boss = {
    createQueue: async (name: string) => void queues.push(name),
    schedule: async (name: string, cron: string) => void crons.set(name, cron),
    work: async (name: string, ...rest: unknown[]) => void handlers.set(name, rest[rest.length - 1] as Handler),
    send: async (queue: string, data: unknown) => {
      sent.push({ queue, data });
      return "job";
    },
  } as unknown as Pick<PgBoss, "createQueue" | "schedule" | "work" | "send">;
  const starts: (() => Promise<unknown>)[] = [];
  const later = (s: () => Promise<unknown>) => void starts.push(s);
  /** Runs every collected start, as startWork does. */
  const start = async () => {
    for (const s of starts) await s();
  };
  /** Calls the handler registered for `queue` with these jobs' data. */
  const run = (queue: string, ...data: unknown[]) => {
    const h = handlers.get(queue);
    if (!h) throw new Error(`no handler for ${queue}`);
    return h(data.map((d) => ({ data: d })));
  };
  return { boss, later, start, run, queues, crons, handlers, sent };
}
