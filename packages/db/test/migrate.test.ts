// SPDX-License-Identifier: AGPL-3.0-only
// The migration runner (ADR 0029), each case on small migrations in its own database.
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pg from "pg";
import { afterEach, expect, test } from "vitest";
import { databaseMigrationState, migrate, migrateDatabase, migrationState, NO_TRANSACTION } from "@direx/db/migrate";
import { appClient, asOwner, requireEnv, withDatabase } from "../../../test/db";

const BP = "\n--> statement-breakpoint\n";
const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const f of cleanup.splice(0).reverse()) await f();
});

/** A migrations folder holding these files, in order. */
function folder(files: [tag: string, sql: string][]): string {
  const dir = mkdtempSync(join(tmpdir(), "direx-runner-"));
  mkdirSync(join(dir, "meta"));
  const entries = files.map(([tag], idx) => ({ idx, version: "7", when: 1_700_000_000_000 + idx, tag, breakpoints: true }));
  writeFileSync(join(dir, "meta/_journal.json"), JSON.stringify({ version: "7", dialect: "postgresql", entries }));
  for (const [tag, sql] of files) writeFileSync(join(dir, `${tag}.sql`), sql);
  return dir;
}

/** A new empty database and an owner client on it. */
async function database(): Promise<{ name: string; client: () => Promise<pg.Client> }> {
  const name = `direx_m_${crypto.randomUUID().replaceAll("-", "")}`;
  await asOwner((c) => c.query(`CREATE DATABASE ${name}`));
  const clients: pg.Client[] = [];
  cleanup.push(async () => {
    for (const c of clients) await c.end().catch(() => {});
    await asOwner((c) => c.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`));
  });
  return {
    name,
    client: async () => {
      const c = new pg.Client(withDatabase(requireEnv("DIREX_DB_OWNER_URL"), name));
      await c.connect();
      clients.push(c);
      return c;
    },
  };
}

const records = async (c: pg.Client) => (await c.query<{ n: string }>("select count(*) as n from drizzle.__drizzle_migrations")).rows[0]!.n;

test("a failing file stops the run there, with the earlier files applied and recorded", async () => {
  const db = await database();
  const c = await db.client();
  const files: [string, string][] = [
    ["0000_a", "create table a (id int)"],
    ["0001_b", "create table b (id int)"],
    ["0002_c", "insert into nope values (1)"],
    ["0003_d", "create table d (id int)"],
  ];
  const dir = folder(files);
  await expect(migrate(c, dir)).rejects.toThrow(/migration 0002_c failed: relation "nope" does not exist/);
  expect(await records(c)).toBe("2");
  expect((await c.query("select to_regclass('b') as t")).rows[0].t).toBe("b");
  expect(await migrationState(c, dir)).toEqual({ pending: ["0002_c", "0003_d"], unknown: [], drifted: [] });

  writeFileSync(join(dir, "0002_c.sql"), "create table c (id int)");
  const ran: string[] = [];
  await migrate(c, dir, (t) => ran.push(t));
  expect(ran).toEqual(["0002_c", "0003_d"]);
  expect(await records(c)).toBe("4");
  expect(await migrationState(c, dir)).toEqual({ pending: [], unknown: [], drifted: [] });
});

test("a rolled-back file leaves nothing behind", async () => {
  const db = await database();
  const c = await db.client();
  const dir = folder([["0000_a", `create table a (id int)${BP}insert into nope values (1)`]]);
  await expect(migrate(c, dir)).rejects.toThrow(/0000_a/);
  expect((await c.query("select to_regclass('a') as t")).rows[0].t).toBeNull();
  expect(await records(c)).toBe("0");
});

test("a marked file builds an index concurrently, and an invalid build fails until it is rebuilt", async () => {
  const db = await database();
  const c = await db.client();
  const base: [string, string] = ["0000_t", "create table t (v int); insert into t values (1), (1)"];
  const build = `${NO_TRANSACTION}\nDROP INDEX CONCURRENTLY IF EXISTS t_v${BP}CREATE UNIQUE INDEX CONCURRENTLY t_v ON t (v)`;
  const dir = folder([base, ["0001_t_v", build]]);

  // Duplicates make the unique build fail, which leaves an invalid index behind.
  await expect(migrate(c, dir)).rejects.toThrow(/migration 0001_t_v failed/);
  expect(await records(c)).toBe("1");
  expect((await c.query("select indisvalid from pg_index where indexrelid = 't_v'::regclass")).rows[0].indisvalid).toBe(false);

  await c.query("delete from t where ctid <> (select min(ctid) from t)");
  await migrate(c, dir);
  expect(await records(c)).toBe("2");
  expect((await c.query("select indisvalid from pg_index where indexrelid = 't_v'::regclass")).rows[0].indisvalid).toBe(true);
});

test("a marked file that skips an invalid index with IF NOT EXISTS is refused", async () => {
  const db = await database();
  const c = await db.client();
  await c.query("create table t (v int); insert into t values (1), (1)");
  await expect(c.query("CREATE UNIQUE INDEX CONCURRENTLY t_v ON t (v)")).rejects.toThrow();
  const dir = folder([["0000_t_v", `${NO_TRANSACTION}\nCREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS t_v ON t (v)`]]);
  await expect(migrate(c, dir)).rejects.toThrow(/index t_v is invalid/);
  expect(await records(c)).toBe("0");
});

test("two runners at once apply each file once", async () => {
  const db = await database();
  const [a, b] = [await db.client(), await db.client()];
  const dir = folder([
    ["0000_a", "create table a (id int)"],
    ["0001_b", "select pg_sleep(0.3); create table b (id int)"],
  ]);
  await Promise.all([migrate(a, dir), migrate(b, dir)]);
  expect(await records(a)).toBe("2");
});

test("a record the folder does not know is refused", async () => {
  const db = await database();
  const c = await db.client();
  const dir = folder([["0000_a", "create table a (id int)"]]);
  await migrate(c, dir);
  await c.query("insert into drizzle.__drizzle_migrations (hash, created_at) values ('made-up', 1)");
  expect(await migrationState(c, dir)).toEqual({ pending: [], unknown: ["1"], drifted: [] });
  await expect(migrate(c, folder([["0000_a", "create table a (id int)"], ["0001_b", "create table b (id int)"]]))).rejects.toThrow(
    /1 applied migration\(s\) this checkout does not/,
  );
});

test("a file that cannot get its lock fails after the lock timeout and is not recorded", { timeout: 20_000 }, async () => {
  const db = await database();
  const [c, holder] = [await db.client(), await db.client()];
  await c.query("create table t (id int)");
  await holder.query("begin; lock table t in access exclusive mode");
  const started = Date.now();
  await expect(migrate(c, folder([["0000_alter", "alter table t add column x int"]]))).rejects.toThrow(/lock timeout/);
  expect(Date.now() - started).toBeLessThan(10_000);
  expect(await records(c)).toBe("0");
  await holder.query("rollback");
});

test("state before any migration counts every file as pending", async () => {
  const db = await database();
  const c = await db.client();
  expect(await migrationState(c, folder([["0000_a", "select 1"]]))).toEqual({ pending: ["0000_a"], unknown: [], drifted: [] });
});

test("a file changed after it was applied is reported as drifted and not run again", async () => {
  const db = await database();
  const c = await db.client();
  const dir = folder([["0000_a", "create table a (id int)"]]);
  expect(await migrate(c, dir)).toEqual([]);
  writeFileSync(join(dir, "0000_a.sql"), "create table a (id int, x int)");
  expect(await migrationState(c, dir)).toEqual({ pending: [], unknown: [], drifted: ["0000_a"] });
  expect(await migrate(c, dir)).toEqual(["0000_a"]);
  expect(await records(c)).toBe("1");
});

test("the app role can read the record but not change it", async () => {
  const c = await appClient();
  try {
    expect(Number((await c.query("select count(*) as n from drizzle.__drizzle_migrations")).rows[0].n)).toBeGreaterThan(0);
    await expect(c.query("insert into drizzle.__drizzle_migrations (hash, created_at) values ('x', 1)")).rejects.toThrow(/permission denied/);
    await expect(c.query("delete from drizzle.__drizzle_migrations")).rejects.toThrow(/permission denied/);
  } finally {
    await c.end();
  }
});

test("the url helpers open their own connection, migrate and report", async () => {
  const db = await database();
  const url = withDatabase(requireEnv("DIREX_DB_OWNER_URL"), db.name);
  const dir = folder([["0000_a", "create table a (id int)"]]);
  expect(await databaseMigrationState(url, dir)).toEqual({ pending: ["0000_a"], unknown: [], drifted: [] });
  const ran: string[] = [];
  expect(await migrateDatabase(url, dir, (t) => ran.push(t))).toEqual([]);
  expect(ran).toEqual(["0000_a"]);
  expect(await databaseMigrationState(url, dir)).toEqual({ pending: [], unknown: [], drifted: [] });
});

test("a failure reading the record other than a missing table or grant is not hidden", async () => {
  const broken = { query: async () => Promise.reject(Object.assign(new Error("connection reset"), { code: "08006" })) } as unknown as pg.Client;
  await expect(migrationState(broken, folder([["0000_a", "select 1"]]))).rejects.toThrow(/connection reset/);
});
