// SPDX-License-Identifier: AGPL-3.0-only
// The queues, schedules and consumers the server registers, against a list recorded before the
// composition-root refactor (ADR 0027 rules 001 and 003). Moving construction around must not add,
// drop or reconfigure one. DIREX_RECORD_QUEUES=1 rewrites the list; review that diff like code.
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { PgBoss } from "pg-boss";
import { afterAll, expect, test, vi } from "vitest";
import { runServer } from "../main";

process.env.DIREX_MASTER_KEY = "11".repeat(32);
const FIXTURE = join(import.meta.dirname, "fixtures", "queues.json");

type Registration = { kind: "queue" | "schedule" | "work"; name: string; cron?: string; options: unknown };
const seen: Registration[] = [];
// Each spy records the call and passes it through, so the server starts as it always does.
const realCreateQueue = PgBoss.prototype.createQueue;
vi.spyOn(PgBoss.prototype, "createQueue").mockImplementation(async function (this: PgBoss, name, options) {
  seen.push({ kind: "queue", name, options: options ?? null });
  return realCreateQueue.call(this, name, options);
});
const realSchedule = PgBoss.prototype.schedule;
vi.spyOn(PgBoss.prototype, "schedule").mockImplementation(async function (this: PgBoss, name, cron, data, options) {
  seen.push({ kind: "schedule", name, cron, options: { data: data ?? null, ...options } });
  return realSchedule.call(this, name, cron, data, options);
});
const realWork = PgBoss.prototype.work as (...a: unknown[]) => Promise<string>;
vi.spyOn(PgBoss.prototype, "work").mockImplementation(async function (this: PgBoss, ...args: unknown[]) {
  seen.push({ kind: "work", name: args[0] as string, options: typeof args[1] === "function" ? null : args[1] });
  return realWork.apply(this, args);
});

const worker = await runServer();
afterAll(() => worker.stop());

test("the server registers the same queues, schedules and consumers as before the refactor", () => {
  const list = seen.map((r) => JSON.stringify(r)).sort();
  if (process.env.DIREX_RECORD_QUEUES === "1") writeFileSync(FIXTURE, `${JSON.stringify(list.map((s) => JSON.parse(s)), null, 2)}\n`);
  const recorded = (JSON.parse(readFileSync(FIXTURE, "utf8")) as unknown[]).map((r) => JSON.stringify(r)).sort();
  expect(list).toEqual(recorded);
  expect(list.length).toBeGreaterThan(30);
});
