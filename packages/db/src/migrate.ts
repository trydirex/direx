// SPDX-License-Identifier: AGPL-3.0-only
// Applies migrations one file at a time (ADR 0029). Each unmarked file runs in its own
// transaction with a lock and a statement timeout, and is recorded in that transaction. A file
// whose first line is the marker runs outside a transaction, one statement at a time, so
// CREATE INDEX CONCURRENTLY works. The record is drizzle's own table, so drizzle-kit can still
// read it (DX-R-0029-004).
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import pg from "pg";

export const NO_TRANSACTION = "-- direx:no-transaction";
const BREAKPOINT = "--> statement-breakpoint";
// One fixed key, so two runners on one database take turns (DX-R-0029-006).
const LOCK = "pg_advisory_lock(7302900290)";
const UNLOCK = "pg_advisory_unlock(7302900290)";

type Migration = { tag: string; when: number; hash: string; marked: boolean; chunks: string[]; sql: string };
/**
 * pending: in the journal, not in the record. unknown: record times no journal entry has, so the
 * database is newer than or diverged from this code. drifted: applied, but the file has changed
 * since, which only happened to files edited before receipts made them immutable.
 */
export type MigrationState = { pending: string[]; unknown: string[]; drifted: string[] };

function read(folder: string): Migration[] {
  const journal = JSON.parse(readFileSync(join(folder, "meta/_journal.json"), "utf8")) as { entries: { tag: string; when: number }[] };
  return journal.entries.map(({ tag, when }) => {
    const sql = readFileSync(join(folder, `${tag}.sql`), "utf8");
    return {
      tag,
      when,
      sql,
      // drizzle hashes the file's text the same way, so its rows and ours match.
      hash: createHash("sha256").update(sql).digest("hex"),
      marked: sql.split("\n", 1)[0]!.trimEnd() === NO_TRANSACTION,
      chunks: sql.split(BREAKPOINT).filter((c) => c.trim()),
    };
  });
}

/**
 * The record as journal time to hash, or empty when it does not exist yet or this role cannot
 * read it. A file is applied when its journal time is recorded, as drizzle-kit decides too.
 */
async function applied(client: pg.Client | pg.Pool): Promise<Map<string, string>> {
  try {
    const { rows } = await client.query<{ hash: string; created_at: string }>("select hash, created_at from drizzle.__drizzle_migrations");
    return new Map(rows.map((r) => [String(r.created_at), r.hash]));
  } catch (e) {
    // 3F000 no schema, 42P01 no table, 42501 no grant yet: nothing counts as applied.
    if (["3F000", "42P01", "42501"].includes((e as { code?: string }).code ?? "")) return new Map();
    throw e;
  }
}

function state(files: Migration[], done: Map<string, string>): MigrationState {
  const known = new Set(files.map((f) => String(f.when)));
  return {
    pending: files.filter((f) => !done.has(String(f.when))).map((f) => f.tag),
    unknown: [...done.keys()].filter((w) => !known.has(w)),
    drifted: files.filter((f) => done.has(String(f.when)) && done.get(String(f.when)) !== f.hash).map((f) => f.tag),
  };
}

/** What is not yet applied, and what the database has that this folder does not. */
export async function migrationState(client: pg.Client | pg.Pool, folder: string): Promise<MigrationState> {
  return state(read(folder), await applied(client));
}

const record = (client: pg.Client, m: Migration) =>
  client.query("insert into drizzle.__drizzle_migrations (hash, created_at) values ($1, $2)", [m.hash, m.when]);

async function inTransaction(client: pg.Client, m: Migration): Promise<void> {
  await client.query("BEGIN");
  try {
    // A SET LOCAL in the file itself comes later, so it wins.
    await client.query("SET LOCAL lock_timeout = '5s'");
    await client.query("SET LOCAL statement_timeout = '5min'");
    for (const chunk of m.chunks) await client.query(chunk);
    await record(client, m);
    await client.query("COMMIT");
  } catch (e) {
    await client.query("ROLLBACK");
    throw e;
  }
}

async function outsideTransaction(client: pg.Client, m: Migration): Promise<void> {
  await client.query("SET lock_timeout = '5s'");
  try {
    for (const chunk of m.chunks) await client.query(chunk);
  } finally {
    await client.query("RESET lock_timeout");
  }
  // A failed concurrent build leaves an invalid index that IF NOT EXISTS would skip forever.
  const names = [...m.sql.matchAll(/CREATE\s+(?:UNIQUE\s+)?INDEX\s+(?:CONCURRENTLY\s+)?(?:IF\s+NOT\s+EXISTS\s+)?"?(\w+)"?/gi)].map((x) => x[1]!);
  const { rows } = await client.query<{ name: string }>(
    "select c.relname as name from pg_index i join pg_class c on c.oid = i.indexrelid where not i.indisvalid and c.relname = any($1)",
    [names],
  );
  if (rows.length) throw new Error(`index ${rows.map((r) => r.name).join(", ")} is invalid; drop it with DROP INDEX CONCURRENTLY and run again`);
  await record(client, m);
}

/** Applies every pending migration in folder, in journal order, on one owner connection. Returns the drifted files. */
export async function migrate(client: pg.Client, folder: string, log: (tag: string) => void = () => {}): Promise<string[]> {
  const files = read(folder);
  await client.query(`select ${LOCK}`);
  try {
    await client.query('CREATE SCHEMA IF NOT EXISTS "drizzle"');
    await client.query('CREATE TABLE IF NOT EXISTS "drizzle"."__drizzle_migrations" (id SERIAL PRIMARY KEY, hash text NOT NULL, created_at bigint)');
    // Read only after taking the lock, so a runner that waited sees what the other applied.
    const done = await applied(client);
    const { unknown, drifted } = state(files, done);
    if (unknown.length) {
      throw new Error(`the database has ${unknown.length} applied migration(s) this checkout does not; it is newer than or diverged from this code`);
    }
    for (const m of files.filter((f) => !done.has(String(f.when)))) {
      try {
        await (m.marked ? outsideTransaction(client, m) : inTransaction(client, m));
      } catch (e) {
        throw new Error(`migration ${m.tag} failed: ${(e as Error).message}`, { cause: e });
      }
      log(m.tag);
    }
    return drifted;
  } finally {
    await client.query(`select ${UNLOCK}`).catch(() => {});
  }
}

/** migrate over a new connection to url, for callers outside packages/db. */
export async function migrateDatabase(url: string, folder: string, log?: (tag: string) => void): Promise<string[]> {
  const client = new pg.Client(url);
  await client.connect();
  try {
    return await migrate(client, folder, log);
  } finally {
    await client.end();
  }
}

/** migrationState over a new connection to url. */
export async function databaseMigrationState(url: string, folder: string): Promise<MigrationState> {
  const client = new pg.Client(url);
  await client.connect();
  try {
    return await migrationState(client, folder);
  } finally {
    await client.end();
  }
}
