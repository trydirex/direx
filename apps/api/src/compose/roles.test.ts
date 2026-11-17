// SPDX-License-Identifier: AGPL-3.0-only
// What each role registers (ADR 0027 rule 002). The role decides only whether a process works and
// schedules queues: `api` creates the queues `all` creates and works and schedules none, `worker`
// registers exactly what `all` does. `start.test.ts` ties `all` to the list recorded before the
// composition root. Built through testWorker, the server's own ports, so the start-up refusals in
// startup.ts (tested in roles.test.ts) don't stand in the way.
import { PgBoss } from "pg-boss";
import { expect, test, vi } from "vitest";
import { vaultFromEnv } from "../modules/credentials/index";
import type { Role } from "../roles";
import { testWorker } from "./fixtures/worker";

process.env.DIREX_MASTER_KEY = "11".repeat(32);
type Registration = { kind: "queue" | "schedule" | "work"; name: string; cron?: string };

const seen: Registration[] = [];
const realCreateQueue = PgBoss.prototype.createQueue;
vi.spyOn(PgBoss.prototype, "createQueue").mockImplementation(async function (this: PgBoss, name, options) {
  seen.push({ kind: "queue", name });
  return realCreateQueue.call(this, name, options);
});
const realSchedule = PgBoss.prototype.schedule;
vi.spyOn(PgBoss.prototype, "schedule").mockImplementation(async function (this: PgBoss, name, cron, data, options) {
  seen.push({ kind: "schedule", name, cron });
  return realSchedule.call(this, name, cron, data, options);
});
const realWork = PgBoss.prototype.work as (...a: unknown[]) => Promise<string>;
vi.spyOn(PgBoss.prototype, "work").mockImplementation(async function (this: PgBoss, ...args: unknown[]) {
  seen.push({ kind: "work", name: args[0] as string });
  return realWork.apply(this, args);
});

/** Starts the worker side in `role` and returns what it registered, sorted. */
async function registered(role: Role) {
  seen.length = 0;
  const worker = await testWorker({ vault: vaultFromEnv({ baseURL: "http://localhost:3000" }), mailer: async () => {}, role });
  await worker.stop();
  return seen.map((r) => JSON.stringify(r)).sort();
}

test("an api process creates every queue all creates, so its sends land, and works and schedules none", { timeout: 60_000 }, async () => {
  const all = await registered("all");
  const api = await registered("api");
  expect(api).toEqual(all.filter((r) => (JSON.parse(r) as Registration).kind === "queue"));
  expect(api.length).toBeGreaterThan(30);
  expect(all.some((r) => (JSON.parse(r) as Registration).kind === "work")).toBe(true);
});

test("a worker process registers every queue, schedule and consumer all does", { timeout: 60_000 }, async () => {
  expect(await registered("worker")).toEqual(await registered("all"));
});
