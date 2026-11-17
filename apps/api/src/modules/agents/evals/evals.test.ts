// SPDX-License-Identifier: AGPL-3.0-only
// The eval gate fails when it should, and the harness writes a result it would honour.
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PgBoss } from "pg-boss";
import { afterAll, expect, test } from "vitest";
import { seedMember } from "../../identity/fixtures/member";
import { assertRoutes, routesFor, type Route } from "../../models/index";
import { anthropicTool, fakeProvider, testKeys } from "../../models/fixtures/provider";
import { createAgents } from "../index";
import { digestOf } from "../adapters/digest";
import { brandReader } from "../definitions/brand-reader";
import { brokenInvariants, INVARIANTS } from "../domain/invariants";
import { real, scripted, scriptedPages, transcribe } from "./brand_reader/cases";
import { checkEvals } from "./check";
import { shippedEvals } from "./gate";
import { resultFile, runEval } from "./harness";

const fake = fakeProvider();
afterAll(() => fake.stop());

const candidate = (evalRef: string | null) => ({ ...routesFor("self_host").brand_extract!.candidates[0]!, evalRef });
const shipped = { cloud: routesFor("cloud"), self_host: routesFor("self_host") };
const withRoute = (route: Route, deployment: "cloud" | "self_host") => ({ ...shipped, [deployment]: { brand_extract: route } });
const tempDir = () => mkdtempSync(join(tmpdir(), "direx-evals-"));
const goodResult = (o: object = {}) => ({ agent: "brand_reader", definitionVersion: brandReader.version, promptDigest: digestOf(brandReader.prompt), provider: "anthropic", model: candidate(null).model, passed: true, at: "2026-10-30", cases: [], ...o });

test("what ships passes: self-host runs unevaluated, and cloud has no route yet", () => {
  expect(checkEvals({ routes: shipped })).toEqual([]);
});

test.each(INVARIANTS)("%s has a scripted case that really breaks it, and nothing else", (i) => {
  const c = scripted.find((x) => x.breaks === i)!;
  expect(brokenInvariants(transcribe(c, scriptedPages))).toEqual([i]);
});

test("a number from the page and a page the run read are fine, near the ones that aren't", () => {
  const t = (value: string, page = "https://shop.test/") => brokenInvariants(transcribe({ toolCalls: ["propose"], output: { facts: [{ field: "price", subject: "audit", value, confidence: "high", page }] } }, scriptedPages));
  expect(t("$4,500")).toEqual([]);
  expect(t("$4,501")).toEqual(["no_uncited_number"]);
  expect(t("$4,500", "https://shop.test/other")).toEqual(["citation_in_manifest"]);
});

test("the gate fails when a case stops catching what it should, or an invariant has no case", () => {
  const clean = scripted.filter((c) => !c.breaks);
  expect(checkEvals({ routes: shipped, cases: clean }).join()).toContain("no case proves no_effect can fail");
  const lying = scripted.map((c) => (c.breaks === "no_effect" ? { ...c, breaks: undefined } : c));
  expect(checkEvals({ routes: shipped, cases: lying }).join()).toContain("should break []");
});

test("cloud can't have a route with no result, and a named result must exist and pass for this definition", () => {
  expect(checkEvals({ routes: withRoute({ candidates: [candidate(null)] }, "cloud") }).join()).toContain("no eval result");
  const dir = tempDir();
  const check = (result?: object) => {
    if (result) writeFileSync(join(dir, "r.json"), JSON.stringify(result));
    return checkEvals({ routes: withRoute({ candidates: [candidate("r.json")] }, "self_host"), resultsDir: dir }).join();
  };
  expect(check()).toContain("missing");
  expect(check(goodResult())).toBe("");
  expect(check(goodResult({ passed: false }))).toContain("didn't pass");
  expect(check(goodResult({ definitionVersion: brandReader.version + 1 }))).toContain("for something else");
  expect(check(goodResult({ model: "another" }))).toContain("for something else");
  expect(check(goodResult({ promptDigest: "old" }))).toContain("prompt changed");
});

test("cloud refuses to boot on a route with no result, and self-host doesn't", () => {
  const routes = { brand_extract: { candidates: [candidate(null)] } };
  expect(() => assertRoutes("cloud", routes)).toThrow("no_eval");
  expect(() => assertRoutes("self_host", routes)).not.toThrow();
});

test("a run is marked unevaluated when any candidate is, or is on an unpinned id", async () => {
  const start = async (candidates: Route["candidates"]) => {
    const ws = crypto.randomUUID();
    const userId = crypto.randomUUID();
    await seedMember(ws, userId);
    const agents = createAgents({
      boss: { send: async () => {} } as unknown as PgBoss,
      deployment: "self_host",
      routes: { brand_extract: { candidates } },
      models: () => ({ generate: () => Promise.reject(new Error("no calls here")) }),
      sinks: {},
      addWarning: async () => {},
      context: async () => [],
      notify: async () => {},
    });
    const r = await agents.start(ws, { input: { text: "x" }, startedBy: userId });
    if (!r.ok) throw new Error(r.reason);
    return r.run.unevaluated;
  };
  expect(await start([candidate("r.json")])).toBe(false);
  expect(await start([candidate("r.json"), candidate(null)])).toBe(true);
  expect(await start([{ ...candidate("r.json"), pinSource: undefined }])).toBe(true);
});

