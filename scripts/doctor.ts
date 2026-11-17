// SPDX-License-Identifier: AGPL-3.0-only
// Reports what stands between this checkout and a working `bun run dev`. It changes nothing and
// prints no secret. Each line is `ok <check>` or `FAIL <check>: <next step>`; any FAIL exits 1.
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { anyFreePort, failLine, portFree, PREREQUISITES, root } from "./first-run";

const SETUP = "run: bun run setup";
// Only a deployment that says NODE_ENV=production. A checkout leaves it unset (`bun run dev` sets
// development itself), and its doctor must not fail on mail and Server admins it doesn't use.
export const isProduction = (env: Record<string, string | undefined>) => env.NODE_ENV === "production";

export type Check = {
  name: string;
  run: () => boolean | Promise<boolean>;
  fix: () => string | Promise<string>;
  /** The checks after this one can't run without it, so a failure ends the report. */
  gate?: boolean;
};

export async function runChecks(checks: Check[], print: (line: string) => void = console.log): Promise<number> {
  let code = 0;
  for (const c of checks) {
    if (await c.run()) {
      print(`ok ${c.name}`);
      continue;
    }
    code = 1;
    print(failLine(c.name, await c.fix()));
    if (c.gate) break;
  }
  return code;
}

const answers = async (url: string, expected: string) => {
  try {
    return (await (await fetch(url, { signal: AbortSignal.timeout(2000) })).text()).includes(expected);
  } catch {
    return false;
  }
};

async function canConnect(url: string): Promise<boolean> {
  const { default: pg } = await import("pg");
  const client = new pg.Client({ connectionString: url, connectionTimeoutMillis: 3000 });
  try {
    await client.connect();
    return true;
  } catch {
    return false;
  } finally {
    await client.end().catch(() => {});
  }
}

async function migrationsApplied(url: string): Promise<boolean> {
  const { databaseMigrationState } = await import("@direx/db/migrate");
  try {
    const { pending, unknown } = await databaseMigrationState(url, join(root, "packages/db/migrations"));
    return pending.length === 0 && unknown.length === 0;
  } catch {
    return false;
  }
}

async function hasServerAdmin(url: string): Promise<boolean> {
  const { default: pg } = await import("pg");
  const client = new pg.Client({ connectionString: url, connectionTimeoutMillis: 3000 });
  try {
    await client.connect();
    return (await client.query<{ e: boolean }>("SELECT EXISTS (SELECT 1 FROM system.server_admins) AS e")).rows[0]!.e;
  } catch {
    return false;
  } finally {
    await client.end().catch(() => {});
  }
}

/**
 * Installed third-party plugins run only in the sandbox (ADR 0026 rule 009). With none installed
 * there is nothing to confine; with some, the sandbox must hold, or they don't start.
 */
export async function pluginSandboxProblem(url: string): Promise<string | null> {
  const { default: pg } = await import("pg");
  const client = new pg.Client({ connectionString: url, connectionTimeoutMillis: 3000 });
  let installed = 0;
  try {
    await client.connect();
    installed = Number((await client.query<{ n: string }>("SELECT count(*) AS n FROM system.plugin_installs")).rows[0]!.n);
  } catch {
    return null;
  } finally {
    await client.end().catch(() => {});
  }
  if (!installed) return null;
  const { sandboxStatus } = await import("../apps/api/src/modules/models/index");
  const status = await sandboxStatus();
  return status.ok ? null : `${installed} installed plugin${installed === 1 ? "" : "s"} won't start: ${status.reason}`;
}

async function mailLogsIn(url: string | null): Promise<boolean> {
  if (!url) return false;
  const { smtpMailer } = await import("../apps/api/src/modules/identity/index");
  return (await smtpMailer(url, "doctor@localhost").verify?.()) === true;
}

/**
 * In production a server needs working mail (every sign-up confirms an email) and a Server admin
 * (ADR 0024, DX-R-0024-012). In dev, mail goes to the log and anyone may sign up, so both are skipped.
 */
