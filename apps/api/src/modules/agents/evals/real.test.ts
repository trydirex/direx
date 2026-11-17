// SPDX-License-Identifier: AGPL-3.0-only
// The real-key eval. Only `bun run eval --agent brand_reader [--provider claude_code]` runs it, against a
// throwaway test database, never the dev one. Everywhere else it is skipped.
import { expect, test } from "vitest";
import { seedMember } from "../../identity/fixtures/member";
import { CHECK_CANDIDATES, routesFor } from "../../models/index";
import { testKeys } from "../../models/fixtures/provider";
import { runEval } from "./harness";

const provider = process.env.DIREX_EVAL_PROVIDER === "claude_code" ? "claude_code" : "anthropic";
const key = provider === "claude_code" ? process.env.DIREX_EVAL_CLAUDE_CODE_TOKEN : process.env.DIREX_EVAL_ANTHROPIC_KEY;

test.skipIf(!key)("brand_reader passes on its first route, with a real model", { timeout: 300_000 }, async () => {
  const workspaceId = crypto.randomUUID();
  await seedMember(workspaceId, crypto.randomUUID());
  // The subscription isn't on the brand_extract route yet; it is the candidate the other extraction purposes try first.
  const candidate = provider === "claude_code" ? CHECK_CANDIDATES.claude_code : routesFor("self_host").brand_extract!.candidates.find((c) => c.provider === "anthropic")!;
  const result = await runEval({ workspaceId, candidate, keys: testKeys(key!, candidate.provider) });
  console.log(JSON.stringify(result, null, 2));
  expect(result.passed).toBe(true);
});
