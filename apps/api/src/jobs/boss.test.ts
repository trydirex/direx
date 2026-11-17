// SPDX-License-Identifier: AGPL-3.0-only
import { readFileSync } from "node:fs";
import { expect, test } from "vitest";
import { bossConfig, createBoss } from "./boss";
import { appClient } from "../../../../test/db";

test("the pg-boss constructor disables migrate and createSchema", () => {
  const source = readFileSync(new URL("./boss.ts", import.meta.url), "utf8");
  expect(source).toMatch(/\bmigrate: false\b/);
  expect(source).toMatch(/\bcreateSchema: false\b/);
});

test("direx_app enqueues and works one job", async () => {
  const boss = createBoss();
  const errors: unknown[] = [];
  boss.on("error", (e) => errors.push(e));
  await boss.start();
  try {
    await boss.createQueue("c19");
    const worked = Promise.withResolvers<string>();
    await boss.work("c19", { pollingIntervalSeconds: 0.5 }, async ([job]) => worked.resolve(job!.id));
    const id = await boss.send("c19", { hello: "direx" });
    expect(await worked.promise).toBe(id);
    await expect.poll(async () => (await boss.getJobById("c19", id!))?.state).toBe("completed");
  } finally {
    await boss.stop({ graceful: true, timeout: 5000 });
  }
  expect(errors).toEqual([]);
});

test("a boss that consumes fires schedules and runs maintenance; one that doesn't, neither", () => {
  expect(bossConfig("postgres://x", true)).toMatchObject({ schedule: true, supervise: true });
  expect(bossConfig("postgres://x", false)).toMatchObject({ schedule: false, supervise: false });
});

test("a boss that doesn't consume still creates queues and sends to them", async () => {
  const boss = createBoss({ consume: false });
  await boss.start();
  try {
    await boss.createQueue("c19_send_only");
    const id = await boss.send("c19_send_only", { hello: "direx" });
    expect((await boss.getJobById("c19_send_only", id!))?.state).toBe("created");
  } finally {
    await boss.stop({ graceful: true, timeout: 5000 });
  }
});

test("direx_app owns nothing in the pgboss schema", async () => {
  const c = await appClient();
  try {
    const { rows } = await c.query(
      `select current_user as who, count(*) filter (where pg_get_userbyid(cl.relowner) = current_user)::int as owned,
              count(*)::int as total
         from pg_class cl join pg_namespace n on n.oid = cl.relnamespace where n.nspname = 'pgboss'`,
    );
    expect(rows[0]).toMatchObject({ who: "direx_app", owned: 0 });
    expect(rows[0].total).toBeGreaterThan(0);
  } finally {
    await c.end();
  }
});
