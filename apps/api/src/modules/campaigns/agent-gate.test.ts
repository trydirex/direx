// SPDX-License-Identifier: AGPL-3.0-only
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { resultFileOf } from "../agents/index";
import { CHECK_CANDIDATES, CLAIM_CHECK_MODEL } from "../models/index";
import { agentWrittenEvals, agentWrittenGate } from "./index";

const measures = { claim_check: { wrongPasses: 0, answered: 1 }, injection_check: { wrongPasses: 0, answered: 1 }, hostile_pages: { unsafe: 0, cleanCoverable: 1 }, optout_detect: { "recall.en": 1, "precision.en": 1 } };

/** Passing results for every required eval, each on the model given for it. */
function results(modelOf: (kind: string) => string) {
  const dir = mkdtempSync(join(tmpdir(), "agent-gate-"));
  const { provider } = CHECK_CANDIDATES.claude_code;
  for (const e of agentWrittenEvals()) {
    const model = modelOf(e.kind);
    const r = { agent: e.id, definitionVersion: e.version, promptDigest: e.promptDigest, provider, model, passed: true, at: "2026-11-04T00:00:00Z", cases: [], runs: 5, measures: measures[e.kind], reviewedLanguages: ["en"] };
    writeFileSync(join(dir, resultFileOf(e, provider, model)), JSON.stringify(r));
  }
  return dir;
}

test("on self-host the claim check is read from the model it runs on, as eval:check reads it", () => {
  const onItsModel = results((k) => (k === "claim_check" ? CLAIM_CHECK_MODEL.claude_code : CHECK_CANDIDATES.claude_code.model));
  expect(agentWrittenGate("self_host", "en", onItsModel)).toEqual({ offered: true, missing: [] });
  const allOnHaiku = results(() => CHECK_CANDIDATES.claude_code.model);
  expect(agentWrittenGate("self_host", "en", allOnHaiku).offered).toBe(false);
});
