// SPDX-License-Identifier: AGPL-3.0-only
import { expect, test } from "vitest";
import type { Candidate } from "./domain/routes-check";
import { assertRoutes, deploymentFromEnv } from "./index";
import { routesFor } from "./purposes";

const bad: Candidate = { provider: "openrouter", model: "vendor/model", maxOutputTokens: 1, price: null, evalRef: null };

test("the deployment defaults to self-host and refuses anything unknown", () => {
  expect(deploymentFromEnv({})).toBe("self_host");
  expect(deploymentFromEnv({ DIREX_DEPLOYMENT: "cloud" })).toBe("cloud");
  expect(() => deploymentFromEnv({ DIREX_DEPLOYMENT: "clod" })).toThrow(/cloud or self_host/);
});

test("the shipped routes boot on both deployments", () => {
  expect(() => assertRoutes("cloud", routesFor("cloud"))).not.toThrow();
  expect(() => assertRoutes("self_host", routesFor("self_host"))).not.toThrow();
});

test("bad routes stop the boot, naming the purpose and reason", () => {
  expect(() => assertRoutes("cloud", { "draft.email": { candidates: [bad] } })).toThrow(/draft\.email: uncontracted_provider \(vendor\/model\)/);
  expect(() => assertRoutes("cloud", { "draft.email": { candidates: [bad] } })).toThrow(/draft\.email: unpinned/);
  expect(() => assertRoutes("self_host", { optout_detect: { candidates: [bad] } })).toThrow(/optout_detect: safety_unpinned/);
  expect(() => assertRoutes("self_host", { "draft.email": { candidates: [bad] } })).not.toThrow();
});