function productionChecks(owner: string, smtpUrl: () => Promise<string | null>): Check[] {
  return [
    {
      name: "mail server accepts the login",
      run: async () => mailLogsIn(await smtpUrl()),
      fix: () => "the SMTP server didn't connect and accept the login within 10 seconds. Check the URL, then run: bun apps/api/src/secrets.ts set smtp.url",
    },
    {
      name: "this server has a Server admin",
      run: () => hasServerAdmin(owner),
      fix: () => "run: bun run server-admin --invite, then open the link it prints and sign in",
    },
  ];
}

export function checks(env: Record<string, string | undefined> = process.env, opts: { smtpUrl?: () => Promise<string | null> } = {}): Check[] {
  const owner = env.DIREX_DB_OWNER_URL ?? "";
  const app = env.DIREX_DB_APP_URL ?? "";
  const apiPort = Number(env.PORT ?? 3000);
  const webPort = Number(env.DIREX_WEB_PORT ?? 5173);
  let keyProblem: string | null = null;
  let sandboxProblem: string | null = null;
  // A production server is given its database and its environment, in a container or under a
  // service manager. The checks on this checkout's own Docker, .env file and Postgres port are for
  // a development install, and inside the server image there is no Docker to ask.
  const production = isProduction(env);
  const DEV_ONLY = ["Docker daemon", "Postgres port"];

  const all: Check[] = [
    ...PREREQUISITES.map((p) => ({ name: p.name, run: p.ok, fix: p.fix, gate: p.name === "Docker daemon" })),
    { name: "dependencies installed", run: () => existsSync(join(root, "node_modules/pg")), fix: () => SETUP, gate: true },
    { name: ".env has both database URLs", run: () => (production || existsSync(join(root, ".env"))) && Boolean(owner && app), fix: () => SETUP, gate: true },
    {
      name: "Postgres port",
      run: async () => {
        const up = spawnSync("docker", ["compose", "ps", "--status", "running", "-q", "postgres"], { cwd: root, encoding: "utf8" });
        return Boolean(up.stdout?.trim()) || portFree(Number(new URL(owner).port));
      },
      fix: async () => `port ${new URL(owner).port} is taken. Run: DIREX_PG_PORT=${await anyFreePort()} bun run setup`,
      gate: true,
    },
    { name: "database owner can connect", run: () => canConnect(owner), fix: () => SETUP, gate: true },
    { name: "all migrations applied", run: () => migrationsApplied(owner), fix: () => SETUP },
    { name: "direx_app can log in", run: () => canConnect(app), fix: () => SETUP, gate: true },
    { name: "API document generated", run: () => existsSync(join(root, "apps/api/openapi.json")), fix: () => SETUP },
    {
      name: "root key",
      run: async () => {
        const { rootKeyProblem } = await import("../apps/api/src/modules/credentials/index");
        keyProblem = await rootKeyProblem(env);
        return keyProblem === null;
      },
      fix: () => keyProblem ?? "restore the root key",
    },
    {
      name: "installed plugins can run in the sandbox",
      run: async () => (sandboxProblem = await pluginSandboxProblem(owner)) === null,
      fix: () => sandboxProblem ?? "run Direx with deploy/docker/compose.yml",
    },
    ...(isProduction(env)
      ? productionChecks(owner, opts.smtpUrl ?? (async () => (await import("../apps/api/src/startup")).storedSmtpUrl(env).catch(() => null)))
      : []),
    {
      name: `port ${apiPort} free or running Direx`,
      run: async () => (await answers(`http://127.0.0.1:${apiPort}/health`, '"ok":true')) || portFree(apiPort),
      fix: () => `stop whatever is using port ${apiPort}`,
    },
    {
      name: `port ${webPort} free or running Direx`,
      run: async () => (await answers(`http://localhost:${webPort}/`, "<title>Direx</title>")) || portFree(webPort),
      fix: () => `stop whatever is using port ${webPort}`,
    },
  ];
  return production ? all.filter((c) => !DEV_ONLY.includes(c.name)) : all;
}

if (import.meta.main) process.exit(await runChecks(checks()));
