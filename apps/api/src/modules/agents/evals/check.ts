// SPDX-License-Identifier: AGPL-3.0-only
// What eval:check enforces. Every invariant has a scripted case proving it can fail, every clean
// case stays clean, and a route that names an eval result must have a passing one for this exact
// definition. Self-host may run a route with no result, marked unevaluated. Cloud may not.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Deployment, Route } from "../../models/index";
import { digestOf } from "../adapters/digest";
import { brandReader } from "../definitions/brand-reader";
import { brokenInvariants, INVARIANTS, type Transcript } from "../domain/invariants";
import { scripted, scriptedPages, transcribe, type ScriptedCase } from "./brand_reader/cases";

export const RESULTS_DIR = join(import.meta.dirname, "results");

export type EvalCase = { name: string; passed: boolean; why?: string; passes?: number; unsafe?: number; unanswered?: number };
export type EvalResult = {
  agent: string;
  definitionVersion: number;
  promptDigest: string;
  provider: string;
  model: string;
  passed: boolean;
  /** Why it misses its bar, when it does. */
  why?: string;
  at: string;
  /** How many times each case ran. A file written before repeated runs reads as 1. */
  runs?: number;
  cases: EvalCase[];
  /** Figures a bar reads, such as recall, precision or the share of runs answered. */
  measures?: Record<string, number>;
  /** Languages a fluent speaker has reviewed the cases of. */
  reviewedLanguages?: string[];
};

/** A result file as the gate and CI read it, with the run count filled in. */
export const readResult = (path: string): EvalResult & { runs: number } => {
  const r = JSON.parse(readFileSync(path, "utf8")) as EvalResult;
  return { ...r, runs: r.runs ?? 1 };
};

/** One shipped definition's cases. A later module passes in its own, so this one never imports it. */
export type EvalSuite = {
  agent: { id: string; version: number; prompt: string; purposes: readonly string[] };
  cases: ScriptedCase[];
  read: Record<string, string>;
  transcribe: (c: ScriptedCase, read: Record<string, string>) => Transcript;
};
type Checked = { cases?: ScriptedCase[]; suites?: EvalSuite[]; routes: Record<Deployment, Readonly<Record<string, Route>>>; resultsDir?: string };

export function checkEvals({ cases = scripted, suites = [], routes, resultsDir = RESULTS_DIR }: Checked): string[] {
  const all: EvalSuite[] = [{ agent: brandReader, cases, read: scriptedPages, transcribe }, ...suites];
  return all.flatMap((s) => checkSuite(s, routes, resultsDir));
}

function checkSuite({ agent, cases, read, transcribe }: EvalSuite, routes: Checked["routes"], resultsDir: string): string[] {
  const errors: string[] = [];
  for (const c of cases) {
    const broken = brokenInvariants(transcribe(c, read));
    const expected = c.breaks ? [c.breaks] : [];
    if (broken.join() !== expected.join()) errors.push(`${agent.id}: "${c.name}" should break [${expected.join()}], and broke [${broken.join()}]`);
  }
  for (const i of INVARIANTS) if (!cases.some((c) => c.breaks === i)) errors.push(`${agent.id}: no case proves ${i} can fail`);

  errors.push(...checkRouteResults(agent, routes, resultsDir));
  return errors;
}

/** A route that names a result must name a passing one for exactly this prompt and candidate. Cloud needs one. */
export function checkRouteResults(agent: EvalSuite["agent"], routes: Checked["routes"], resultsDir = RESULTS_DIR): string[] {
  const errors: string[] = [];
  for (const deployment of ["cloud", "self_host"] as const) {
    for (const purpose of agent.purposes) {
      for (const candidate of routes[deployment][purpose]?.candidates ?? []) {
        // scripts/eval-impact.ts reads the purpose from this prefix.
        const where = `${agent.id} v${agent.version} (${purpose}) on ${deployment} ${candidate.model}`;
        if (!candidate.evalRef) {
          if (deployment === "cloud") errors.push(`${where}: no eval result`);
          continue;
        }
        const path = join(resultsDir, candidate.evalRef);
        if (!existsSync(path)) {
          errors.push(`${where}: result ${candidate.evalRef} is missing`);
          continue;
        }
        const r = readResult(path);
        if (!r.passed) errors.push(`${where}: result ${candidate.evalRef} didn't pass`);
        if (r.agent !== agent.id || r.definitionVersion !== agent.version || r.model !== candidate.model || r.provider !== candidate.provider) errors.push(`${where}: result ${candidate.evalRef} is for something else`);
        if (r.promptDigest !== digestOf(agent.prompt)) errors.push(`${where}: the prompt changed since ${candidate.evalRef}`);
      }
    }
  }
  return errors;
}
