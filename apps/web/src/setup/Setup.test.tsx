// SPDX-License-Identifier: AGPL-3.0-only
// A new Workspace's setup wizard: each step is done when the Workspace shows it, one step is on
// screen at a time, and it opens on the first one not done.
import { afterEach, expect, test, vi } from "vitest";
import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { api } from "../client";
import { choose, withQueries } from "../testing";
import { Home } from "../items/Home";
import { aiConnected, Setup } from "./Setup";

const W = "00000000-0000-4000-8000-0000000000aa";
const reply = (status: number, body: unknown) => Promise.resolve({ ...(status < 400 ? { data: body } : { error: body }), response: new Response(null, { status }) });
const adapter = (o: Record<string, unknown> = {}) => ({ id: "claude_code", label: "Claude Code", signIn: "setup_token", models: [], blocked: null, shared: false, mine: false, signedOut: false, evaluated: true, ...o });
const fact = { id: "f1", field: "what_you_sell", value: "Audits" };
const finished = { id: "r1", status: "succeeded", statusReason: null, createdAt: "2026-11-14T10:00:00.000Z" };
const proposal = { id: "p1", kind: "fact_proposal", title: "What you sell: Audits", revision: 3 };

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

function serve(o: { deployment?: "cloud" | "self_host"; adapters?: unknown[]; facts?: unknown[]; items?: unknown[]; plans?: unknown[]; runs?: unknown[]; failFacts?: boolean }) {
  vi.spyOn(api, "GET").mockImplementation(((path: string) => {
    if (path === "/api/w/{workspaceId}/models/connections") return reply(200, { deployment: o.deployment ?? "cloud", providers: [] });
    if (path === "/api/w/{workspaceId}/models/usage" || path === "/api/w/{workspaceId}/models/settings") return reply(200, {});
    if (path === "/api/w/{workspaceId}/models/adapters") return reply(200, { choice: null, agents: [], adapters: o.adapters ?? [] });
    if (path === "/api/w/{workspaceId}/facts") return o.failFacts ? reply(403, { error: "forbidden" }) : reply(200, { facts: o.facts ?? [] });
    if (path === "/api/w/{workspaceId}/items") return reply(200, { items: o.items ?? [], needsYouCount: 0 });
    if (path === "/api/w/{workspaceId}/plans") return reply(200, { plans: o.plans ?? [] });
    if (path === "/api/w/{workspaceId}/agents/runs") return reply(200, { runs: o.runs ?? [] });
    return reply(404, { error: "not_found" });
  }) as never);
}
const show = () => render(withQueries(<Setup workspaceId={W} workspaceName="Acme" role="owner" />));
const steps = async () => Array.from((await screen.findByRole("list", { name: "Setup steps" })).children) as HTMLElement[];
const current = (title: string) => within(screen.getByRole("region", { name: title }));

test("on self-host with no AI signed in, connecting one is the open first step, alone on screen", async () => {
  serve({ deployment: "self_host", adapters: [adapter()] });
  show();
  const [ai, read] = await steps();
  expect(ai!.getAttribute("aria-current")).toBe("step");
  expect(ai!.textContent).toContain("Connect your AI");
  expect(read!.textContent).toContain("Read your website");
  const step = current("Connect the AI that writes for you");
  expect(step.getByText("Step 1 of 4")).toBeTruthy();
  expect(step.queryByRole("button", { name: "Back" })).toBeNull();
  expect(step.getByRole("button", { name: "Skip this step" })).toBeTruthy();
  expect(screen.queryByRole("region", { name: "Read your website" })).toBeNull();
});

test("a viewer sees whose step it is instead of controls they can't use", async () => {
  serve({ deployment: "cloud" });
  render(withQueries(<Setup workspaceId={W} workspaceName="Acme" role="viewer" />));
  await steps();
  expect(current("Read your website").getByText("Ask an Owner or Admin to run this step.")).toBeTruthy();
});

test("on cloud there is no AI step, so reading the website comes first", async () => {
  serve({ deployment: "cloud" });
  show();
  const list = await steps();
  expect(list).toHaveLength(3);
  expect(list[0]!.textContent).toContain("Read your website");
  expect(list[0]!.getAttribute("aria-current")).toBe("step");
});

test("Back and Next move one step at a time, and skipping past the last says what is left", async () => {
  serve({ deployment: "cloud", facts: [fact], runs: [finished] });
  show();
  await steps();
  // Read is done and nothing waits, so Check is done too: the wizard opens on the goal.
  const goal = current("Pick a first goal");
  expect(goal.getByText("Step 3 of 3")).toBeTruthy();
  await userEvent.click(goal.getByRole("button", { name: "Back" }));
  expect(current("Check what Direx understood").getByText("Step 2 of 3 · Done")).toBeTruthy();
  await userEvent.click(current("Check what Direx understood").getByRole("button", { name: "Next" }));
  await userEvent.click(current("Pick a first goal").getByRole("button", { name: "Skip this step" }));
  expect(screen.getByText("That's all the steps")).toBeTruthy();
  await userEvent.click(screen.getByRole("button", { name: "Back to what's left" }));
  expect(current("Pick a first goal")).toBeTruthy();
  expect(screen.getByRole("link", { name: "Finish setup later" }).getAttribute("href")).toBe(`/w/${W}`);
});

