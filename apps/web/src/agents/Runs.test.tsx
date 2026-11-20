// SPDX-License-Identifier: AGPL-3.0-only
// The latest reads load through the query layer: a loading state first, then the reads; and a
// live read is polled until it ends, when the page is told to refresh.
import { afterEach, expect, test, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { api } from "../client";
import { withQueries } from "../testing";
import type { Run } from "./actions";
import userEvent from "@testing-library/user-event";
import { RunCaps, Runs } from "./Runs";

const W = "00000000-0000-4000-8000-0000000000aa";
const reply = (status: number, body: unknown) => Promise.resolve({ ...(status < 400 ? { data: body } : { error: body }), response: new Response(null, { status }) });
const run = (o: Partial<Run> = {}): Run => ({ id: "r1", agent: "brand_reader", status: "succeeded", statusReason: null, address: "https://shop.test/", startedBy: null, steps: 3, costMicros: "12500", subscription: false, tainted: true, unevaluated: false, incomplete: false, proposalCount: 2, createdAt: "2026-10-30T00:00:00.000Z", endedAt: null, ...o });

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

test("Runs shows a loading state, then the latest reads", async () => {
  vi.spyOn(api, "GET").mockImplementation((() => reply(200, { runs: [run()] })) as never);
  render(withQueries(<Runs workspaceId={W} role="marketer" />));
  expect(screen.getAllByRole("status").some((s) => s.textContent === "Loading")).toBe(true);
  expect(await screen.findByText(/https:\/\/shop\.test\/: Finished/)).toBeTruthy();
  // Only the reads are asked for, so other agents' newer runs can't push them off the list.
  expect(api.GET).toHaveBeenCalledWith("/api/w/{workspaceId}/agents/runs", { params: { path: { workspaceId: W }, query: { agent: "brand_reader" } } });
});

test("a list that can't be read shows no reads, and the form still works", async () => {
  vi.spyOn(api, "GET").mockImplementation((() => reply(500, { error: "failed" })) as never);
  render(withQueries(<Runs workspaceId={W} role="marketer" />));
  await waitFor(() => expect(screen.queryByText("Loading")).toBeNull());
  expect(screen.queryByRole("list", { name: "Latest reads" })).toBeNull();
  expect(screen.getByRole("button", { name: "Read" })).toBeTruthy();
});

test("a live read is polled until it ends, then onSettled runs", async () => {
  let status: Run["status"] = "running";
  vi.spyOn(api, "GET").mockImplementation((() => reply(200, { runs: [run({ status })] })) as never);
  const settled = vi.fn();
  render(withQueries(<Runs workspaceId={W} role="marketer" onSettled={settled} initial={[run({ status: "running" })]} />));
  expect(screen.getByRole("button", { name: "Cancel the read of https://shop.test/" })).toBeTruthy();
  status = "succeeded";
  await waitFor(() => expect(settled).toHaveBeenCalledOnce(), { timeout: 5000 });
  expect(screen.queryByRole("button", { name: /^Cancel/ })).toBeNull();
}, 10_000);

/** GET answers the runs list from `runs()`, a run's detail and the settings; POST/PATCH answer from `write`. */
function serveRuns(runs: () => Run[]) {
  return vi.spyOn(api, "GET").mockImplementation(((path: string) => {
    if (path === "/api/w/{workspaceId}/agents/runs") return reply(200, { runs: runs() });
    if (path === "/api/w/{workspaceId}/agents/runs/{id}")
      return reply(200, {
        read: [
          { kind: "web_page", ref: "https://shop.test/about", truncated: true },
          { kind: "pasted_text", ref: "t1", truncated: false },
        ],
        failedPages: [{ address: "https://other.test/", reason: "other_site" }],
        proposals: [{ rejectionCode: "already_in_brand" }, { rejectionCode: "bad" }, { rejectionCode: null }],
      });
    if (path === "/api/w/{workspaceId}/agents/{agent}/settings") return reply(200, { enabled: true, maxConcurrentRuns: 2, maxDailyRuns: 20 });
    return reply(404, { error: "not_found" });
  }) as never);
}

test("reading an address starts a read, clears the field and lists the new read", async () => {
  let list: Run[] = [];
  serveRuns(() => list);
  const post = vi.spyOn(api, "POST").mockImplementation((() => {
    list = [run({ id: "r2", address: "https://new.test/" })];
    return reply(201, {});
  }) as never);
  render(withQueries(<Runs workspaceId={W} role="marketer" initial={[]} />));
  const field = screen.getByLabelText("Address") as HTMLInputElement;
  await userEvent.type(field, "https://new.test/");
  // The button names the site once the address is one.
  await userEvent.click(screen.getByRole("button", { name: "Read new.test" }));
  expect(post).toHaveBeenCalledWith("/api/w/{workspaceId}/agents/brand_reader/runs", { params: { path: { workspaceId: W } }, body: { url: "https://new.test/" } });
  expect(await screen.findByText(/https:\/\/new\.test\/: Finished/)).toBeTruthy();
  expect(field.value).toBe("");
  expect(screen.queryByText(/already read this today/)).toBeNull();
});

test.each(["embedded", "compact"] as const)("a new read restores the %s summary and keeps the model caution", async (mode) => {
  let list = [run()];
  serveRuns(() => list);
  vi.spyOn(api, "POST")
    .mockImplementationOnce((() => reply(409, { error: "disabled" })) as never)
    .mockImplementationOnce((() => reply(201, {})) as never)
    .mockImplementationOnce((() => {
      list = [run({ id: "r2", address: "https://new.test/", unevaluated: true }), ...list];
      return reply(201, {});
    }) as never);
  render(withQueries(<Runs workspaceId={W} role="marketer" initial={list} embedded={mode === "embedded"} compact={mode === "compact"} />));
  expect(screen.queryByText(/hasn't tested this model/)).toBeNull();
  await userEvent.click(screen.getByRole("button", { name: "Read your website again" }));
  const address = screen.getByLabelText("Address") as HTMLInputElement;
  await userEvent.type(address, "https://shop.test/");
  await userEvent.click(screen.getByRole("button", { name: "Read shop.test" }));
  expect(await screen.findByText("Reading websites is turned off for this Workspace.")).toBeTruthy();
  expect(address.value).toBe("https://shop.test/");

  await userEvent.click(screen.getByRole("button", { name: "Read shop.test" }));
  expect(await screen.findByText(/already read this today/)).toBeTruthy();
  expect(screen.getByRole("list", { name: "Latest reads" })).toBeTruthy();

  await userEvent.type(address, "https://new.test/");
  await userEvent.click(screen.getByRole("button", { name: "Read new.test" }));
  expect(await screen.findByText("Last read https://new.test/: Finished, 2 proposed.")).toBeTruthy();
  expect(screen.getByText(/hasn't tested this model/)).toBeTruthy();
  expect(screen.getByRole("button", { name: "Read your website again" })).toBeTruthy();
  expect(screen.queryByLabelText("Address")).toBeNull();
  expect(screen.queryByRole("list", { name: "Latest reads" })).toBeNull();
});

test("a website given earlier is filled in, and the button names it", () => {
  vi.spyOn(api, "GET").mockImplementation((() => reply(200, { runs: [] })) as never);
  render(withQueries(<Runs workspaceId={W} role="marketer" initial={[]} address="https://www.acmerota.com" />));
  expect((screen.getByLabelText("Address") as HTMLInputElement).value).toBe("https://www.acmerota.com");
  expect(screen.getByRole("button", { name: "Read acmerota.com" })).toBeTruthy();
});

test("pasting text that was read today says so, and a refused read shows why", async () => {
  serveRuns(() => [run()]);
  const post = vi.spyOn(api, "POST").mockImplementation((() => reply(500, { error: "unexpected" })) as never).mockImplementationOnce((() => reply(201, {})) as never);
  render(withQueries(<Runs workspaceId={W} role="marketer" initial={[run()]} />));
  await userEvent.click(screen.getByRole("button", { name: "Paste text instead" }));
  await userEvent.type(screen.getByLabelText("Text"), "We sell audits.");
  await userEvent.click(screen.getByRole("button", { name: "Read" }));
  expect(post).toHaveBeenLastCalledWith("/api/w/{workspaceId}/agents/brand_reader/runs", { params: { path: { workspaceId: W } }, body: { text: "We sell audits." } });
  expect(await screen.findByText(/already read this today/)).toBeTruthy();

  post.mockImplementationOnce((() => reply(409, { error: "disabled" })) as never);
  await userEvent.type(screen.getByLabelText("Text"), "More text.");
  await userEvent.click(screen.getByRole("button", { name: "Read" }));
  expect(await screen.findByText("Reading websites is turned off for this Workspace.")).toBeTruthy();
  expect((screen.getByLabelText("Text") as HTMLTextAreaElement).value).toBe("More text.");
  await userEvent.click(screen.getByRole("button", { name: "Use an address instead" }));
  expect(screen.getByLabelText("Address")).toBeTruthy();
});

test("cancelling a live read posts the cancel, and a refusal is shown", async () => {
  serveRuns(() => [run({ status: "running", incomplete: true, unevaluated: true, address: null })]);
  const post = vi.spyOn(api, "POST").mockImplementation((() => reply(409, { error: "already_ended" })) as never);
  render(withQueries(<Runs workspaceId={W} role="marketer" initial={[run({ status: "running", incomplete: true, unevaluated: true, address: null })]} />));
  expect(screen.getByText(/Pasted text: Reading/)).toBeTruthy();
  expect(screen.getByText(/read that didn't finish/)).toBeTruthy();
  expect(screen.getByText(/hasn't tested this model/)).toBeTruthy();
  await userEvent.click(screen.getByRole("button", { name: "Cancel the read of pasted text" }));
  expect(post).toHaveBeenCalledWith("/api/w/{workspaceId}/agents/runs/{id}/cancel", { params: { path: { workspaceId: W, id: "r1" } } });
  expect(await screen.findByText("This read has already ended.")).toBeTruthy();
});

test("opening What it read shows the pages, the failures and what was left out", async () => {
  const get = serveRuns(() => [run()]);
  render(withQueries(<Runs workspaceId={W} role="viewer" initial={[run()]} />));
  expect(screen.queryByRole("button", { name: "Read" })).toBeNull();
  await userEvent.click(screen.getByText("What it read"));
  expect(await screen.findByText(/https:\/\/shop\.test\/about \(only the start of it\)/)).toBeTruthy();
  expect(screen.getByText("The text you pasted")).toBeTruthy();
  expect(screen.getByText("Couldn't read https://other.test/: it's on another site")).toBeTruthy();
  expect(screen.getByText("1 already in Brand, 1 left out.")).toBeTruthy();
  expect(get).toHaveBeenCalledWith("/api/w/{workspaceId}/agents/runs/{id}", { params: { path: { workspaceId: W, id: "r1" } } });
});

test("RunCaps loads the limits, saves the edited ones, and shows a refusal", async () => {
  serveRuns(() => []);
  const patch = vi.spyOn(api, "PATCH").mockImplementation((() => reply(200, {})) as never);
  render(withQueries(<RunCaps workspaceId={W} />));
  const once = await screen.findByLabelText("At once");
  await userEvent.click(screen.getByRole("checkbox"));
  await userEvent.clear(once);
  await userEvent.type(once, "3");
  await userEvent.clear(screen.getByLabelText("Per day"));
  await userEvent.type(screen.getByLabelText("Per day"), "50");
  await userEvent.click(screen.getByRole("button", { name: "Save limits" }));
  expect(patch).toHaveBeenCalledWith("/api/w/{workspaceId}/agents/{agent}/settings", { params: { path: { workspaceId: W, agent: "brand_reader" } }, body: { enabled: false, maxConcurrentRuns: 3, maxDailyRuns: 50 } });
  expect(await screen.findByText("Saved.")).toBeTruthy();
  patch.mockImplementation((() => reply(400, { error: "over_cloud_limit" })) as never);
  await userEvent.click(screen.getByRole("button", { name: "Save limits" }));
  expect(await screen.findByText(/at most 10 at once/)).toBeTruthy();
  // The refusal adds no second Saved.
  expect(screen.getAllByText("Saved.")).toHaveLength(1);
});

test("each live read's Cancel button names the read", () => {
  const list = [run({ status: "running" }), run({ id: "r2", status: "running", address: "https://other.test/" })];
  vi.spyOn(api, "GET").mockImplementation((() => reply(200, { runs: list })) as never);
  render(withQueries(<Runs workspaceId={W} role="marketer" initial={list} />));
  expect(screen.getByRole("button", { name: "Cancel the read of https://shop.test/" })).toBeTruthy();
  expect(screen.getByRole("button", { name: "Cancel the read of https://other.test/" })).toBeTruthy();
});
