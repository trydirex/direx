// SPDX-License-Identifier: AGPL-3.0-only
// Models loads through the query layer: a loading state first, then cost and providers, and an error
// panel with Retry when they can't be read.
import { afterEach, expect, test, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { api } from "../client";
import { withQueries, choose } from "../testing";
import { byPurpose, Models } from "./Models";

const W = "00000000-0000-4000-8000-0000000000aa";
const reply = (status: number, body: unknown) => Promise.resolve({ ...(status < 400 ? { data: body } : { error: body }), response: new Response(null, { status }) });
const viewer = { id: W, name: "Shop", role: "viewer" as const, organization: { id: "o", name: "Acme" } };
const usage = { month: "2026-11", settledMicros: "12500000", heldMicros: "0", budgetMicros: "50000000", incidents: [], rows: [] };

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

/** Connections answer with `connections`; usage and settings always answer; anything else is not found. */
function serve(connections: () => Promise<unknown>) {
  vi.spyOn(api, "GET").mockImplementation(((path: string) => {
    if (path === "/api/w/{workspaceId}/models/connections") return connections();
    if (path === "/api/w/{workspaceId}/models/usage") return reply(200, usage);
    if (path === "/api/w/{workspaceId}/models/settings") return reply(200, { monthlyBudgetMicros: "50000000", allowUnpriced: false });
    return reply(404, { error: "not_found" });
  }) as never);
}

test("Models shows a loading state, then this month's cost and the providers", async () => {
  serve(() => reply(200, { deployment: "cloud", providers: [{ provider: "anthropic", connected: true, credentialId: null, credentialName: null }] }));
  render(withQueries(<Models workspace={viewer} />));
  expect(screen.getAllByRole("status").some((s) => s.textContent === "Loading")).toBe(true);
  expect(await screen.findByText(/\$12\.50 of your \$50\.00 budget/)).toBeTruthy();
  expect(screen.getByText("Anthropic")).toBeTruthy();
});

test("when Models can't be read, it says so and Retry reads it again", async () => {
  let fail = true;
  serve(() => (fail ? reply(403, { error: "forbidden" }) : reply(200, { deployment: "cloud", providers: [] })));
  render(withQueries(<Models workspace={viewer} />));
  expect((await screen.findByRole("alert")).textContent).toContain("Your role doesn't allow that.");
  fail = false;
  await userEvent.click(screen.getByRole("button", { name: "Retry" }));
  expect(await screen.findByText(/Direx provides these models/)).toBeTruthy();
});

const owner = { ...viewer, role: "owner" as const };
const key = { id: "k1", scope: "workspace", ownerUserId: null, kind: "api_key", key: "anthropic", name: "Team key", description: null, connection: null, meta: {}, status: "active" };
const adapters = { choice: null, agents: [], adapters: [] };

/** A self-hosted Workspace an Owner manages; each write answers with `write`. */
const providers = [
  { provider: "anthropic", connected: true, credentialId: "k1", credentialName: "Team key" },
  { provider: "openai", connected: false, credentialId: null, credentialName: null },
];

function serveOwner(write: (method: string, path: string, init: unknown) => Promise<unknown>, extra: Partial<typeof usage> = {}, connected = providers) {
  vi.spyOn(api, "GET").mockImplementation(((path: string) => {
    if (path === "/api/w/{workspaceId}/models/connections")
      return reply(200, { deployment: "self_host", providers: connected });
    if (path === "/api/w/{workspaceId}/models/usage") return reply(200, { ...usage, ...extra });
    if (path === "/api/w/{workspaceId}/models/settings") return reply(200, { monthlyBudgetMicros: "50000000", allowUnpriced: false });
    if (path === "/api/w/{workspaceId}/credentials") return reply(200, { credentials: [key] });
    if (path === "/api/w/{workspaceId}/models/adapters") return reply(200, adapters);
    return reply(404, { error: "not_found" });
  }) as never);
  return Object.fromEntries((["POST", "PUT", "DELETE"] as const).map((m) => [m, vi.spyOn(api, m).mockImplementation(((path: string, init: unknown) => write(m, path, init)) as never)])) as Record<
    "POST" | "PUT" | "DELETE",
    ReturnType<typeof vi.spyOn>
  >;
}
const at = { path: { workspaceId: W } };
const anthropic = { path: { workspaceId: W, provider: "anthropic" } };

test("cost rows, held amounts and budget warnings show under this month's cost", async () => {
  serveOwner(() => reply(200, {}), {
    heldMicros: "1000000",
    incidents: [{ threshold: 80, openedAt: "2026-11-02T00:00:00Z" }] as never,
    rows: [{ purpose: "brand_reader", model: null, calls: 3, costMicros: "1234" }] as never,
  });
  render(withQueries(<Models workspace={owner} />));
  expect(await screen.findByText(/with \$1\.00 held for calls in progress/)).toBeTruthy();
  expect(screen.getByText("This month's model cost reached 80% of the budget.")).toBeTruthy();
  // Once in the cost by what Direx did, once more under Details by model.
  expect(screen.getAllByText("Brand reader")).toHaveLength(2);
  expect(screen.getAllByText("Under $0.01")).toHaveLength(2);
  const details = screen.getByText("Details by model").closest("details")!;
  expect(details.open).toBe(false);
  expect(details.textContent).toContain("No model");
  expect(details.textContent).toContain("3");
  // Calls are a detail, not a column of the main table.
  expect(screen.getAllByRole("columnheader", { name: "Calls" }).every((h) => details.contains(h))).toBe(true);
});

test("pasting a key for a provider with none saves it as a Workspace key, picks it and tests it", async () => {
  const s = serveOwner((m, path) => reply(path === "/api/w/{workspaceId}/credentials" ? 201 : 200, path === "/api/w/{workspaceId}/credentials" ? { credential: { ...key, id: "k2" } } : m === "POST" ? { ok: true } : {}));
  render(withQueries(<Models workspace={owner} />));
  // Anthropic already has a key, so only OpenAI asks for one.
  expect(screen.queryByLabelText(/Paste your Anthropic API key/)).toBeNull();
  await userEvent.type(await screen.findByLabelText(/^Paste your OpenAI API key/), "sk-test");
  await userEvent.click(screen.getByRole("button", { name: "Save and test OpenAI key" }));
  expect(await screen.findByText("OpenAI works.")).toBeTruthy();
  const openai = { path: { workspaceId: W, provider: "openai" } };
  expect(s.POST).toHaveBeenCalledWith("/api/w/{workspaceId}/credentials", {
    params: at,
    body: expect.objectContaining({ scope: "workspace", kind: "api_key", name: "OpenAI key", value: { key: "sk-test" } }),
  });
  expect(s.PUT).toHaveBeenCalledWith("/api/w/{workspaceId}/models/connections/{provider}", { params: openai, body: { credentialId: "k2" } });
  expect(s.POST).toHaveBeenCalledWith("/api/w/{workspaceId}/models/connections/{provider}/test", { params: openai });
});

test("a pasted key the server refuses says why and picks nothing", async () => {
  const s = serveOwner(() => reply(403, { error: "forbidden" }));
  render(withQueries(<Models workspace={owner} />));
  await userEvent.type(await screen.findByLabelText(/^Paste your OpenAI API key/), "sk-test");
  await userEvent.click(screen.getByRole("button", { name: "Save and test OpenAI key" }));
  expect((await screen.findByRole("alert")).textContent).toContain("Your role doesn't allow that.");
  expect(s.PUT).not.toHaveBeenCalled();
});

test("saving the budget sends it as micro-dollars and says it's saved", async () => {
  const s = serveOwner(() => reply(200, {}));
  render(withQueries(<Models workspace={owner} />));
  const input = await screen.findByLabelText(/^Monthly budget in dollars/);
  await userEvent.clear(input);
  await userEvent.type(input, "20.5");
  await userEvent.click(screen.getByRole("button", { name: "Save budget" }));
  expect(await screen.findByText("Budget saved.")).toBeTruthy();
  expect(s.PUT).toHaveBeenCalledWith("/api/w/{workspaceId}/models/settings", { params: at, body: { monthlyBudgetMicros: "20500000", allowUnpriced: false } });
});

test("a budget that isn't a dollar amount is refused before it's sent", async () => {
  const s = serveOwner(() => reply(200, {}));
  render(withQueries(<Models workspace={owner} />));
  const input = await screen.findByLabelText(/^Monthly budget in dollars/);
  await userEvent.clear(input);
  await userEvent.type(input, "lots");
  await userEvent.click(screen.getByRole("button", { name: "Save budget" }));
  expect((await screen.findByRole("alert")).textContent).toContain("Enter the budget as a dollar amount");
  expect(s.PUT).not.toHaveBeenCalled();
});

test("choosing a key for a provider sets it, and No key clears it", async () => {
  const s = serveOwner(() => reply(200, {}));
  render(withQueries(<Models workspace={owner} />));
  await choose("Key for OpenAI", "Team key");
  await vi.waitFor(() =>
    expect(s.PUT).toHaveBeenCalledWith("/api/w/{workspaceId}/models/connections/{provider}", { params: { path: { workspaceId: W, provider: "openai" } }, body: { credentialId: "k1" } }),
  );
  await choose("Key for Anthropic", "No key");
  await vi.waitFor(() => expect(s.DELETE).toHaveBeenCalledWith("/api/w/{workspaceId}/models/connections/{provider}", { params: anthropic }));
});

test("testing a key says it works, or why it doesn't", async () => {
  let result: unknown = { ok: true };
  const s = serveOwner(() => reply(200, result));
  render(withQueries(<Models workspace={owner} />));
  await userEvent.click(await screen.findByRole("button", { name: "Test Anthropic" }));
  expect(await screen.findByText("Anthropic works.")).toBeTruthy();
  expect(s.POST).toHaveBeenCalledWith("/api/w/{workspaceId}/models/connections/{provider}/test", { params: anthropic });
  result = { ok: false, reason: "provider_quota" };
  await userEvent.click(screen.getByRole("button", { name: "Test Anthropic" }));
  expect((await screen.findByRole("alert")).textContent).toContain("The provider says this key is over its limit.");
  // A success is a toast that fades; the refusal stays on the page, not in a toast.
  expect(screen.getByRole("alert").closest("[data-slot=toast]")).toBeNull();
});

test("allowing unpriced models asks first, since the budget can't stop them, then saves the setting", async () => {
  const s = serveOwner(() => reply(200, {}));
  render(withQueries(<Models workspace={owner} />));
  await userEvent.click(await screen.findByRole("checkbox", { name: /Allow models with no known price/ }));
  expect(s.PUT).not.toHaveBeenCalled();
  await userEvent.click(await screen.findByRole("button", { name: "Allow them" }));
  await vi.waitFor(() => expect(s.PUT).toHaveBeenCalledWith("/api/w/{workspaceId}/models/settings", { params: at, body: { monthlyBudgetMicros: "50000000", allowUnpriced: true } }));
});

test("a change that needs a recent sign-in asks for one", async () => {
  serveOwner(() => reply(403, { error: "step_up_required" }));
  render(withQueries(<Models workspace={owner} />));
  await choose("Key for OpenAI", "Team key");
  expect(await screen.findByRole("heading", { name: "Confirm it's you" })).toBeTruthy();
});

test("each provider's Test button names its provider, so two rows can be told apart", async () => {
  serveOwner(() => reply(200, {}), {}, providers.map((x) => ({ ...x, connected: true })));
  render(withQueries(<Models workspace={owner} />));
  expect(await screen.findByRole("button", { name: "Test Anthropic" })).toBeTruthy();
  expect(screen.getByRole("button", { name: "Test OpenAI" })).toBeTruthy();
});

test("self-hosted, Providers sit in the open with a status on each, not under Advanced", async () => {
  serveOwner(() => reply(200, {}));
  render(withQueries(<Models workspace={owner} />));
  const section = await screen.findByRole("region", { name: "Providers" });
  expect(section.closest("details")).toBeNull();
  expect(section.textContent).toContain("Ready");
  expect(section.textContent).toContain("Not set up");
});

test("cost is grouped by what Direx did, most costly first, naming the models used", () => {
  const rows = [
    { purpose: "claim_check", model: "m1", calls: 2, costMicros: "1000" },
    { purpose: "campaign_draft", model: "m1", calls: 1, costMicros: "5000" },
    { purpose: "claim_check", model: "m2", calls: 3, costMicros: "2000" },
  ];
  expect(byPurpose(rows)).toEqual([
    { purpose: "campaign_draft", calls: 1, costMicros: 5000, models: ["m1"] },
    { purpose: "claim_check", calls: 5, costMicros: 3000, models: ["m1", "m2"] },
  ]);
});

test("usage against the budget leads as a bar, and providers wait in a closed Advanced", async () => {
  serve(() => reply(200, { deployment: "cloud", providers: [{ provider: "anthropic", connected: true, credentialId: null, credentialName: null }] }));
  render(withQueries(<Models workspace={viewer} />));
  const bar = await screen.findByRole("progressbar", { name: "This month's AI cost against the budget" });
  expect(bar.getAttribute("aria-valuenow")).toBe("12500000");
  const advanced = screen.getByText("Advanced").closest("details")!;
  expect(advanced.open).toBe(false);
  expect(advanced.textContent).toContain("Anthropic");
  expect(advanced.textContent).not.toContain("$12.50 of your");
});

test("with no budget set there is no bar to fill", async () => {
  serveOwner(() => reply(200, {}), { budgetMicros: "0" });
  render(withQueries(<Models workspace={owner} />));
  expect(await screen.findByText(/of your \$0\.00 budget/)).toBeTruthy();
  expect(screen.queryByRole("progressbar")).toBeNull();
});
