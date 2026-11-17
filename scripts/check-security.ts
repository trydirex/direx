// SPDX-License-Identifier: AGPL-3.0-only
import { chmodSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Runs gitleaks, osv-scanner and Semgrep from pinned images, so nothing is installed on the host.
// Reports the rule and location, never a matched value. Exit 0 pass, 1 finding, 2 could not run.

const GITLEAKS = "zricethezav/gitleaks:v8.30.1";
const OSV = "ghcr.io/google/osv-scanner:v2.7.0";
const SEMGREP = "semgrep/semgrep:1.181.0";
const HIGH_CVSS = 7;

const root = join(import.meta.dir, "..");
const findings: string[] = [];
const bail = (msg: string): never => {
  console.error(`security: ${msg}`);
  process.exit(2);
};
const docker = (args: string[]) => Bun.spawnSync(["docker", "run", "--rm", "-v", `${root}:/repo:ro`, ...args], { stdout: "pipe", stderr: "pipe" });
const parse = <T>(tool: string, text: string): T => {
  try {
    return JSON.parse(text) as T;
  } catch {
    return bail(`${tool} did not return JSON`);
  }
};

const out = mkdtempSync(join(tmpdir(), "direx-gitleaks-"));
chmodSync(out, 0o777);
try {
  const r = docker(["-v", `${out}:/out`, GITLEAKS, "dir", "/repo", "--config", "/repo/.gitleaks.toml", "--redact", "--no-banner", "--report-format", "json", "--report-path", "/out/report.json"]);
  if (r.exitCode !== 0 && r.exitCode !== 1) bail(`gitleaks exited ${r.exitCode}`);
  const leaks = parse<{ RuleID: string; File: string; StartLine: number }[]>("gitleaks", readFileSync(join(out, "report.json"), "utf8"));
  for (const l of leaks) findings.push(`gitleaks ${l.RuleID} ${l.File.replace("/repo/", "")}:${l.StartLine}`);
} finally {
  rmSync(out, { recursive: true, force: true });
}

{
  const r = docker([OSV, "scan", "source", "-L", "/repo/bun.lock", "--format", "json"]);
  if (r.exitCode !== 0 && r.exitCode !== 1) bail(`osv-scanner exited ${r.exitCode}`);
  type Pkg = { package: { name: string; version: string }; groups?: { ids: string[]; max_severity?: string }[] };
  const report = parse<{ results?: { packages: Pkg[] }[] }>("osv-scanner", r.stdout.toString());
  for (const { packages } of report.results ?? []) {
    for (const p of packages) {
      for (const g of p.groups ?? []) {
        // A vulnerability with no score cannot be shown to be below the bar.
        const score = Number(g.max_severity || HIGH_CVSS);
        if (score >= HIGH_CVSS) findings.push(`osv ${g.ids[0]} ${p.package.name}@${p.package.version} (${g.max_severity || "unscored"})`);
      }
    }
  }
}

{
  const r = docker(["-w", "/repo", SEMGREP, "semgrep", "scan", "--config", "p/default", "--severity", "ERROR", "--metrics=off", "--quiet", "--exclude", "fixtures", "--json", "."]);
  if (r.exitCode !== 0 && r.exitCode !== 1) bail(`semgrep exited ${r.exitCode}`);
  const report = parse<{ results: { check_id: string; path: string; start: { line: number } }[] }>("semgrep", r.stdout.toString());
  for (const f of report.results) findings.push(`semgrep ${f.check_id.split(".").pop()} ${f.path}:${f.start.line}`);
}

console.log(`security: ${findings.length} finding(s)`);
for (const f of findings) console.error(`  ${f}`);
process.exit(findings.length ? 1 : 0);
