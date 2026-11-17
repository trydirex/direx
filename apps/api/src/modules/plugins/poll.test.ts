// SPDX-License-Identifier: AGPL-3.0-only
// Polling: a chain of delayed jobs, a cursor moved only by compare-and-set, and each
// event handed off once even when polls overlap or race.
import { join } from "node:path";
import { afterAll, expect, test } from "vitest";
import { createBoss } from "../../jobs/boss";
import { inWorkspace, lastPollAt } from "./adapters/trigger-repo";
import { behaveManifest } from "./fixtures/manifest";
import { loadPlugins, type TriggerEvent } from "./index";

const dir = join(import.meta.dirname, "fixtures");
const PLUGIN = "com.example.behave";
const FEED = "behave.feed";
const handed: TriggerEvent[] = [];
const logs: string[] = [];
let failNext = false;
const clock = { at: new Date("2026-11-02T09:00:00Z") };

const boss = createBoss();
await boss.start();
const plugins = loadPlugins({
  sources: [{ mode: "process", manifest: behaveManifest, entry: join(dir, "behave.ts"), dir }],
  credentials: async (ws) => ({ accessToken: `tok-${ws}`, expiresAt: "2026-11-02T10:00:00Z" }),
  confinement: "external",
  log: (l) => logs.push(l),
  boss,
  now: () => clock.at,
  onEvent: async (_tx, e) => {
    if (failNext) {
      failNext = false;
      throw new Error("consumer failed");
    }
    handed.push(e);
  },
});
await boss.createQueue("plugins.poll");
afterAll(async () => {
  await plugins.close({ force: true });
  await boss.stop({ graceful: false, close: true });
});

const run = (workspaceId: string) => plugins.runPoll({ workspaceId, pluginId: PLUGIN, trigger: FEED });
const forWs = (ws: string) => handed.filter((e) => e.workspaceId === ws).map((e) => e.eventId);
const queued = async (ws: string) =>
  (await boss.findJobs("plugins.poll", { data: { workspaceId: ws, pluginId: PLUGIN, trigger: FEED }, queued: true }))
    .filter((j) => j.state === "created")
    .map((j) => j.startAfter);

test("overlapping polls hand each event off once; a crash keeps the cursor and records nothing", async () => {
  const W = crypto.randomUUID();
  expect(await run(W)).toBe("handed_off");
  expect(forWs(W)).toEqual(["e1", "e2"]);
  expect(await run(W)).toBe("handed_off");
  expect(forWs(W)).toEqual(["e1", "e2", "e3"]);
  // Cursor 3 makes the plugin process exit mid-poll.
  expect(await run(W)).toBe("failed");
  expect(forWs(W)).toEqual(["e1", "e2", "e3"]);
  expect(await run(W)).toBe("failed");
  expect(logs.some((l) => l.includes(`poll ${FEED} failed`))).toBe(true);
});

test("each run queues the next one a poll interval later, and stopPolling ends the chain", async () => {
  const W = crypto.randomUUID();
  await plugins.startPolling(W, PLUGIN, FEED);
  await plugins.startPolling(W, PLUGIN, FEED);
  expect(await queued(W)).toEqual([clock.at]);
  await plugins.stopPolling(W, PLUGIN, FEED);
  expect(await queued(W)).toEqual([]);

  await run(W);
  expect(await queued(W)).toEqual([new Date(clock.at.getTime() + 60_000)]);
  await plugins.stopPolling(W, PLUGIN, FEED);
  expect(await queued(W)).toEqual([]);
});

