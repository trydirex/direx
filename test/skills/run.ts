// SPDX-License-Identifier: AGPL-3.0-only
// Runs a published skill's eval cases on a real coding agent, headless, in the sandbox, and writes
// the scored result. The skill is installed into a throwaway home the way each agent reads it.
// Tokens stay in this process's environment and are never printed or written.
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, relative } from "node:path";
import { runSandboxed } from "../../apps/api/src/modules/models/adapters/runtime/sandbox";
import * as brief from "./score/brief";
import * as claim from "./score/claim";
import * as coldEmail from "./score/cold-email";
import * as readiness from "./score/readiness";
import * as research from "./score/research";

const ROOT = join(import.meta.dirname, "../..");
type Score = { problems: string[] };
/** `root` gives the case its own origin, so files such as /robots.txt sit at the root as on a real site. */
type Case = { id: string; root?: boolean };
/** HTML with status 200, or a response with its own status and type, and Markdown for `Accept: text/markdown`. */
export type Page = string | { body: string; status?: number; type?: string; markdown?: string };

/** A skill's scorer, with its own case and score types hidden behind the shapes the runner needs. */
function adapt<C extends Case, S extends Score>(s: {
  prompt: (c: C, base: string) => string;
  score: (c: C, out: string) => S;
  missesBar: (r: { id: string; score: S }[]) => string | null;
  /** A skill that reads web pages gets each case's site served over HTTPS. */
  pages?: (c: C) => Record<string, Page>;
  /** Changes a case makes to the installed files, such as dating a table back. The digest is of the unchanged skill. */
  install?: (c: C, files: Record<string, string>) => Record<string, string>;
}) {
  return {
    prompt: (c: Case, base: string) => s.prompt(c as C, base),
    score: (c: Case, out: string): Score => s.score(c as C, out),
    missesBar: (r: { id: string; score: Score }[]) => s.missesBar(r as { id: string; score: S }[]),
    pages: s.pages && ((c: Case) => s.pages!(c as C)),
    install: (c: Case, files: Record<string, string>) => (s.install ? s.install(c as C, files) : files),
  };
}
const SCORERS: Record<string, ReturnType<typeof adapt>> = {
  "cold-email-compliance": adapt({ prompt: coldEmail.prompt, score: coldEmail.scoreColdEmail, missesBar: coldEmail.missesBar, install: (c, files) => coldEmail.install(c, files) }),
  "claim-check": adapt({ prompt: claim.prompt, score: claim.scoreClaims, missesBar: claim.missesBar }),
  "company-research": adapt({ prompt: research.prompt, score: research.scoreResearch, missesBar: research.missesBar, pages: (c) => c.pages }),
  "page-brief": adapt({ prompt: brief.prompt, score: brief.scoreBrief, missesBar: brief.missesBar, pages: (c) => c.pages }),
  "agent-readiness": adapt({ prompt: readiness.prompt, score: readiness.scoreReadiness, missesBar: readiness.missesBar, pages: (c) => c.pages }),
};
export const SKILLS = Object.keys(SCORERS);
const MODELS = { claude_code: "claude-haiku-5-5", codex: "gpt-6-luna" } as const;
export type Provider = keyof typeof MODELS;
const CA_IN_HOME = "/home/direx/ca.pem";

/** The skill's files by path under the skills folder, without its eval cases, so the answers can't be read. */
function skillFiles(skill: string): Record<string, string> {
  const skills = join(ROOT, "skills");
  const out: Record<string, string> = {};
  const walk = (d: string) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, e.name);
      if (e.isDirectory()) { if (p !== join(skills, skill, "evals")) walk(p); } else out[relative(skills, p)] = readFileSync(p, "utf8");
    }
  };
  walk(join(skills, skill));
  return out;
}

function respond(page: Page | undefined, req: Request): Response {
  if (page === undefined) return new Response("Not found", { status: 404 });
  if (typeof page === "string") return new Response(page, { headers: { "content-type": "text/html; charset=utf-8" } });
  if (page.markdown !== undefined && (req.headers.get("accept") ?? "").includes("text/markdown")) {
    return new Response(page.markdown, { headers: { "content-type": "text/markdown; charset=utf-8" } });
  }
  return new Response(page.body, { status: page.status ?? 200, headers: { "content-type": page.type ?? "text/html; charset=utf-8" } });
}

/**
 * Every case's site over HTTPS, with a certificate made for this run and trusted only in the sandbox: under /<id>/ on a
 * shared origin, or at the root of its own origin when the case says `root`.
 */
