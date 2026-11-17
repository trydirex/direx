// SPDX-License-Identifier: AGPL-3.0-only
// What setup and doctor share. Setup runs before the install, so this imports no npm package.
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { createServer } from "node:net";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

export const root = fileURLToPath(new URL("..", import.meta.url));

export const failLine = (name: string, fix: string) => `FAIL ${name}: ${fix}`;

/**
 * Vite's stated range. Node 21 is below it even though 20.19 is not. With no Node installed, `bun run`
 * puts its own stand-in on the path, which prints no version, and that works.
 */
export function nodeOk(version: string): boolean {
  if (!version) return true;
  const [major = 0, minor = 0] = version.replace(/^v/, "").split(".").map(Number);
  return (major === 20 && minor >= 19) || (major === 22 && minor >= 12) || major > 22;
}

const run = (cmd: string, ...args: string[]) => spawnSync(cmd, args, { encoding: "utf8" });

export const wantedBun = () => readFileSync(join(root, ".bun-version"), "utf8").trim();

/** Checked before anything else, by both setup and doctor. */
export const PREREQUISITES: { name: string; fix: () => string; ok: () => boolean }[] = [
  {
    name: "Bun version",
    fix: () => `install Bun ${wantedBun()}: curl -fsSL https://bun.sh/install | bash -s "bun-v${wantedBun()}"`,
    ok: () => Bun.version === wantedBun(),
  },
  {
    name: "Node version",
    fix: () => "upgrade Node to 20.19, 22.12 or later, or take it off the path. Direx runs without Node",
    ok: () => {
      const node = run("node", "--version");
      return node.error !== undefined || nodeOk(node.stdout.trim());
    },
  },
  {
    name: "Docker daemon",
    fix: () => "install Docker with Compose and start it: https://docs.docker.com/get-docker/",
    ok: () => run("docker", "info").status === 0 && run("docker", "compose", "version").status === 0,
  },
];

/** Writes one Postgres port to the three values that must agree, and touches nothing else. */
export function withPostgresPort(env: string, port: string): string {
  const urls = env.replace(/^(DIREX_DB_(?:OWNER|APP)_URL=.*@[^:/\s]+:)\d+/gm, `$1${port}`);
  if (/^DIREX_PG_PORT=/m.test(urls)) return urls.replace(/^DIREX_PG_PORT=.*$/m, `DIREX_PG_PORT=${port}`);
  return `${urls.trimEnd()}\nDIREX_PG_PORT=${port}\n`;
}

/** `KEY=VALUE` lines, so a child process sees the file as it is now, not as Bun loaded it at start. */
export function parseEnv(text: string): Record<string, string> {
  return Object.fromEntries([...text.matchAll(/^([A-Z0-9_]+)=(.*)$/gm)].map((m) => [m[1]!, m[2]!]));
}

/** Both addresses, because `localhost` can reach either and Vite may listen on only one. */
export async function portFree(port: number): Promise<boolean> {
  for (const host of ["127.0.0.1", "::1"]) {
    const free = await new Promise<boolean>((resolve) => {
      const server = createServer();
      server.once("error", (e: NodeJS.ErrnoException) => resolve(e.code === "EADDRNOTAVAIL"));
      server.listen(port, host, () => server.close(() => resolve(true)));
    });
    if (!free) return false;
  }
  return true;
}

export const anyFreePort = () =>
  new Promise<number>((resolve) => {
    const server = createServer();
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as { port: number };
      server.close(() => resolve(port));
    });
  });

export const isLocalHost = (url: string) => ["localhost", "127.0.0.1"].includes(new URL(url).hostname);
