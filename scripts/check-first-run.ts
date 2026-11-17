// SPDX-License-Identifier: AGPL-3.0-only
// Proves the path from nothing to a signed-in person. It works in a temporary copy with its own
// Compose project and key directory, so the real .env, database and key are never touched. It
// prints no password, link or token. Taken ports are replaced by free ones, so it can run beside
// a dev app; CI has them free, and so proves the defaults.
import { spawn, spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { randomBytes } from "node:crypto";
import { anyFreePort, portFree, root } from "./first-run";

const work = mkdtempSync(join(tmpdir(), "direx-first-run-"));
const copy = join(work, "repo");
const project = `direxfirstrun${randomBytes(4).toString("hex")}`;
const logPath = join(work, "dev.log");
let dev: ReturnType<typeof spawn> | undefined;

const portFor = async (wanted: number) => ((await portFree(wanted)) ? wanted : anyFreePort());

const pgPort = await portFor(5435);
const apiPort = await portFor(3000);
const webPort = await portFor(5173);
const base = `http://localhost:${webPort}`;

// This process loaded the real .env, and none of it may reach the copy.
const inherited = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith("DIREX_") && k !== "NODE_ENV" && k !== "PORT"));
const env = {
  ...inherited,
  COMPOSE_PROJECT_NAME: project,
  DIREX_DATA_DIR: join(work, "data"),
  ...(pgPort !== 5435 && { DIREX_PG_PORT: String(pgPort) }),
  ...(apiPort !== 3000 && { PORT: String(apiPort) }),
  ...(webPort !== 5173 && { DIREX_WEB_PORT: String(webPort), DIREX_BASE_URL: base }),
};

function must(condition: unknown, what: string): asserts condition {
  if (!condition) throw new Error(what);
}
const pass = (what: string) => console.log(`ok ${what}`);
const sh = (cmd: string, ...args: string[]) => spawnSync(cmd, args, { cwd: copy, env, encoding: "utf8" });

function setup(label: string) {
  const r = spawnSync("bun", ["run", "setup"], { cwd: copy, env, encoding: "utf8" });
  must(r.status === 0, `${label} failed:\n${r.stdout}\n${r.stderr}`);
  pass(label);
}

const post = (path: string, body: unknown, cookie?: string) =>
  fetch(`${base}${path}`, {
    method: "POST",
    redirect: "manual",
    headers: { "content-type": "application/json", origin: base, ...(cookie && { cookie }) },
    body: JSON.stringify(body),
  });
const sessionCookie = (res: Response) => res.headers.getSetCookie().map((c) => c.split(";")[0]).join("; ");
const signedIn = async (cookie: string) => (await fetch(`${base}/api/me`, { headers: { cookie } })).status === 200;

/** The log's end with every URL masked, because a URL in it can be a working sign-in link. */
const safeLog = () => readFileSync(logPath, "utf8").replace(/https?:\/\/\S+/g, "<url>").slice(-2000);

async function waitFor(url: string, what: string) {
  const started = Date.now();
  while (Date.now() - started < 120_000) {
    if (await fetch(url).then((r) => r.status === 200, () => false)) return pass(what);
    if (dev?.exitCode !== null && dev?.exitCode !== undefined) break;
    await Bun.sleep(500);
  }
  throw new Error(`${what}: no answer. The app's log:\n${safeLog()}`);
}

async function main() {
  const files = spawnSync("git", ["ls-files", "-co", "--exclude-standard", "-z"], { cwd: root, encoding: "utf8" }).stdout.split("\0").filter(Boolean);
  for (const f of files) {
    if (!existsSync(join(root, f))) continue;
    mkdirSync(dirname(join(copy, f)), { recursive: true });
    cpSync(join(root, f), join(copy, f), { verbatimSymlinks: true });
  }
  sh("git", "init", "-q");
  sh("git", "add", "-A");
  const before = sh("git", "status", "--porcelain").stdout;

  setup("setup from nothing");
  setup("setup a second time");
  must(sh("bun", "run", "doctor").status === 0, "doctor reported a FAIL");
  pass("doctor is all ok");
  must(sh("git", "status", "--porcelain").stdout === before, "setup changed a tracked file");
  pass("setup dirtied nothing tracked");
  must(sh("docker", "compose", "port", "postgres", "5432").stdout.trim().startsWith("127.0.0.1:"), "Postgres is reachable from the network");
  pass("Postgres listens on 127.0.0.1 only");

  const log = openSync(logPath, "a");
  dev = spawn("bun", ["run", "dev"], { cwd: copy, env, detached: true, stdio: ["ignore", log, log] });
  await waitFor(`http://127.0.0.1:${apiPort}/health`, "/health answers");
  await waitFor(`${base}/`, "the sign-in page answers");

  const email = `first-run-${randomBytes(4).toString("hex")}@example.com`;
  const password = randomBytes(18).toString("base64");
  const created = await post("/api/auth/sign-up/email", { email, password, name: "" });
  const cookie = sessionCookie(created);
  must(created.status === 200 && (await signedIn(cookie)), "signing up with a password gave no session");
  pass("sign up with a password");
  must((await post("/api/auth/sign-out", {}, cookie)).status === 200, "sign-out failed");
  const again = await post("/api/auth/sign-in/email", { email, password });
  must(again.status === 200 && (await signedIn(sessionCookie(again))), "signing in with a password gave no session");
  pass("sign in with a password");

  must((await post("/api/auth/sign-in/magic-link", { email, callbackURL: "/" })).status === 200, "magic link request failed");
  let link: string | undefined;
  for (let i = 0; i < 20 && !link; i++) {
    await Bun.sleep(500);
    link = [...readFileSync(logPath, "utf8").matchAll(/https?:\/\/\S*magic-link\S*/g)].at(-1)?.[0];
  }
  must(link, `no magic link in the app's log:\n${safeLog()}`);
  const followed = await fetch(link, { redirect: "manual" });
  must(await signedIn(sessionCookie(followed)), "the magic link gave no session");
  pass("sign in with a magic link");
  must((await post("/api/auth/sign-in/email", { email, password })).status === 200, "the password stopped working after a magic link");
  pass("the password still works after a magic link");
}

function cleanUp() {
  if (dev?.pid) {
    try {
      process.kill(-dev.pid);
    } catch {
      // It has already exited.
    }
  }
  if (existsSync(join(copy, "docker-compose.yml"))) sh("docker", "compose", "down", "-v", "--remove-orphans");
  rmSync(work, { recursive: true, force: true });
}

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    cleanUp();
    process.exit(1);
  });
}

let code = 0;
try {
  await main();
  console.log("first run works");
} catch (e) {
  console.error(`FAIL ${(e as Error).message}`);
  code = 1;
} finally {
  cleanUp();
}
process.exit(code);
