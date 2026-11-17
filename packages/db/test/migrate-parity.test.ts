// SPDX-License-Identifier: AGPL-3.0-only
// The runner against drizzle's own migrator on the real migrations (ADR 0029 rule 004): same
// schema, same record, and an upgrade from a database drizzle-kit migrated part-way.
import { cpSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pg from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate as drizzleMigrate } from "drizzle-orm/node-postgres/migrator";
import { afterAll, expect, test } from "vitest";
import { migrate, migrationState, NO_TRANSACTION } from "@direx/db/migrate";
import { asOwner, requireEnv, withDatabase } from "../../../test/db";
import { fileURLToPath } from "node:url";

const FOLDER = fileURLToPath(new URL("../migrations", import.meta.url));
const made: { name: string; client: pg.Client }[] = [];
afterAll(async () => {
  for (const { name, client } of made) {
    await client.end().catch(() => {});
    await asOwner((c) => c.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`));
  }
});

async function database(): Promise<pg.Client> {
  const name = `direx_p_${crypto.randomUUID().replaceAll("-", "")}`;
  await asOwner((c) => c.query(`CREATE DATABASE ${name}`));
  const client = new pg.Client(withDatabase(requireEnv("DIREX_DB_OWNER_URL"), name));
  await client.connect();
  made.push({ name, client });
  return client;
}

/** Everything a migration can change, as sorted text. */
async function schema(c: pg.Client): Promise<string[]> {
  const queries = [
    `select table_schema||'.'||table_name||'.'||column_name||' '||data_type||' '||is_nullable||' '||coalesce(column_default,'') from information_schema.columns where table_schema not in ('pg_catalog','information_schema')`,
    `select conrelid::regclass||' '||conname||' '||pg_get_constraintdef(oid) from pg_constraint where connamespace::regnamespace::text not in ('pg_catalog','information_schema')`,
    `select schemaname||' '||indexdef from pg_indexes where schemaname not in ('pg_catalog','information_schema')`,
    `select schemaname||'.'||tablename||' '||policyname||' '||cmd||' '||coalesce(qual,'')||' '||coalesce(with_check,'') from pg_policies`,
    `select p.oid::regprocedure||' '||pg_get_functiondef(p.oid) from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname not in ('pg_catalog','information_schema') and p.prokind in ('f','p')`,
    `select grantee||' '||table_schema||'.'||table_name||' '||privilege_type from information_schema.role_table_grants where table_schema not in ('pg_catalog','information_schema')`,
    `select tgrelid::regclass||' '||pg_get_triggerdef(oid) from pg_trigger where not tgisinternal`,
    `select relname||' '||relrowsecurity||' '||relforcerowsecurity from pg_class where relkind = 'r' and relnamespace::regnamespace::text not in ('pg_catalog','information_schema')`,
  ];
  const out: string[] = [];
  for (const q of queries) out.push(...(await c.query(q)).rows.map((r: Record<string, string>) => Object.values(r)[0]!));
  return out.sort();
}

const record = async (c: pg.Client) =>
  (await c.query<{ hash: string; created_at: string }>("select hash, created_at from drizzle.__drizzle_migrations order by id")).rows;

let ours: pg.Client;

/**
 * A copy of the migrations folder whose journal stops before the first no-transaction file, which
 * drizzle's migrator can never run (it wraps every file in one transaction), less `drop` more files.
 */
function drizzlePrefix(drop = 0): { dir: string; length: number } {
  const dir = mkdtempSync(join(tmpdir(), "direx-prefix-"));
  cpSync(FOLDER, dir, { recursive: true });
  const journalPath = join(dir, "meta/_journal.json");
  const journal = JSON.parse(readFileSync(journalPath, "utf8")) as { entries: { tag: string }[] };
  const marked = journal.entries.findIndex((e) => readFileSync(join(FOLDER, `${e.tag}.sql`), "utf8").startsWith(NO_TRANSACTION));
  const end = (marked === -1 ? journal.entries.length : marked) - drop;
  journal.entries = journal.entries.slice(0, end);
  writeFileSync(journalPath, JSON.stringify(journal));
  return { dir, length: end };
}

test("a fresh database gets the same schema and record as drizzle's migrator gives, up to the first file only the runner can run", { timeout: 120_000 }, async () => {
  const { dir } = drizzlePrefix();
  const theirs = await database();
  ours = await database();
  await drizzleMigrate(drizzle(theirs), { migrationsFolder: dir });
  await migrate(ours, dir);
  expect(await record(ours)).toEqual(await record(theirs));
  expect(await schema(ours)).toEqual(await schema(theirs));
  // The runner alone takes the database the rest of the way.
  await migrate(ours, FOLDER);
  expect(await migrationState(ours, FOLDER)).toEqual({ pending: [], unknown: [], drifted: [] });
});

test("a database drizzle migrated part-way upgrades without re-running or skipping a file", { timeout: 120_000 }, async () => {
  const { dir, length } = drizzlePrefix(20);
  const total = (JSON.parse(readFileSync(join(FOLDER, "meta/_journal.json"), "utf8")) as { entries: unknown[] }).entries.length;

  const c = await database();
  await drizzleMigrate(drizzle(c), { migrationsFolder: dir });
  expect((await migrationState(c, FOLDER)).pending).toHaveLength(total - length);

  const ran: string[] = [];
  await migrate(c, FOLDER, (t) => ran.push(t));
  expect(ran).toHaveLength(total - length);
  expect(await record(c)).toEqual(await record(ours));
  expect(await schema(c)).toEqual(await schema(ours));
});
