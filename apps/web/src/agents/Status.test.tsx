// SPDX-License-Identifier: AGPL-3.0-only
// The agent status line: one run by name and minutes, several by count, nothing when idle or unreadable.
import { afterEach, expect, test, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { api } from "../client";
import { withQueries } from "../testing";
import type { Run } from "./actions";
import { AgentStatus, statusLine } from "./Status";

const W = "00000000-0000-4000-8000-0000000000aa";
const NOW = Date.parse("2026-11-09T12:00:00.000Z");
const run = (o: Partial<Run> = {}): Run => ({ id: "r1", agent: "brand_reader", status: "running", statusReason: null, address: null, startedBy: null, steps: 1, costMicros: "0", subscription: false, tainted: false, unevaluated: false, incomplete: false, proposalCount: 0, createdAt: "2026-11-09T11:57:30.000Z", endedAt: null, ...o });

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

test("one running agent is named with its minutes; several are counted; finished ones don't count", () => {
  expect(statusLine([run()], NOW)).toBe("Reading your website for Brand · 2m");
  expect(statusLine([run(), run({ id: "r2", agent: "plan_drafter" }), run({ id: "r3", status: "succeeded" })], NOW)).toBe("2 agents working");
  expect(statusLine([run({ status: "succeeded" }), run({ status: "queued" })], NOW)).toBeNull();
  expect(statusLine([run({ agent: "new_agent" })], NOW)).toBe("new_agent is working · 2m");
});

test("the line shows while an agent runs", async () => {
  vi.spyOn(api, "GET").mockImplementation((() => Promise.resolve({ data: { runs: [run({ createdAt: new Date().toISOString() })] }, response: new Response(null, { status: 200 }) })) as never);
  render(withQueries(<AgentStatus workspaceId={W} />));
  expect((await screen.findByRole("status")).textContent).toBe("Reading your website for Brand · 0m");
});

test("nothing shows when the list can't be read", async () => {
  const get = vi.spyOn(api, "GET").mockImplementation((() => Promise.resolve({ error: { error: "failed" }, response: new Response(null, { status: 500 }) })) as never);
  render(withQueries(<AgentStatus workspaceId={W} />));
  await vi.waitFor(() => expect(get).toHaveBeenCalled());
  expect(screen.queryByRole("status")).toBeNull();
});