test("suggestions waiting are accepted or dismissed in setup itself, Brand one link away; with a plan started, setup is done", async () => {
  serve({ facts: [fact], items: [proposal] });
  const post = vi.spyOn(api, "POST").mockImplementation((() => reply(200, {})) as never);
  show();
  const [read] = await steps();
  expect(read!.textContent).toContain("Done. Direx read your site.");
  const check = current("Check what Direx understood");
  const proposed = within(check.getByRole("list", { name: "Proposed brand facts" }));
  expect(proposed.getByText("What you sell: Audits")).toBeTruthy();
  expect(proposed.getByRole("button", { name: "Dismiss What you sell: Audits" })).toBeTruthy();
  await userEvent.click(proposed.getByRole("button", { name: "Accept What you sell: Audits" }));
  expect(post).toHaveBeenCalledWith("/api/w/{workspaceId}/items/{id}/approve", expect.objectContaining({ params: { path: { workspaceId: W, id: "p1" } }, body: expect.objectContaining({ revision: 3 }) }));
  expect(check.getByRole("link", { name: "Open Brand" }).getAttribute("href")).toBe(`/w/${W}/brand`);
  cleanup();
  serve({ facts: [fact], plans: [{ id: "pl1" }], runs: [finished] });
  show();
  expect(await screen.findByText("You're set up")).toBeTruthy();
  expect(screen.getAllByRole("link", { name: "Go to Home" })[0]!.getAttribute("href")).toBe(`/w/${W}`);
});

test("any step in the list opens when clicked, done or not", async () => {
  serve({ deployment: "cloud" });
  show();
  const [, , goal] = await steps();
  await userEvent.click(within(goal!).getByRole("button"));
  expect(current("Pick a first goal").getByText("Step 3 of 3")).toBeTruthy();
  expect(screen.queryByRole("region", { name: "Read your website" })).toBeNull();
  // Skipped on the way past, so it says it is still open rather than completed.
  const [read] = await steps();
  expect(read!.textContent).toContain("Not done yet.");
  expect(read!.textContent).not.toContain("completed");
});

test("while the website is read, the step shows that read alone and lets the person move on; what it proposes reaches Check", async () => {
  const live = { id: "r2", agent: "brand_reader", status: "running", statusReason: null, address: "https://acme.example", proposalCount: 0, unevaluated: true, createdAt: "2026-11-14T10:00:00.000Z" };
  serve({ deployment: "cloud", runs: [live] });
  show();
  await steps();
  const read = current("Read your website");
  expect((await read.findByText("Reading https://acme.example")).getAttribute("role")).toBe("status");
  expect(read.getByText(/hasn't tested this model/)).toBeTruthy();
  expect(read.queryByLabelText("Address")).toBeNull();
  expect(read.getByRole("button", { name: "Cancel the read of https://acme.example" })).toBeTruthy();
  await userEvent.click(read.getByRole("button", { name: "Continue while it reads" }));
  expect(current("Check what Direx understood").getByText(/Direx is still reading/)).toBeTruthy();
  // The read finishes on the next poll, and its proposal shows without a reload.
  serve({ deployment: "cloud", runs: [{ ...live, status: "succeeded", proposalCount: 1 }], items: [proposal] });
  expect(await screen.findByRole("list", { name: "Proposed brand facts" }, { timeout: 6000 })).toBeTruthy();
});

test("a finished read is one line in its step, with a way to read again", async () => {
  serve({ deployment: "cloud", runs: [{ ...finished, agent: "brand_reader", address: "https://acme.example", proposalCount: 4 }] });
  show();
  await steps();
  await userEvent.click(screen.getByRole("button", { name: "Back" }));
  const read = current("Read your website");
  expect(read.getByText(/Last read https:\/\/acme.example: Finished, 4 proposed/)).toBeTruthy();
  expect(read.getByRole("button", { name: "Read your website again" })).toBeTruthy();
});

test("reads that all failed leave the read step open, even with facts typed on Brand", async () => {
  serve({ deployment: "cloud", facts: [fact], runs: [{ ...finished, status: "failed", statusReason: "no_route" }] });
  show();
  const [readStep] = await steps();
  expect(readStep!.textContent).not.toContain("Done.");
  expect(readStep!.getAttribute("aria-current")).toBe("step");
});

test("choosing the AI with a stale sign-in asks to confirm it's you, not to sign out", async () => {
  serve({ deployment: "self_host", adapters: [adapter(), adapter({ id: "codex", label: "Codex" })] });
  vi.spyOn(api, "PUT").mockImplementation((() => reply(403, { error: "step_up_required" })) as never);
  show();
  await screen.findByText("Which AI runs");
  await choose("AI for this Workspace", "Codex");
  expect(await screen.findByText("Confirm it's you")).toBeTruthy();
  expect(screen.queryByText(/Sign out and back in/)).toBeNull();
});

test("a read that fails says so and offers Retry, rather than loading forever", async () => {
  serve({ failFacts: true });
  show();
  expect((await screen.findByRole("alert")).textContent).toBe("Your role doesn't allow that.");
  expect(screen.getByRole("button", { name: "Retry" })).toBeTruthy();
});

test("an AI counts as connected only when it is the person's own or shared, and signed in", () => {
  expect(aiConnected(undefined)).toBe(false);
  expect(aiConnected({ choice: null, agents: [], adapters: [adapter({ mine: true })] } as never)).toBe(true);
  expect(aiConnected({ choice: null, agents: [], adapters: [adapter({ shared: true, signedOut: true })] } as never)).toBe(false);
});

test("an empty Home in a Workspace with nothing on Brand points to setup", async () => {
  serve({});
  render(withQueries(<Home workspaceId={W} role="owner" />));
  expect(await screen.findByText("Set up this Workspace")).toBeTruthy();
  expect(screen.getByRole("link", { name: "Start setup" }).getAttribute("href")).toBe(`/w/${W}/setup`);
});