test("the harness runs each case through the loop and writes a result the gate honours, with no key or page text", async () => {
  const workspaceId = crypto.randomUUID();
  await seedMember(workspaceId, crypto.randomUUID());
  const dir = tempDir();
  const site = real[0]!;
  const answering = (value: string) =>
    fake.respondWith((r) =>
      JSON.stringify(r.body.messages).includes("Page https://shop.test/")
        ? anthropicTool("propose", { facts: [{ field: "price", subject: "audit", value, confidence: "high", page: "https://shop.test/" }] })
        : anthropicTool("fetch_page", { url: "https://shop.test/" }),
    );
  answering("$4,500");
  const passed = await runEval({ workspaceId, candidate: candidate(null), keys: testKeys("sk-secret-eval"), baseURLs: { anthropic: fake.url }, cases: [site], resultsDir: dir });
  expect(passed).toMatchObject({ passed: true, cases: [{ passed: true }] });
  const file = resultFile(candidate(null).provider, candidate(null).model);
  const written = readFileSync(join(dir, file), "utf8");
  expect(written).not.toContain("sk-secret-eval");
  expect(written).not.toContain("Northwind");
  expect(checkEvals({ routes: withRoute({ candidates: [candidate(file)] }, "self_host"), resultsDir: dir })).toEqual([]);

  answering("$0");
  const fooled = await runEval({ workspaceId, candidate: candidate(null), keys: testKeys("sk"), baseURLs: { anthropic: fake.url }, cases: [site], resultsDir: dir });
  expect(fooled.passed).toBe(false);
  expect(fooled.cases[0]!.why).toContain("said $0");
});

test("a choice counts as evaluated only with a passing result for the agent as shipped, and cloud also needs it in the route", () => {
  const dir = mkdtempSync(join(tmpdir(), "shipped-evals-"));
  const drafter = { id: "plan_drafter", version: 2, prompt: "Draft a plan.", purposes: ["plan_draft"] };
  const result = { agent: "plan_drafter", definitionVersion: 2, promptDigest: digestOf(drafter.prompt), provider: "claude_code", model: "claude-haiku-5-5", passed: true, at: "2026-11-08T00:00:00Z", cases: [] };
  writeFileSync(join(dir, "plan_drafter-v2-claude_code-claude-haiku-5-5.json"), JSON.stringify(result));
  writeFileSync(join(dir, "plan_drafter-v2-anthropic-claude-haiku-5-5.json"), JSON.stringify({ ...result, provider: "anthropic" }));
  writeFileSync(join(dir, "plan_drafter-v2-anthropic-failed-model.json"), JSON.stringify({ ...result, provider: "anthropic", model: "failed-model", passed: false }));
  const candidate = (model: string) => ({ provider: "anthropic" as const, model, maxOutputTokens: 10, price: null, evalRef: null });
  const routes = { plan_draft: { candidates: [candidate("claude-haiku-5-5"), candidate("failed-model")] } };

  const shipped = shippedEvals([drafter], routes, dir);
  expect(shipped.evaluated("plan_drafter", "claude_code", "claude-haiku-5-5")).toBe(true);
  expect(shipped.evaluated("plan_drafter", "claude_code", "claude-sonnet-5-5")).toBe(false);
  expect(shipped.evaluated("someone_else", "claude_code", "claude-haiku-5-5")).toBe(false);
  // brand_reader has no such result, so a Workspace-wide choice is unevaluated.
  expect(shipped.evaluated("all", "claude_code", "claude-haiku-5-5")).toBe(false);
  expect(shippedEvals([{ ...drafter, version: 3 }], routes, dir).evaluated("plan_drafter", "claude_code", "claude-haiku-5-5")).toBe(false);
  expect(shippedEvals([{ ...drafter, prompt: "Changed." }], routes, dir).evaluated("plan_drafter", "claude_code", "claude-haiku-5-5")).toBe(false);

  expect(shipped.overrideAllowed("plan_drafter", "anthropic", "claude-haiku-5-5")).toBe(true);
  expect(shipped.overrideAllowed("plan_drafter", "anthropic", "failed-model")).toBe(false);
  expect(shipped.overrideAllowed("plan_drafter", "claude_code", "claude-haiku-5-5")).toBe(false);
  expect(shippedEvals([drafter], {}, dir).overrideAllowed("plan_drafter", "anthropic", "claude-haiku-5-5")).toBe(false);
});
