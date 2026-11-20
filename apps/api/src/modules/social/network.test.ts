// SPDX-License-Identifier: AGPL-3.0-only
import { expect, test } from "vitest";
import { callbackProblem } from "./domain/network";

const CB = "/api/connections/callback";

test.each([
  [{ https: true }, `http://direx.example.com${CB}`, "needs_https"],
  [{ https: true }, `https://direx.example.com${CB}`, null],
  [{ noLocalhost: true }, `http://localhost:5173${CB}`, "no_localhost"],
  [{ noLocalhost: true }, `http://127.0.0.1:5173${CB}`, null],
  [undefined, `http://localhost:5173${CB}`, null],
  [{}, `http://localhost:5173${CB}`, null],
] as const)("rules %j with %s: %s", (rules, url, problem) => {
  expect(callbackProblem(rules, url)).toBe(problem);
});
