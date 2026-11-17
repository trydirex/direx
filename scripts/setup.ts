// SPDX-License-Identifier: AGPL-3.0-only
// Takes a fresh clone to a state where `bun run dev` works. Safe to re-run. It owns the Compose
// Postgres only, and imports no npm package because it runs before the install.
import { spawnSync, type SpawnSyncOptions } from "node:child_process";
import { copyFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { failLine, isLocalHost, parseEnv, PREREQUISITES, root, withPostgresPort } from "./first-run";

const ENV = join(root, ".env");

function stop(name: string, fix: string): never {
  console.error(failLine(name, fix));
  process.exit(1);
}

const env = () => ({ ...process.env, ...parseEnv(readFileSync(ENV, "utf8")) });

function step(name: string, fix: string, cmd: string, args: string[], options: SpawnSyncOptions = {}) {
  console.log(`setup: ${name}`);
  const result = spawnSync(cmd, args, { cwd: root, stdio: "inherit", env: existsSync(ENV) ? env() : process.env, ...options });
  if (result.status !== 0) stop(name, fix);
  return result;
}

for (const p of PREREQUISITES) if (!p.ok()) stop(p.name, p.fix());

step("install dependencies", "check the error above, then run: bun run setup", "bun", ["install", "--frozen-lockfile"]);

if (!existsSync(ENV)) copyFileSync(join(root, ".env.example"), ENV);
// Set in the shell, this wins over an existing file: a first run that hit a port clash left one behind.
const shellPort = process.env.DIREX_PG_PORT;
if (shellPort) writeFileSync(ENV, withPostgresPort(readFileSync(ENV, "utf8"), shellPort));

const { DIREX_DB_OWNER_URL: ownerUrl, DIREX_DB_APP_URL: appUrl } = parseEnv(readFileSync(ENV, "utf8"));
if (!ownerUrl || !appUrl) stop(".env database URLs", "add DIREX_DB_OWNER_URL and DIREX_DB_APP_URL, as in .env.example");
if (!isLocalHost(ownerUrl) || !isLocalHost(appUrl)) {
  stop(".env database host", "setup only changes the local Compose Postgres. Point the URLs at localhost, or set that database up yourself");
}

const up = spawnSync("docker", ["compose", "up", "-d", "postgres"], { cwd: root, env: env(), encoding: "utf8" });
if (up.status !== 0) {
  process.stderr.write(up.stderr);
  const clash = /already allocated|already in use/.test(up.stderr);
  stop("start Postgres", clash ? `port ${new URL(ownerUrl).port} is taken. Run: DIREX_PG_PORT=<free port> bun run setup` : "check the error above, then run: bun run setup");
}

// Over TCP, because the image's first-start server answers on its socket and then restarts.
const compose = ["compose", "exec", "-T", "postgres"];
const started = Date.now();
while (spawnSync("docker", [...compose, "pg_isready", "-q", "-h", "127.0.0.1", "-U", "direx_owner"], { cwd: root, env: env() }).status !== 0) {
  if (Date.now() - started > 60_000) stop("wait for Postgres", "check it with: docker compose logs postgres");
  Bun.sleepSync(500);
}

step("apply migrations", "check the error above, then run: bun run setup", "bun", ["run", "db:migrate"]);

console.log("setup: set the app role's password");
const password = decodeURIComponent(new URL(appUrl).password).replaceAll("'", "''");
// On stdin and not an argument, so the password never shows in a process list.
const role = spawnSync("docker", [...compose, "psql", "-q", "-v", "ON_ERROR_STOP=1", "-U", "direx_owner", "-d", "direx", "-f", "-"], {
  cwd: root,
  env: env(),
  input: `ALTER ROLE direx_app PASSWORD '${password}';`,
  stdio: ["pipe", "ignore", "ignore"],
});
if (role.status !== 0) stop("set the app role's password", "check that migrations ran, then run: bun run setup");

step("generate the API document", "check the error above, then run: bun run setup", "bun", ["scripts/gen-openapi.ts"], { cwd: join(root, "apps/api") });

// ADR 0024: a production server nobody has claimed gets its one-time bootstrap link, printed for
// the person running setup (an agent never reads or passes it on, DX-R-0024-006). Re-running
// setup before it is used prints a new one and the old one stops working.
if (env().NODE_ENV === "production") {
  const claimed = spawnSync("docker", [...compose, "psql", "-tA", "-U", "direx_owner", "-d", "direx", "-c", "SELECT EXISTS (SELECT 1 FROM system.server_admins)"], {
    cwd: root,
    env: env(),
    encoding: "utf8",
  });
  if (claimed.status !== 0) stop("check for a Server admin", "check that migrations ran, then run: bun run setup");
  if (claimed.stdout.trim() !== "t") step("make the first Server admin's link", "check the error above, then run: bun run server-admin --invite", "bun", ["scripts/server-admin.ts", "--invite"]);
}

process.exit(spawnSync("bun", ["scripts/doctor.ts"], { cwd: root, stdio: "inherit", env: env() }).status ?? 1);
