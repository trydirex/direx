// SPDX-License-Identifier: AGPL-3.0-only
// Smoke test for reading into Brand: what each role sees, in glossary terms, and that each action
// calls its endpoint.
import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { expect, test, vi } from "vitest";
import { api } from "../client";
import type { Role } from "../items/actions";
import { cancelRun, listRuns, noNewRun, pageReason, runDetail, saveRunSettings, startRead, statusLabel, type Run } from "./actions";
import { RunCaps, Runs } from "./Runs";
import { withQueries } from "../testing";

const W = "00000000-0000-4000-8000-0000000000aa";
const run = (o: Partial<Run> = {}): Run => ({ id: crypto.randomUUID(), agent: "brand_reader", status: "succeeded", statusReason: null, address: "https://shop.test/", startedBy: null, steps: 3, costMicros: "12500", subscription: false, tainted: true, unevaluated: false, incomplete: false, proposalCount: 2, createdAt: "2026-10-30T00:00:00.000Z", endedAt: null, ...o });
const page = (role: Role, runs: Run[] = [run()]) =>
  renderToString(withQueries(createElement(Runs, { workspaceId: W, role, initial: runs })))
    .replaceAll("<!-- -->", "")
    .replaceAll("&#x27;", "'");

test("anyone who may edit can read an address or paste text; a Viewer only sees the reads", () => {
  for (const word of ["Read our website", "Address", "Paste text instead"]) expect(page("contributor")).toContain(word);
  const viewer = page("viewer", [run({ status: "running" })]);
  for (const word of ["<form", "<input", "Cancel", "Paste text"]) expect(viewer).not.toContain(word);
  expect(viewer).toContain("What it read");
});

test("a read shows its state, what it proposed and cost, and only a live one can be cancelled", () => {
  const html = page("marketer");
  for (const word of ["https://shop.test/", "Finished", "2 proposed", "cost $0.01", "What it read"]) expect(html).toContain(word);
  expect(html).not.toContain("Cancel");
  expect(page("marketer", [run({ status: "running" })])).toContain("Cancel");
  expect(page("marketer", [run({ address: null })])).toContain("Pasted text");
});

test("a read that stopped says so, in plain words", () => {
  const html = page("marketer", [run({ status: "step_capped", incomplete: true }), run({ unevaluated: true })]);
  expect(html).toContain("reached its step limit");
  expect(html).toContain("a read that didn't finish");
  expect(html).toContain("hasn't tested this model");
  expect(statusLabel({ status: "failed", statusReason: "no_connection" })).toBe("Stopped: connect a model provider on the AI models page, then try again");
  expect(statusLabel({ status: "waiting", statusReason: "daily_cap" })).toContain("carries on when the day turns");
  expect(statusLabel({ status: "failed", statusReason: "made_up" })).toBe("Stopped: something went wrong");
  expect(pageReason("private_address")).toBe("it isn't a public address");
});

test("the page uses glossary words, and shows no internal codes", () => {
  const text = page("owner", [run({ status: "failed", statusReason: "free_text" }), run({ status: "timed_out" })]).replace(/<[^>]+>/g, " ");
  expect(text).not.toMatch(/\b(failed|agent|free_text|timed_out|tenant)\b/i);
});

test("caps show their values, and saving calls the settings endpoint", async () => {
  const html = renderToString(createElement(RunCaps, { workspaceId: W, initial: { enabled: true, maxConcurrentRuns: 2, maxDailyRuns: 100, revision: 1 } }));
  for (const word of ["Reading websites", 'value="2"', 'value="100"', "Save limits"]) expect(html).toContain(word);
  const patch = vi.spyOn(api, "PATCH").mockResolvedValue({ data: {}, error: undefined } as never);
  await saveRunSettings(W, { maxDailyRuns: 50 });
  expect(patch).toHaveBeenLastCalledWith("/api/w/{workspaceId}/agents/{agent}/settings", { params: { path: { workspaceId: W, agent: "brand_reader" } }, body: { maxDailyRuns: 50 } });
  vi.restoreAllMocks();
});

test("asking again for what was already read counts as nothing new", () => {
  const old = run();
  expect(noNewRun([old], [old])).toBe(true);
  expect(noNewRun([old], [run(), old])).toBe(false);
});

test("each action calls its endpoint", async () => {
  const post = vi.spyOn(api, "POST").mockResolvedValue({ data: {}, error: undefined } as never);
  const get = vi.spyOn(api, "GET").mockResolvedValue({ data: { runs: [run()] } } as never);
  const all = { path: { workspaceId: W } };
  const one = { path: { workspaceId: W, id: "r" } };
  await startRead(W, { url: "https://shop.test/" });
  expect(post).toHaveBeenLastCalledWith("/api/w/{workspaceId}/agents/brand_reader/runs", { params: all, body: { url: "https://shop.test/" } });
  await startRead(W, { text: "About us" });
  expect(post).toHaveBeenLastCalledWith("/api/w/{workspaceId}/agents/brand_reader/runs", { params: all, body: { text: "About us" } });
  await cancelRun(W, "r");
  expect(post).toHaveBeenLastCalledWith("/api/w/{workspaceId}/agents/runs/{id}/cancel", { params: one });
  expect(await listRuns(W)).toHaveLength(1);
  await runDetail(W, "r");
  expect(get).toHaveBeenLastCalledWith("/api/w/{workspaceId}/agents/runs/{id}", { params: one });
  vi.restoreAllMocks();
});

test("a run with no model says nothing about an untested model; a subscription run says so instead of $0.00", () => {
  const html = page("marketer", [run({ unevaluated: true, status: "failed", statusReason: "no_connection" })]);
  expect(html).not.toContain("hasn't tested this model");
  expect(page("marketer", [run({ costMicros: "0", subscription: true })])).toContain("ran on your subscription");
  expect(page("marketer", [run({ costMicros: "0", subscription: true })])).not.toContain("$0.00");
});

test("a refusal and a worker that stopped twice read in words that fit any run", () => {
  expect(statusLabel({ status: "failed", statusReason: "model_refusal" })).toBe("Stopped: the model didn't return anything Direx could use");
  expect(statusLabel({ status: "failed", statusReason: "lease_lapsed" })).toBe("Stopped: the worker stopped twice before it finished");
});