function serveSites(cases: Case[], pagesOf: (c: Case) => Record<string, Page>) {
  const dir = mkdtempSync(join(tmpdir(), "skill-sites-"));
  try {
    const made = Bun.spawnSync(["openssl", "req", "-x509", "-newkey", "ec", "-pkeyopt", "ec_paramgen_curve:prime256v1", "-nodes", "-days", "1",
      "-subj", "/CN=127.0.0.1", "-addext", "subjectAltName=IP:127.0.0.1", "-keyout", join(dir, "key.pem"), "-out", join(dir, "cert.pem")], { stdout: "ignore", stderr: "pipe" });
    if (made.exitCode !== 0) throw new Error(`openssl couldn't make the fixture certificate: ${made.stderr.toString().trim()}`);
    const cert = readFileSync(join(dir, "cert.pem"), "utf8");
    const key = readFileSync(join(dir, "key.pem"), "utf8");
    const servers: { stop: (force: boolean) => unknown }[] = [];
    const serve = (pages: Map<string, Page>) => {
      const server = Bun.serve({ hostname: "127.0.0.1", port: 0, tls: { cert, key }, fetch: (req) => respond(pages.get(new URL(req.url).pathname), req) });
      servers.push(server);
      return `127.0.0.1:${server.port}`;
    };
    const shared = serve(new Map(cases.filter((c) => !c.root).flatMap((c) => Object.entries(pagesOf(c)).map(([p, page]) => [p === "/" ? `/${c.id}/` : `/${c.id}${p}`, page] as const))));
    const own = new Map(cases.filter((c) => c.root).map((c) => [c.id, serve(new Map(Object.entries(pagesOf(c))))]));
    const ca = readFileSync("/etc/ssl/certs/ca-certificates.crt", "utf8") + cert;
    return {
      baseOf: (c: Case) => `https://${own.get(c.id) ?? shared}/`,
      egress: [shared, ...own.values()],
      ca,
      stop: () => servers.forEach((s) => s.stop(true)),
    };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
type Sites = ReturnType<typeof serveSites>;

/** The answer's final text, from either CLI's JSON event stream. */
function finalText(stdout: string): string {
  let last = "";
  for (const line of stdout.split("\n")) {
    if (!line.startsWith("{")) continue;
    const e = JSON.parse(line);
    if (e.type === "result" && typeof e.result === "string") last = e.result;
    if (e.item?.type === "agent_message" && typeof e.item.text === "string") last = e.item.text;
  }
  return last;
}

/** Every long string in the Codex sign-in file, so an answer that prints one can be caught and cleaned. */
const secretsIn = (json: string): string[] => {
  const out: string[] = [];
  const walk = (v: unknown) => {
    if (typeof v === "string" && v.length >= 20) out.push(v);
    else if (v && typeof v === "object") Object.values(v).forEach(walk);
  };
  walk(JSON.parse(json));
  return out;
};

const under = (dir: string, files: Record<string, string>) => Object.fromEntries(Object.entries(files).map(([p, c]) => [`${dir}/${p}`, c]));

type RunResult = { output: string; leaked: boolean } | { error: string };

async function runOnce(provider: Provider, model: string, files: Record<string, string>, text: string, sites?: Sites): Promise<RunResult> {
  const signal = AbortSignal.timeout(300_000);
  const net = sites && {
    env: { SSL_CERT_FILE: CA_IN_HOME, CURL_CA_BUNDLE: CA_IN_HOME, NODE_EXTRA_CA_CERTS: CA_IN_HOME },
    files: { "ca.pem": sites.ca },
    egress: sites.egress,
  };
  const clean = (stdout: string, secrets: string[]): RunResult => {
    let output = finalText(stdout);
    const leaked = secrets.some((s) => output.includes(s));
    for (const s of secrets) output = output.replaceAll(s, "[credential removed by the eval runner]");
    return { output, leaked };
  };
  if (provider === "claude_code") {
    const token = process.env.DIREX_EVAL_CLAUDE_CODE_TOKEN!;
    const run = await runSandboxed({
      binary: Bun.which("claude")!,
      args: ["-p", "--setting-sources", "user", "--strict-mcp-config", "--no-session-persistence", "--allowedTools", net ? "Skill,Read,WebFetch,Bash(curl:*)" : "Skill,Read",
        "--output-format", "stream-json", "--verbose", "--model", model],
      env: { CLAUDE_CODE_OAUTH_TOKEN: token, ...net?.env },
      stdin: text,
      egress: ["api.anthropic.com:443", "claude.ai:443", ...(net?.egress ?? [])],
      files: { ...under(".claude/skills", files), ...net?.files },
      signal,
    });
    if (!run.ran) return { error: run.reason };
    return run.exitCode === 0 ? clean(run.stdout, [token]) : { error: `exit ${run.exitCode}` };
  }
  // Codex refreshes its sign-in during a run and may spend the old token, so the newer file is kept.
  const authPath = join(homedir(), ".codex/auth.json");
  const auth = readFileSync(authPath, "utf8");
  const sandbox = net ? ["--sandbox", "workspace-write", "-c", "sandbox_workspace_write.network_access=true"] : ["--sandbox", "read-only"];
  const run = await runSandboxed({
    binary: Bun.which("codex")!,
    args: ["exec", "--json", "--skip-git-repo-check", "--ignore-user-config", "--ignore-rules", ...sandbox, "--model", model, "-"],
    env: { CODEX_HOME: "/home/direx/.codex", ...net?.env },
    stdin: text,
    egress: ["chatgpt.com:443", "auth.openai.com:443", "api.openai.com:443", ...(net?.egress ?? [])],
    files: { ...under(".agents/skills", files), ".codex/auth.json": auth, ...net?.files },
    readBack: [".codex/auth.json"],
    signal,
  });
  if (!run.ran) return { error: run.reason };
  const refreshed = run.files[".codex/auth.json"];
  if (refreshed && refreshed !== auth) {
    JSON.parse(refreshed);
    writeFileSync(`${authPath}.tmp`, refreshed, { mode: 0o600 });
    renameSync(`${authPath}.tmp`, authPath);
  }
  return run.exitCode === 0 ? clean(run.stdout, [...secretsIn(auth), ...(refreshed ? secretsIn(refreshed) : [])]) : { error: `exit ${run.exitCode}` };
}

/** What a result is for: the skill's files, without its evals, as one short digest. */
export const skillDigest = (skill: string) => createHash("sha256").update(JSON.stringify(Object.entries(skillFiles(skill)).sort())).digest("hex").slice(0, 12);

/** Results for this skill, agent and model made from another version of the skill, which no longer count. */
export function staleResults(files: string[], skill: string, digest: string, provider: string, model: string): string[] {
  return files.filter((f) => {
    if (!f.startsWith(`${skill}-`)) return false;
    const rest = f.slice(skill.length + 1);
    const d = rest.slice(0, 12);
    const tail = rest.slice(12);
    return /^[0-9a-f]{12}$/.test(d) && d !== digest && (tail === `-${provider}-${model}.json` || tail.startsWith(`-${provider}-${model}-`));
  });
}

/** The agents with no passing result for the skill as it is now. Empty means it may be published. */
export function unprovenSkill(skill: string, dir = join(ROOT, "test/skills/results")): string[] {
  const digest = skillDigest(skill);
  const passed = (provider: Provider) => readdirSync(dir).some((f) => f === `${skill}-${digest}-${provider}-${MODELS[provider]}.json` && JSON.parse(readFileSync(join(dir, f), "utf8")).passed === true);
  return (Object.keys(MODELS) as Provider[]).filter((p) => !passed(p)).map((p) => `${p} ${MODELS[p]}`);
}

export async function evalSkill(o: { skill: string; provider: Provider; runs: number; model?: string; only?: string }) {
  const scorer = SCORERS[o.skill]!;
  const model = o.model ?? MODELS[o.provider];
  const files = skillFiles(o.skill);
  const digest = skillDigest(o.skill);
  const cases: Case[] = JSON.parse(readFileSync(join(ROOT, "skills", o.skill, "evals/cases.json"), "utf8")).cases.filter((c: Case) => !o.only || c.id === o.only);
  if (cases.length === 0) throw new Error(`no case ${o.only}`);
  const sites = scorer.pages && serveSites(cases, scorer.pages);

  const runs: { id: string; n: number; score: Score; output: string }[] = [];
  const jobs = cases.flatMap((c) => Array.from({ length: o.runs }, (_, i) => ({ c, n: i + 1 })));
  // Codex writes its sign-in back after each run, so its runs go one at a time.
  const width = o.provider === "codex" ? 1 : 3;
  let next = 0;
  try {
    await Promise.all(Array.from({ length: width }, async () => {
      while (next < jobs.length) {
        const { c, n } = jobs[next++]!;
        const r = await runOnce(o.provider, model, scorer.install(c, files), scorer.prompt(c, sites?.baseOf(c) ?? ""), sites);
        const output = "output" in r ? r.output : "";
        // A run that didn't happen is a problem, so the bar never counts it as met.
        const score = "output" in r ? scorer.score(c, output) : { problems: [`didn't run: ${r.error}`] };
        if ("leaked" in r && r.leaked) score.problems.push("printed a credential (removed from the saved answer)");
        runs.push({ id: c.id, n, score, output });
        console.log(`${c.id} #${n}: ${score.problems.length ? score.problems.join("; ") : "ok"}`);
      }
    }));
  } finally {
    sites?.stop();
  }
  runs.sort((a, b) => a.id.localeCompare(b.id) || a.n - b.n);
  const why = scorer.missesBar(runs);
  const result = { skill: o.skill, skillDigest: digest, provider: o.provider, model, at: new Date().toISOString(), runsPerCase: o.runs, passed: why === null, ...(why && { why }), runs };
  const dir = join(ROOT, "test/skills/results");
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `${o.skill}-${digest}-${o.provider}-${model}${o.only ? `-${o.only}` : ""}.json`);
  writeFileSync(file, `${JSON.stringify(result, null, 2)}\n`);
  for (const f of staleResults(readdirSync(dir), o.skill, digest, o.provider, model)) unlinkSync(join(dir, f));
  console.log(`${result.passed ? "meets its bar" : `misses its bar: ${why}`}. Written to ${relative(ROOT, file)}`);
  return result.passed;
}
