// SPDX-License-Identifier: AGPL-3.0-only
// Which AI runs, on a self-hosted Models page: choosing Claude Code or Codex, signing in through
// the CLI's own page, testing and signing out. Each test clicks through and checks the call made.
import { afterEach, expect, test, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { api } from "../client";
import { withQueries, choose } from "../testing";
import type { AdapterList, AdapterRow } from "./actions";
import { Models } from "./Models";
import { writingTier } from "./Adapters";

const W = "00000000-0000-4000-8000-0000000000aa";
const reply = (status: number, body: unknown) => Promise.resolve({ ...(status < 400 ? { data: body } : { error: body }), response: new Response(null, { status }) });
const owner = { id: W, name: "Shop", role: "owner" as const, organization: { id: "o", name: "Acme" } };
const usage = { month: "2026-11", settledMicros: "0", heldMicros: "0", budgetMicros: "50000000", incidents: [], rows: [] };

const claude: AdapterRow = { id: "claude_code", label: "Claude Code", signIn: "setup_token", models: ["opus", "sonnet"], blocked: null, shared: false, mine: false, signedOut: false, evaluated: false, writing: [] };
const codex: AdapterRow = { id: "codex", label: "Codex", signIn: "device", models: ["gpt-5"], blocked: null, shared: true, mine: true, signedOut: false, evaluated: true, writing: [] };
const forClaude = { path: { workspaceId: W, adapter: "claude_code" } };
const forCodex = { path: { workspaceId: W, adapter: "codex" } };

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

/** A self-hosted Workspace with `list` as its adapters; each write answers with `write`. */
function serve(list: AdapterList, write: (method: string, path: string, init: unknown) => Promise<unknown>, role: "owner" | "marketer" = "owner") {
  vi.spyOn(api, "GET").mockImplementation(((path: string) => {
    if (path === "/api/w/{workspaceId}/models/connections") return reply(200, { deployment: "self_host", providers: [] });
    if (path === "/api/w/{workspaceId}/models/usage") return reply(200, usage);
    if (path === "/api/w/{workspaceId}/models/settings") return reply(200, { monthlyBudgetMicros: "50000000", allowUnpriced: false });
    if (path === "/api/w/{workspaceId}/credentials") return reply(200, { credentials: [] });
    if (path === "/api/w/{workspaceId}/models/adapters") return reply(200, list);
    return reply(404, { error: "not_found" });
  }) as never);
  const spies = Object.fromEntries((["POST", "PUT", "DELETE"] as const).map((m) => [m, vi.spyOn(api, m).mockImplementation(((path: string, init: unknown) => write(m, path, init)) as never)]));
  render(withQueries(<Models workspace={{ ...owner, role }} />));
  return spies as Record<"POST" | "PUT" | "DELETE", ReturnType<typeof vi.spyOn>>;
}
const both: AdapterList = { choice: { adapter: "claude_code", model: null }, agents: [{ agent: "brand_reader", adapter: "codex", model: "gpt-5" }], adapters: [claude, codex] };

test("each AI shows where it's signed in", async () => {
  serve(
    {
      choice: null,
      agents: [],
      adapters: [
        { ...claude, blocked: "not_installed" },
        { ...codex, blocked: "This machine can't run Codex." },
      ],
    },
    () => reply(200, {}),
  );
  expect(await screen.findByText("Not installed. Install Claude Code on the machine running Direx, then reload this page.")).toBeTruthy();
  expect(screen.getByText("This machine can't run Codex.")).toBeTruthy();
  cleanup();
  serve({ choice: null, agents: [], adapters: [claude, { ...codex, blocked: "not_installed" }] }, () => reply(200, {}));
  expect(await screen.findByText("Not installed. Codex comes with Direx: run bun install on the machine running Direx, then restart it.")).toBeTruthy();
  cleanup();
  serve({ choice: null, agents: [], adapters: [{ ...claude, signedOut: true }, { ...codex, mine: false }] }, () => reply(200, {}));
  expect(await screen.findByText(/^Signed out\. Direx can't use this sign-in/)).toBeTruthy();
  expect(screen.getByText("Signed in for this Workspace")).toBeTruthy();
  cleanup();
  serve({ choice: null, agents: [], adapters: [{ ...claude, mine: true }, codex] }, () => reply(200, {}));
  expect(await screen.findByText("Signed in just for you")).toBeTruthy();
  expect(screen.getByText("Signed in for this Workspace and just for you")).toBeTruthy();
});

test("a Marketer sees which AI the Workspace uses, with nothing to choose", async () => {
  serve(both, () => reply(200, {}), "marketer");
  expect(await screen.findByText("This Workspace uses Claude Code.")).toBeTruthy();
  expect(screen.queryByLabelText("AI for this Workspace")).toBeNull();
  expect(screen.queryByRole("button", { name: /^Sign in to .* for this Workspace$/ })).toBeNull();
});

test("choosing the Workspace's AI, its model and an agent's AI saves each", async () => {
  const s = serve(both, () => reply(200, {}));
  expect(await screen.findByText("Not tested with Direx")).toBeTruthy();
  await choose("AI for this Workspace", "Codex");
  await vi.waitFor(() => expect(s.PUT).toHaveBeenCalledWith("/api/w/{workspaceId}/models/adapter", { params: { path: { workspaceId: W } }, body: { adapter: "codex", model: null } }));
  expect((await screen.findAllByText("Saved.")).length).toBeGreaterThan(0);
  await choose("Model for AI for this Workspace", "sonnet");
  await vi.waitFor(() => expect(s.PUT).toHaveBeenCalledWith("/api/w/{workspaceId}/models/adapter", { params: { path: { workspaceId: W } }, body: { adapter: "claude_code", model: "sonnet" } }));
  await choose("AI for Strategy drafter", "Claude Code");
  await vi.waitFor(() =>
    expect(s.PUT).toHaveBeenCalledWith("/api/w/{workspaceId}/models/agents/{agent}/adapter", { params: { path: { workspaceId: W, agent: "strategy_drafter" } }, body: { adapter: "claude_code", model: null } }),
  );
  await choose("Model for AI for Brand reader", "Default model");
  await vi.waitFor(() =>
    expect(s.PUT).toHaveBeenCalledWith("/api/w/{workspaceId}/models/agents/{agent}/adapter", { params: { path: { workspaceId: W, agent: "brand_reader" } }, body: { adapter: "codex", model: null } }),
  );
});

test("signing in to Claude Code just for me: open its page, paste the code, finish", async () => {
  let finish = reply(400, { error: "bad_code" });
  const s = serve(both, (_m, path) => (path.endsWith("/finish") ? finish : reply(200, { id: "s1", link: "https://claude.ai/oauth", userCode: "WXYZ" })));
  await userEvent.click((await screen.findAllByRole("button", { name: "Sign in to Claude Code just for me" }))[0]!);
  expect(s.POST).toHaveBeenCalledWith("/api/w/{workspaceId}/models/adapters/{adapter}/sign-in/personal", { params: forClaude });
  expect((await screen.findByRole("link", { name: "Open the sign-in page" })).getAttribute("href")).toBe("https://claude.ai/oauth");
  expect(screen.getByText("Enter this code there: WXYZ")).toBeTruthy();
  await userEvent.type(screen.getByLabelText("Paste the code it shows you"), "  abc  ");
  await userEvent.click(screen.getByRole("button", { name: "Finish signing in" }));
  expect((await screen.findByRole("alert")).textContent).toContain("That code didn't work.");
  expect(s.POST).toHaveBeenLastCalledWith("/api/w/{workspaceId}/models/sign-ins/{id}/finish", { params: { path: { workspaceId: W, id: "s1" } }, body: { code: "abc" } });
  finish = reply(200, { ok: true });
  await userEvent.click(screen.getByRole("button", { name: "Finish signing in" }));
  expect((await screen.findAllByText("Signed in to Claude Code.")).length).toBeGreaterThan(0);
  expect(screen.queryByRole("button", { name: "Finish signing in" })).toBeNull();
});

test("a Workspace sign-in by device finishes without a code; one that won't start says so", async () => {
  let start = reply(200, { id: "s2", link: "not-a-web-link", userCode: null });
  const s = serve({ ...both, adapters: [{ ...claude, signIn: "device" }, codex] }, (_m, path) => (path.endsWith("/finish") ? reply(200, { ok: true }) : start));
  await userEvent.click(await screen.findByRole("button", { name: "Sign in to Claude Code for this Workspace" }));
  expect(s.POST).toHaveBeenCalledWith("/api/w/{workspaceId}/models/adapters/{adapter}/sign-in/shared", { params: forClaude });
  expect(await screen.findByText("Come back here once you've signed in.")).toBeTruthy();
  expect(screen.queryByRole("link", { name: "Open the sign-in page" })).toBeNull();
  await userEvent.click(screen.getByRole("button", { name: "Finish signing in" }));
  await vi.waitFor(() => expect(s.POST).toHaveBeenLastCalledWith("/api/w/{workspaceId}/models/sign-ins/{id}/finish", { params: { path: { workspaceId: W, id: "s2" } }, body: { code: null } }));
  start = reply(409, { error: "not_installed" });
  await userEvent.click(screen.getByRole("button", { name: "Sign in to Claude Code for this Workspace" }));
  expect((await screen.findByRole("alert")).textContent).toContain("This AI isn't installed on the machine running Direx.");
});

test("testing Codex says it works, and a test that fails to answer says so", async () => {
  let test: () => Promise<unknown> = () => reply(200, { ok: true });
  const s = serve(both, () => test());
  await userEvent.click(await screen.findByRole("button", { name: "Test Codex" }));
  expect((await screen.findAllByText("Codex works.")).length).toBeGreaterThan(0);
  expect(s.POST).toHaveBeenCalledWith("/api/w/{workspaceId}/models/adapters/{adapter}/test", { params: forCodex });
  test = () => Promise.reject(new Error("offline"));
  await userEvent.click(screen.getByRole("button", { name: "Test Codex" }));
  expect((await screen.findByRole("alert")).textContent).toContain("The provider didn't answer in time.");
});

test("signing Codex out just for me, then for the Workspace", async () => {
  const s = serve(both, () => reply(200, { ok: true }));
  await userEvent.click(await screen.findByRole("button", { name: "Sign out of Codex just for me" }));
  await vi.waitFor(() => expect(s.DELETE).toHaveBeenCalledWith("/api/w/{workspaceId}/models/adapters/{adapter}/sign-in/personal", { params: forCodex }));
  expect((await screen.findAllByText("Signed out.")).length).toBeGreaterThan(0);
  await userEvent.click(screen.getByRole("button", { name: "Sign out of Codex for this Workspace" }));
  await vi.waitFor(() => expect(s.DELETE).toHaveBeenCalledWith("/api/w/{workspaceId}/models/adapters/{adapter}/sign-in/shared", { params: forCodex }));
});

test("each AI's Test button names its AI, so two rows can be told apart", async () => {
  serve({ choice: null, agents: [], adapters: [{ ...claude, mine: true }, codex] }, () => reply(200, {}));
  expect(await screen.findByRole("button", { name: "Test Claude Code" })).toBeTruthy();
  expect(screen.getByRole("button", { name: "Test Codex" })).toBeTruthy();
});

test("the writing tier is the one all three drafters sit on, none when unchanged, custom otherwise", () => {
  const m = ["small", "mid", "large"];
  const on = (model: string, adapter = "claude_code") => ["plan_drafter", "campaign_drafter", "recipient_writer"].map((agent) => ({ agent, adapter, model }));
  expect(writingTier(m, "claude_code", [])).toBeNull();
  expect(writingTier(m, "claude_code", on("large"))).toBe(2);
  expect(writingTier(m, "claude_code", [...on("mid").slice(0, 2), { agent: "recipient_writer", adapter: "claude_code", model: "small" }])).toBe("custom");
  expect(writingTier(m, "claude_code", on("large", "codex"))).toBe("custom");
});

test("Best writing puts the plan, Campaign and email drafters on the AI's largest model, and checks are left alone", async () => {
  const three = { ...claude, models: ["haiku", "sonnet", "opus"], writing: ["haiku", "sonnet", "opus"] };
  const { PUT } = serve({ choice: { adapter: "claude_code", model: null }, agents: [], adapters: [three, codex] }, () => reply(200, { ok: true }));
  expect(await screen.findByText("Not chosen: the drafters use the Workspace's model.")).toBeTruthy();
  await userEvent.click(screen.getByRole("radio", { name: /^Best writing/ }));
  await vi.waitFor(() => expect(PUT).toHaveBeenCalledTimes(3));
  expect((PUT.mock.calls as unknown[][]).map((c) => [(c[1] as { params: { path: { agent: string } } }).params.path.agent, (c[1] as { body: unknown }).body])).toEqual([
    ["plan_drafter", { adapter: "claude_code", model: "opus" }],
    ["campaign_drafter", { adapter: "claude_code", model: "opus" }],
    ["recipient_writer", { adapter: "claude_code", model: "opus" }],
  ]);
});

test("a tier stays closed until the drafters pass their eval on its model", async () => {
  const three = { ...claude, models: ["haiku", "sonnet", "opus"], writing: ["haiku"] };
  const { PUT } = serve({ choice: { adapter: "claude_code", model: null }, agents: [], adapters: [three, codex] }, () => reply(200, { ok: true }));
  const best = (await screen.findByRole("radio", { name: /^Best writing/ })) as HTMLInputElement;
  expect(best.disabled).toBe(true);
  expect(screen.getAllByText("Waiting for a passing eval on this model.")).toHaveLength(2);
  expect((screen.getByRole("radio", { name: /^Cheapest/ }) as HTMLInputElement).disabled).toBe(false);
  await userEvent.click(best);
  expect(PUT).not.toHaveBeenCalled();
});
