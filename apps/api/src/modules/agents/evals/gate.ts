// SPDX-License-Identifier: AGPL-3.0-only
// Whether the agent-written mode may be offered: only with signed bars, and a result meeting each
// bar for exactly the definitions and model this Workspace would send with, in this language. Also
// whether a person's choice of model for an agent has a passing result for that agent as shipped.
import { existsSync } from "node:fs";
import { join } from "node:path";
import type { Route } from "../../models/index";
import { digestOf } from "../adapters/digest";
import { brandReader } from "../definitions/brand-reader";
import { missesBar, SAFETY_BARS, type BarKind, type Bars } from "./bars";
import { readResult, RESULTS_DIR, type EvalSuite } from "./check";

/** One eval the mode needs. The module that owns the definition passes it in. */
export type RequiredEval = { kind: BarKind; id: string; version: number; promptDigest: string };
export type Gate = { offered: true } | { offered: false; missing: string[] };

export const resultFileOf = (e: Pick<RequiredEval, "id" | "version">, provider: string, model: string) => `${e.id}-v${e.version}-${provider}-${model.replaceAll("/", "_")}.json`;

/** `modelFor` names the model an eval runs on when it isn't `model`, such as a check moved to a stronger one. */
export function safetyGate(a: { required: readonly RequiredEval[]; provider: string; model: string; modelFor?: Readonly<Record<string, string>>; language: string; resultsDir?: string; bars?: Bars }): Gate {
  const bars = a.bars ?? SAFETY_BARS;
  const missing: string[] = [];
  if (!bars.signedBy || !bars.signedOn) missing.push("the pass bars aren't signed");
  for (const e of a.required) {
    const model = a.modelFor?.[e.id] ?? a.model;
    const file = resultFileOf(e, a.provider, model);
    const path = join(a.resultsDir ?? RESULTS_DIR, file);
    if (!existsSync(path)) {
      missing.push(`${e.id}: no result on ${a.provider} ${model}`);
      continue;
    }
    const r = readResult(path);
    if (r.promptDigest !== e.promptDigest || r.definitionVersion !== e.version || r.provider !== a.provider || r.model !== model) {
      missing.push(`${e.id}: ${file} is for another version`);
      continue;
    }
    const why = missesBar(e.kind, r, a.language, bars);
    if (why) missing.push(`${e.id}: ${why}`);
  }
  return missing.length ? { offered: false, missing } : { offered: true };
}

type Shipped = EvalSuite["agent"];

/**
 * Answers from the result files for the definitions this build ships. `evaluated` asks whether a
 * passing result covers the agent (or every agent, for "all") on that model, for its current version
 * and prompt. `overrideAllowed` also needs the model in the route of each of the agent's purposes.
 * Each file is read once: a new result arrives with a deploy, which restarts the process.
 */
export function shippedEvals(agents: readonly Shipped[], routes: Readonly<Record<string, Route>>, resultsDir = RESULTS_DIR) {
  const all = [brandReader, ...agents];
  const known = new Map<string, boolean>();
  const passes = (a: Shipped, provider: string, model: string) => {
    const file = resultFileOf(a, provider, model);
    let ok = known.get(file);
    if (ok === undefined) {
      const path = join(resultsDir, file);
      const r = existsSync(path) ? readResult(path) : null;
      ok = Boolean(r?.passed && r.definitionVersion === a.version && r.provider === provider && r.model === model && r.promptDigest === digestOf(a.prompt));
      known.set(file, ok);
    }
    return ok;
  };
  const byId = (id: string) => all.find((a) => a.id === id);
  const inRoutes = (a: Shipped, provider: string, model: string) => a.purposes.every((p) => routes[p]?.candidates.some((c) => c.provider === provider && c.model === model));
  return {
    evaluated: (agent: string, provider: string, model: string): boolean => {
      if (agent === "all") return all.every((a) => passes(a, provider, model));
      const a = byId(agent);
      return Boolean(a && passes(a, provider, model));
    },
    overrideAllowed: (agent: string, provider: string, model: string): boolean => {
      const a = byId(agent);
      return Boolean(a && inRoutes(a, provider, model) && passes(a, provider, model));
    },
  };
}

/** Whether a passing eval of the Voice check (ADR 0022) is on file for this deployment's model: the
 * subscription on self-host, Direx's key on cloud, as for the lesson check. */
export function voiceCheckOpen(
  deployment: "self_host" | "cloud",
  check: { id: string; version: number; promptDigest: string },
  candidates: Record<"claude_code" | "anthropic", { provider: string; model: string }>,
  resultsDir?: string,
): boolean {
  const c = deployment === "self_host" ? candidates.claude_code : candidates.anthropic;
  const required = [{ kind: "injection_check" as const, id: check.id, version: check.version, promptDigest: check.promptDigest }];
  return safetyGate({ required, provider: c.provider, model: c.model, language: "en", ...(resultsDir ? { resultsDir } : {}) }).offered;
}
