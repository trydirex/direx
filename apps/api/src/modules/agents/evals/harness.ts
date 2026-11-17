// SPDX-License-Identifier: AGPL-3.0-only
// A real run of each real case through the whole loop, with pages served from the case. A case
// passes when no invariant breaks and the output says what it must. The result file says so, and
// holds no key and no page text. The caller's Workspace must already exist.
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import type { PgBoss } from "pg-boss";
import { createModels, type Route } from "../../models/index";
import { digestOf } from "../adapters/digest";
import { inWorkspace, readRun } from "../adapters/repo";
import { createLoop } from "../application/loop";
import { createRuns } from "../application/runs";
import { brandReader } from "../definitions/brand-reader";
import type { AgentDefinition } from "../definitions/define";
import { brokenInvariants } from "../domain/invariants";
import { real, transcribe, type RealCase } from "./brand_reader/cases";
import { RESULTS_DIR, type EvalResult } from "./check";

type ModelDeps = Parameters<typeof createModels>[0];
type Harness = { workspaceId: string; candidate: Route["candidates"][number]; keys: NonNullable<ModelDeps["keys"]>; baseURLs?: ModelDeps["baseURLs"]; cases?: RealCase[]; resultsDir?: string };

const definitions = { brand_reader: brandReader as unknown as AgentDefinition<never> };

export const resultFile = (provider: string, model: string) => `brand_reader-v${brandReader.version}-${provider}-${model.replaceAll("/", "_")}.json`;

export async function runEval(h: Harness): Promise<EvalResult> {
  const now = () => new Date();
  const runs = createRuns({ boss: { send: async () => {} } as unknown as PgBoss, now, notify: async () => {}, warnItem: async () => {} });
  const models = createModels({ deployment: "self_host", routes: { brand_extract: { candidates: [h.candidate] } }, keys: h.keys, baseURLs: h.baseURLs, runGate: runs.runGate, now });
  const tally: EvalResult["cases"] = [];

  for (const c of h.cases ?? real) {
    const toolCalls: string[] = [];
    const read: Record<string, string> = {};
    let output: unknown;
    const loop = createLoop({
      models: {
        generate: async (req) => {
          const r = await models.generate(req);
          if (r.ok) toolCalls.push(...r.toolCalls.map((t) => t.toolName));
          return r;
        },
      },
      runs,
      now,
      definitions,
      context: async () => [],
      fetchPage: async (_b, url) => {
        const text = c.pages[url];
        if (text === undefined) return { ok: false, url, reason: "http_error" };
        read[url] = text;
        return { ok: true, url, text, truncated: false };
      },
      accept: async (_r, _t, o) => void (output = o),
    });
    const started = await runs.start(h.workspaceId, { definition: brandReader, input: c.input, idempotencyKey: crypto.randomUUID(), trigger: "eval" });
    const claimed = await runs.wake({ workspaceId: h.workspaceId, runId: started.id });
    if (!claimed) throw new Error("eval: a run wasn't admitted");
    await loop.execute(claimed);

    const pasted = "text" in c.input;
    const facts = (output as { facts?: { page?: string }[] } | undefined)?.facts ?? [];
    // Pasted text has no pages to name, so a page isn't a citation there.
    const forCheck = pasted ? { facts: facts.map(({ page: _page, ...f }) => f) } : output;
    // A run that hands nothing over says why on its own record: a refused route, a reply that isn't the schema.
    const ended = output === undefined ? await inWorkspace(h.workspaceId, (tx) => readRun(tx, started.id)) : undefined;
    const broken = output === undefined ? [`no_output (${ended?.status}: ${ended?.statusReason ?? "no reason"})`] :brokenInvariants(transcribe({ toolCalls, output: forCheck }, pasted ? { pasted: (c.input as { text: string }).text } : read));
    const words = JSON.stringify(output ?? "");
    const why = [...broken, ...c.mustFind.filter((w) => !words.includes(w)).map((w) => `missing ${w}`), ...c.mustNotFind.filter((w) => words.includes(w)).map((w) => `said ${w}`)].join("; ");
    tally.push({ name: c.name, passed: !why, ...(why && { why }) });
  }

  const result: EvalResult = { agent: brandReader.id, definitionVersion: brandReader.version, promptDigest: digestOf(brandReader.prompt), provider: h.candidate.provider, model: h.candidate.model, passed: tally.every((t) => t.passed), at: now().toISOString(), cases: tally };
  writeFileSync(join(h.resultsDir ?? RESULTS_DIR, resultFile(h.candidate.provider, h.candidate.model)), `${JSON.stringify(result, null, 2)}\n`);
  return result;
}