test("a chain never forks: starts at once queue one run, and a chain already forked comes back to one", async () => {
  const W = crypto.randomUUID();
  const p = { workspaceId: W, pluginId: PLUGIN, trigger: FEED, credentialId: null };
  // A day of runs already done: more than one page of finished jobs must not hide the queued one.
  await boss.insert("plugins.poll", Array.from({ length: 1001 }, () => ({ data: p })));
  const done = await boss.fetch("plugins.poll", { batchSize: 1001 });
  await boss.complete("plugins.poll", done.map((j) => j.id));
  await Promise.all([plugins.startPolling(W, PLUGIN, FEED), plugins.startPolling(W, PLUGIN, FEED), plugins.startPolling(W, PLUGIN, FEED)]);
  expect(await queued(W)).toHaveLength(1);
  await plugins.startPolling(W, PLUGIN, FEED);
  expect(await queued(W)).toHaveLength(1);
  // Jobs queued before runs were keyed, as two workers finishing at once left them.
  await boss.send("plugins.poll", p, { startAfter: clock.at });
  await boss.send("plugins.poll", p, { startAfter: clock.at });
  expect(await queued(W)).toHaveLength(3);
  await run(W);
  expect(await queued(W)).toHaveLength(1);
  await plugins.stopPolling(W, PLUGIN, FEED);
});

test("the poll payload is exactly workspace, plugin and trigger", async () => {
  await expect(plugins.runPoll({ workspaceId: crypto.randomUUID(), pluginId: PLUGIN, trigger: FEED, cursor: "9" })).rejects.toThrow();
  await expect(plugins.runPoll({ workspaceId: "not-a-uuid", pluginId: PLUGIN, trigger: FEED })).rejects.toThrow();
});

test("two polls racing on one cursor: one moves it, the other changes nothing", async () => {
  const W = crypto.randomUUID();
  const outcomes = await Promise.all([run(W), run(W)]);
  expect(outcomes.sort()).toEqual(["handed_off", "stale"]);
  expect(forWs(W)).toEqual(["e1", "e2"]);
  expect(await run(W)).toBe("handed_off");
  expect(forWs(W)).toEqual(["e1", "e2", "e3"]);
});

test("a consumer that fails rolls back the events and the cursor; the next poll hands them off once", async () => {
  const W = crypto.randomUUID();
  failNext = true;
  expect(await run(W)).toBe("failed");
  expect(forWs(W)).toEqual([]);
  expect(await run(W)).toBe("handed_off");
  expect(forWs(W)).toEqual(["e1", "e2"]);
});

test("two mailboxes in one workspace keep their own cursors and see their own events", async () => {
  const W = crypto.randomUUID();
  const A = crypto.randomUUID();
  const B = crypto.randomUUID();
  const poll = (credentialId: string) => plugins.runPoll({ workspaceId: W, pluginId: PLUGIN, trigger: FEED, credentialId });
  const of = (credentialId: string) => handed.filter((e) => e.workspaceId === W && e.credentialId === credentialId).map((e) => e.eventId);
  expect(await poll(A)).toBe("handed_off");
  expect(await poll(B)).toBe("handed_off");
  expect(await poll(A)).toBe("handed_off");
  expect(of(A)).toEqual(["e1", "e2", "e3"]);
  expect(of(B)).toEqual(["e1", "e2"]);
});

test("a good poll moves the time on its cursor, and a failed one doesn't", async () => {
  const W = crypto.randomUUID();
  const lastPoll = () => inWorkspace(W, (tx) => lastPollAt(tx, { workspaceId: W, pluginId: PLUGIN, trigger: FEED, credentialId: null }));
  const started = clock.at;
  await run(W);
  expect(await lastPoll()).toEqual(started);
  const later = new Date(started.getTime() + 60_000);
  clock.at = later;
  await run(W);
  expect(await lastPoll()).toEqual(later);
  // The cursor has reached the value that makes the plugin process exit mid-poll.
  clock.at = new Date(later.getTime() + 60_000);
  expect(await run(W)).toBe("failed");
  expect(await lastPoll()).toEqual(later);
  clock.at = started;
});

test("a trigger that is no longer loaded records nothing and stops its chain", async () => {
  const W = crypto.randomUUID();
  expect(await plugins.runPoll({ workspaceId: W, pluginId: "com.example.gone", trigger: FEED })).toBe("not_loaded");
  expect(await queued(W)).toEqual([]);
});
