// SPDX-License-Identifier: AGPL-3.0-only
import { expect, test } from "vitest";
import { staleResults } from "./run";

test("staleResults picks only older versions for the same skill, agent and model", () => {
  const files = [
    "page-brief-13e01af8d60b-codex-gpt-6-luna.json",
    "page-brief-b138bb51781c-codex-gpt-6-luna.json",
    "page-brief-b138bb51781c-codex-gpt-6-luna-one-case.json",
    "page-brief-b138bb51781c-claude_code-claude-haiku-5-5.json",
    "page-b138bb51781c-codex-gpt-6-luna.json",
    "claim-check-b138bb51781c-codex-gpt-6-luna.json",
  ];
  expect(staleResults(files, "page-brief", "13e01af8d60b", "codex", "gpt-6-luna")).toEqual([
    "page-brief-b138bb51781c-codex-gpt-6-luna.json",
    "page-brief-b138bb51781c-codex-gpt-6-luna-one-case.json",
  ]);
  expect(staleResults(files, "page", "13e01af8d60b", "codex", "gpt-6-luna")).toEqual(["page-b138bb51781c-codex-gpt-6-luna.json"]);
});
