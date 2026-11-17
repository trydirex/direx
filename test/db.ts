// SPDX-License-Identifier: AGPL-3.0-only
import pg from "pg";
import { migrate } from "@direx/db/migrate";
import { fileURLToPath } from "node:url";

// Test-only helpers. Application code never gets a raw client.

export function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not set (copy .env.example to .env)`);
  return value;
}

export function withDatabase(url: string, database: string): string {
  const u = new URL(url);
  u.pathname = `/${database}`;
  return u.toString();
}

/** Runs fn with a client connected as the owner to the maintenance database. */
export async function asOwner<T>(fn: (c: pg.Client) => Promise<T>): Promise<T> {
  const client = new pg.Client(withDatabase(requireEnv("DIREX_DB_OWNER_URL"), "postgres"));
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.end();
  }
}

/** A raw connection as direx_app to this test file's database (or url), outside withWorkspace. */
export async function appClient(url = requireEnv("DIREX_DB_APP_URL")): Promise<pg.Client> {
  const client = new pg.Client(url);
  await client.connect();
  return client;
}

/** A sign-in user. */
export async function insertAuthUser(id: string): Promise<void> {
  const client = await appClient();
  await client.query(`insert into auth."user" (id, name, email) values ($1, 'x', $2) on conflict do nothing`, [id, `${id}@example.com`]);
  await client.end();
}

/** PgBouncer is optional locally; CI sets DIREX_DB_POOL_URL so the pool path is always covered there. */
export const hasPool = Boolean(process.env.DIREX_DB_POOL_URL);

/** This test file's database as direx_app, through PgBouncer in transaction mode. */
export function poolUrl(): string {
  const database = new URL(requireEnv("DIREX_DB_APP_URL")).pathname.slice(1);
  return withDatabase(requireEnv("DIREX_DB_POOL_URL"), database);
}

/** Throws unless url's host and port answer as PgBouncer, so a pool test can't quietly hit Postgres. */
export async function expectPgBouncer(url: string): Promise<void> {
  const client = new pg.Client(withDatabase(url, "pgbouncer"));
  await client.connect();
  try {
    const { rows } = await client.query("SHOW VERSION");
    if (!String(rows[0]?.version).startsWith("PgBouncer")) throw new Error(`${url} is not PgBouncer`);
  } finally {
    await client.end();
  }
}

/** A raw connection as the owner to this test file's database, for applying fixtures. */
export async function ownerClient(): Promise<pg.Client> {
  const database = new URL(requireEnv("DIREX_DB_APP_URL")).pathname.slice(1);
  const client = new pg.Client(withDatabase(requireEnv("DIREX_DB_OWNER_URL"), database));
  await client.connect();
  return client;
}

/** A new database with every migration applied, as the owner. Drop it with dropDatabase. */
export async function createMigratedDatabase(name: string): Promise<void> {
  await asOwner((c) => c.query(`CREATE DATABASE ${name}`));
  const owner = new pg.Client(withDatabase(requireEnv("DIREX_DB_OWNER_URL"), name));
  await owner.connect();
  try {
    await migrate(owner, fileURLToPath(new URL("../packages/db/migrations", import.meta.url)));
  } finally {
    await owner.end();
  }
}

export async function dropDatabase(name: string): Promise<void> {
  await asOwner((c) => c.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`));
}
