// SPDX-License-Identifier: AGPL-3.0-only
// An api process and a worker process against one database (ADR 0027 rule 005): work crosses only
// through Postgres. An Action approved on the api side waits, since that side works no queue, and is
// sent by the worker side once it starts. Both are built from the server's own ports (testWorker).
import type { EffectCapability } from "@direx/plugin-sdk";
import { afterAll, expect, test } from "vitest";
import { testWorker } from "./compose/fixtures/worker";
import { seedMember } from "./modules/identity/fixtures/member";
import { oneKey } from "./modules/ledger/index";
import { approver, scheduledAction, testKey } from "./modules/ledger/test-effects";

const W = crypto.randomUUID();
// The worker side runs the approver check, so the approver must be a member of W.
await seedMember(W, approver);
const calls: unknown[] = [];
const effects: Record<string, EffectCapability> = {
  "test.split": { dedupe: "blind", reachesPerson: false, execute: async (spec) => (calls.push(spec), { kind: "sent" }) },
};
const stops: (() => Promise<void>)[] = [];
afterAll(async () => {
  for (const stop of stops.reverse()) await stop();
});

test("an Action approved on an api process is sent by a worker process, and never by the api one", { timeout: 60_000 }, async () => {
  const api = await testWorker({ signingKeys: oneKey(testKey), effects, role: "api" });
  stops.push(api.stop);
  const id = await scheduledAction(api.ledger, W, "test.split", "blind", { spec: { to: "dana@example.com", body: "across" } });
  // The wake is queued in Postgres, and nothing on the api side claims it.
  await Bun.sleep(3_000);
  expect(calls).toEqual([]);
  expect((await api.ledger.getAction(W, id))!.state).not.toBe("sent");

  const worker = await testWorker({ signingKeys: oneKey(testKey), effects, role: "worker" });
  stops.push(worker.stop);
  await expect.poll(async () => (await api.ledger.getAction(W, id))!.state, { timeout: 30_000, interval: 250 }).toBe("sent");
  expect(calls).toEqual([{ to: "dana@example.com", body: "across" }]);
});

test("an api process drains at once on a stop, since it holds no queue work (rule 004)", { timeout: 60_000 }, async () => {
  const api = await testWorker({ signingKeys: oneKey(testKey), effects, role: "api" });
  const started = Date.now();
  await api.drain(10_000);
  expect(Date.now() - started).toBeLessThan(5_000);
  await api.close();
});
