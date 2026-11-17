// SPDX-License-Identifier: AGPL-3.0-only
import { expect, test } from "vitest";
import { impactOf } from "./eval-impact";

test("a changed prompt asks for a bump and a rerun; an injection change adds the hostile pages", () => {
  const out = [
    "eval:check: plan_drafter v3 (plan_draft) on self_host claude-sonnet-5-5: the prompt changed since plan-drafter.json",
    "eval:check: injection_check v2 (injection_check) on cloud claude-haiku-5-5: the prompt changed since injection.json",
    "eval:check: injection_check v2 (injection_check) on self_host claude-haiku-5-5: the prompt changed since injection.json",
    "eval:check: brand_reader v4 (brand_extract) on cloud claude-haiku-5-5: result brand.json is for something else",
    "eval:check: clip_picker v1 (clip_pick) on cloud claude-haiku-5-5: no eval result",
    "eval:check: skill agent-readiness: no passing result for its current files on codex gpt-6-luna, claude_code claude-sonnet-5-5",
    "eval:check: skill page-brief: proven on both agents",
  ].join("\n");
  expect(impactOf(out)).toEqual({
    bump: ["plan_drafter", "injection_check"],
    commands: [
      "bun run eval --skill agent-readiness --provider codex",
      "bun run eval --skill agent-readiness --provider claude_code",
      "bun run eval --purpose plan_draft --provider claude_code --runs 3",
      "bun run eval --purpose injection_check --provider claude_code --runs 5",
      "bun run eval --purpose hostile_pages --provider claude_code --runs 5",
    ],
    notes: [expect.stringContaining("brand_reader")],
  });
});

test("a clean gate asks for nothing", () => {
  expect(impactOf("eval:check: skill page-brief: proven on both agents\neval:check: ok")).toEqual({ bump: [], commands: [], notes: [] });
});
