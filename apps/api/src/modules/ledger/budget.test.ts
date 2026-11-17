// SPDX-License-Identifier: AGPL-3.0-only
// Budget reservations as the forced-RLS app role, through the module's entry point.
import { afterAll, beforeAll, expect, test } from "vitest";
import { appClient } from "../../../../../test/db";
import { utcMonth, withBudget } from "./index";


let c: Awaited<ReturnType<typeof appClient>>;
beforeAll(async () => {
  c = await appClient();
});
afterAll(() => c.end());

const NOW = new Date("2026-11-15T12:00:00Z");

async function newWorkspace() {
  const org = crypto.randomUUID();
  const ws = crypto.randomUUID();
  await c.query("begin");
  await c.query("select set_config('app.workspace_id', $1, true)", [ws]);
  await c.query("insert into organizations (id, name, created_at) values ($1, 'O', now())", [org]);
  await c.query("insert into workspaces (id, org_id, name, created_at) values ($1, $2, 'W', now())", [ws, org]);
  await c.query("commit");
  return ws;
}

const spent = (ws: string, at = NOW) => withBudget(ws, (b) => b.spent("model", at));
const settled = (ws: string, at = NOW) => withBudget(ws, (b) => b.settled("model", at));

test("a UTC month runs from its first instant to the next month's", () => {
  const m = utcMonth(new Date("2026-12-31T23:59:59Z"));
  expect(m.key).toBe("2026-12");
  expect(m.start.toISOString()).toBe("2026-12-01T00:00:00.000Z");
  expect(m.end.toISOString()).toBe("2027-01-01T00:00:00.000Z");
});

test("a hold counts as spent and not as settled; settling records the real amount", async () => {
  const ws = await newWorkspace();
  const id = await withBudget(ws, (b) => b.hold("model", 100n, NOW));
  expect(await spent(ws)).toBe(100n);
  expect(await settled(ws)).toBe(0n);
  await withBudget(ws, (b) => b.settle(id, 40n, NOW));
  expect(await spent(ws)).toBe(40n);
  expect(await settled(ws)).toBe(40n);
});

test("a release frees a hold, and undoes a charge made before the provider's answer arrived", async () => {
  const ws = await newWorkspace();
  const released = await withBudget(ws, (b) => b.hold("model", 100n, NOW));
  await withBudget(ws, (b) => b.release(released, NOW));
  expect(await spent(ws)).toBe(0n);

  const swept = await withBudget(ws, (b) => b.hold("model", 100n, NOW));
  await withBudget(ws, (b) => b.settle(swept, 100n, NOW));
  await withBudget(ws, (b) => b.release(swept, NOW));
  expect(await settled(ws)).toBe(0n);
});

test("a late receipt corrects a settled amount, but a released row stays released", async () => {
  const ws = await newWorkspace();
  const id = await withBudget(ws, (b) => b.hold("model", 100n, NOW));
  await withBudget(ws, (b) => b.settle(id, 100n, NOW));
  await withBudget(ws, (b) => b.settle(id, 7n, NOW));
  expect(await settled(ws)).toBe(7n);

  const gone = await withBudget(ws, (b) => b.hold("model", 100n, NOW));
  await withBudget(ws, (b) => b.release(gone, NOW));
  await withBudget(ws, (b) => b.settle(gone, 50n, NOW));
  expect(await settled(ws)).toBe(7n);
});

test("a hold counts in the month it was taken", async () => {
  const ws = await newWorkspace();
  await withBudget(ws, (b) => b.hold("model", 100n, new Date("2026-11-30T23:59:59Z")));
  expect(await spent(ws, new Date("2026-11-01T00:00:00Z"))).toBe(100n);
  expect(await spent(ws, new Date("2026-12-01T00:00:00Z"))).toBe(0n);
});

test("50 concurrent callers against a limit never hold more than it", async () => {
  const ws = await newWorkspace();
  const LIMIT = 500n;
  const results = await Promise.all(
    Array.from({ length: 50 }, () =>
      withBudget(ws, async (b) => {
        if ((await b.spent("model", NOW)) + 30n > LIMIT) return false;
        await b.hold("model", 30n, NOW);
        return true;
      }),
    ),
  );
  expect(results.filter(Boolean)).toHaveLength(16);
  expect(await spent(ws)).toBe(480n);
});

test("another Workspace's reservations are invisible", async () => {
  const [a, b] = [await newWorkspace(), await newWorkspace()];
  const id = await withBudget(a, (x) => x.hold("model", 100n, NOW));
  expect(await spent(b)).toBe(0n);
  await withBudget(b, (x) => x.settle(id, 1n, NOW));
  expect(await settled(a)).toBe(0n);
});
