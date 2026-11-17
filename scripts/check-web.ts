// SPDX-License-Identifier: AGPL-3.0-only
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createMigratedDatabase, dropDatabase, requireEnv as env, withDatabase } from "../test/db";

// Runs Lighthouse against the built web app, signed out (the sign-in page) and signed in (Home), and
// fails over the page budgets, the bundle budget, or on a critical or serious WCAG 2.0 to 2.2 A/AA
// violation. Lighthouse runs axe-core for its accessibility audits.
//
// The API serves the build from one origin, on a throwaway database migrated here and dropped after,
// so the developer's own data is never touched. The signed-in person is a fixture made up for this run
// with a random password that exists only in this process; it is never a real person's session.
// Exit 0 pass, 1 over budget, 2 could not run. Needs bun run build first.

const root = join(import.meta.dir, "..");
const dist = join(root, "apps/web/dist");
const PORT = 4174;
const BASE = `http://localhost:${PORT}`;
const MAX_LCP_MS = 2500;
const MAX_CLS = 0.1;
// Gzipped bytes the first page loads, set from the build of 2026-11-09 with room to grow; raise only on purpose.
const MAX_JS_GZIP = 240_000;
const MAX_CSS_GZIP = 16_000;
const WCAG = new Set(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22a", "wcag22aa"]);
const BLOCKING = new Set(["critical", "serious"]);

type Audit = {
  score: number | null;
  scoreDisplayMode: string;
  numericValue?: number;
  details?: { debugData?: { impact?: string; tags?: string[] }; items?: { items?: { node?: { snippet?: string } }[] }[] };
};
type Report = {
  finalDisplayedUrl: string;
  audits: Record<string, Audit>;
  categories: { accessibility: { auditRefs: { id: string }[] } };
};


/** Gzipped size of the JS and CSS that index.html loads. */
function bundleSizes() {
  const html = readFileSync(join(dist, "index.html"), "utf8");
  const files = [...html.matchAll(/(?:src|href)="\/(assets\/[^"]+\.(?:js|css))"/g)].map((m) => m[1]!);
  const gz = (ext: string) => files.filter((f) => f.endsWith(ext)).reduce((n, f) => n + Bun.gzipSync(readFileSync(join(dist, f))).length, 0);
  return { js: gz(".js"), css: gz(".css") };
}

function lighthouse(url: string, dir: string, name: string, cookie?: string): Report {
  const path = join(dir, `${name}.json`);
  const run = Bun.spawnSync(
    [
      "bunx",
      "lighthouse",
      url,
      "--quiet",
      "--output=json",
      `--output-path=${path}`,
      "--only-categories=performance,accessibility",
      "--chrome-flags=--headless=new --no-sandbox",
      ...(cookie ? [`--extra-headers=${JSON.stringify({ cookie })}`] : []),
    ],
    { stdout: "ignore", stderr: "pipe" },
  );
  if (run.exitCode !== 0) throw new Error(`lighthouse exited ${run.exitCode} on ${name}: ${run.stderr.toString().slice(-300)}`);
  return JSON.parse(readFileSync(path, "utf8")) as Report;
}

/** `speed` false: LCP and CLS are printed but don't fail the run (signed-in pages, until enforced). */
function judge(report: Report, name: string, speed = true): string[] {
  const lcp = report.audits["largest-contentful-paint"]?.numericValue;
  const cls = report.audits["cumulative-layout-shift"]?.numericValue;
  if (lcp === undefined || cls === undefined) throw new Error(`${name}: report has no LCP or CLS`);
  const failures: string[] = [];
  if (speed && lcp > MAX_LCP_MS) failures.push(`${name}: LCP ${Math.round(lcp)}ms over ${MAX_LCP_MS}ms`);
  if (speed && cls > MAX_CLS) failures.push(`${name}: CLS ${cls} over ${MAX_CLS}`);
  for (const { id } of report.categories.accessibility.auditRefs) {
    const a = report.audits[id];
    const debug = a?.details?.debugData;
    if (!a || a.scoreDisplayMode !== "binary" || a.score !== 0 || !debug?.impact) continue;
    if (BLOCKING.has(debug.impact) && debug.tags?.some((t) => WCAG.has(t))) failures.push(`${name}: a11y ${id} (${debug.impact})`);
  }
  console.log(`web: ${name} LCP ${Math.round(lcp)}ms, CLS ${cls}${speed ? "" : " (measured, not enforced)"}`);
  return failures;
}

const database = `direx_web_${randomBytes(8).toString("hex")}`;
const dir = mkdtempSync(join(tmpdir(), "direx-web-"));
let api: ReturnType<typeof Bun.spawn> | undefined;
let code = 2;
try {
  if (!readdirSync(dist).includes("index.html")) throw new Error("no build in apps/web/dist; did bun run build run?");
  const failures: string[] = [];
  const size = bundleSizes();
  console.log(`web: first load ${Math.round(size.js / 1000)} kB JS, ${Math.round(size.css / 1000)} kB CSS (gzip)`);
  if (size.js > MAX_JS_GZIP) failures.push(`bundle: JS ${size.js} bytes gzip over ${MAX_JS_GZIP}`);
  if (size.css > MAX_CSS_GZIP) failures.push(`bundle: CSS ${size.css} bytes gzip over ${MAX_CSS_GZIP}`);

  await createMigratedDatabase(database);

  // Dev mode: unverified sign-ups, a public auth secret, and listening on 127.0.0.1 only. No pool, so
  // every connection reaches the throwaway database.
  const apiEnv: Record<string, string | undefined> = {
    ...process.env,
    NODE_ENV: "development",
    PORT: String(PORT),
    DIREX_BASE_URL: BASE,
    DIREX_WEB_DIST: dist,
    DIREX_DATA_DIR: join(dir, "data"),
    DIREX_DB_APP_URL: withDatabase(env("DIREX_DB_APP_URL"), database),
    DIREX_DB_OWNER_URL: withDatabase(env("DIREX_DB_OWNER_URL"), database),
    ICU_TIMEZONE_FILES_DIR: join(root, "deploy/icu-tz"),
  };
  delete apiEnv.DIREX_DB_POOL_URL;
  api = Bun.spawn(["bun", join(root, "apps/api/src/main.ts")], { cwd: root, env: apiEnv, stdout: "ignore", stderr: "pipe" });
  let up = false;
  for (let n = 0; n < 120 && !up && api.exitCode === null; n++) {
    up = await fetch(`${BASE}/health`).then((r) => r.ok, () => false);
    if (!up) await Bun.sleep(500);
  }
  if (!up) throw new Error(`the API did not start: ${(await new Response(api.stderr as ReadableStream).text()).slice(-500)}`);

  const post = (path: string, body: unknown, cookie?: string) =>
    fetch(`${BASE}${path}`, { method: "POST", headers: { "content-type": "application/json", origin: BASE, ...(cookie && { cookie }) }, body: JSON.stringify(body) });
  const signUp = await post("/api/auth/sign-up/email", { email: `web-check-${randomBytes(4).toString("hex")}@example.com`, password: randomBytes(18).toString("base64"), name: "" });
  const cookie = signUp.headers.getSetCookie().map((c) => c.split(";")[0]).join("; ");
  if (!signUp.ok || !cookie) throw new Error(`fixture sign-up failed: ${signUp.status}`);
  const org = await post("/api/orgs", { name: "Web check", workspaceName: "Web check" }, cookie);
  if (!org.ok) throw new Error(`fixture organization failed: ${org.status}`);
  const workspaces = (await (await fetch(`${BASE}/api/me/workspaces`, { headers: { cookie } })).json()) as { workspaces: { id: string }[] };
  const home = `${BASE}/w/${workspaces.workspaces[0]!.id}`;

  // Lighthouse's simulated timing moves with the machine's load, and sign-in sits close to its limit,
  // so it runs three times and the median run is judged. The limit itself does not move.
  const runs = [1, 2, 3].map((n) => lighthouse(`${BASE}/`, dir, `sign-in-${n}`));
  const lcpOf = (r: Report) => r.audits["largest-contentful-paint"]?.numericValue ?? Infinity;
  console.log(`web: sign-in LCP runs ${runs.map((r) => Math.round(lcpOf(r))).join(", ")} ms; judging the median`);
  failures.push(...judge([...runs].sort((x, y) => lcpOf(x) - lcpOf(y))[1]!, "sign-in"));
  const signedIn = lighthouse(home, dir, "home", cookie);
  // Home's speed is measured, not yet enforced (CONSTRAINTS.md); its accessibility is enforced.
  failures.push(...judge(signedIn, "home", false));
  // Home must have drawn itself, not a sign-in page or a skeleton still loading.
  if (new URL(signedIn.finalDisplayedUrl).pathname !== new URL(home).pathname) failures.push(`home: ended on ${signedIn.finalDisplayedUrl}`);
  const lcpNode = signedIn.audits["largest-contentful-paint-element"]?.details?.items?.[0]?.items?.[0]?.node?.snippet ?? "";
  if (/animate-pulse|Loading|Sign in/.test(lcpNode)) failures.push(`home: largest paint is not content: ${lcpNode.slice(0, 120)}`);

  for (const f of failures) console.error(`  ${f}`);
  console.log(`web: ${failures.length} failure(s)`);
  code = failures.length ? 1 : 0;
} catch (e) {
  console.error(`web: ${(e as Error).message}`);
} finally {
  api?.kill();
  await api?.exited;
  await dropDatabase(database).catch((e: Error) => console.error(`web: could not drop ${database}: ${e.message}`));
  // DIREX_WEB_REPORTS=<folder> keeps the Lighthouse reports there, to see why a page failed.
  if (process.env.DIREX_WEB_REPORTS) for (const f of readdirSync(dir).filter((n) => n.endsWith(".json"))) await Bun.write(join(process.env.DIREX_WEB_REPORTS, f), Bun.file(join(dir, f)));
  rmSync(dir, { recursive: true, force: true });
}
process.exit(code);
