// SPDX-License-Identifier: AGPL-3.0-only
// Smoke test for the Models page (M29): what each role and deployment sees, in glossary
// terms, and that each action calls its endpoint.
import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { expect, test, vi } from "vitest";
import { api } from "../client";
import { addKey, chooseAdapter, chooseForAgent, clearKey, cost, dollars, finishSignIn, pickKey, saveSettings, setKey, signOut, startSignIn, testAdapter, testKey, toMicros, type AdapterList, type AdapterRow, type ProviderRow, type Usage } from "./actions";
import { Models } from "./Models";
import { withQueries } from "../testing";

const W = "00000000-0000-4000-8000-0000000000aa";
const ws = (role: "owner" | "admin" | "marketer" | "viewer") => ({ id: W, name: "Shop", role, organization: { id: "o", name: "Acme" } });
const usage: Usage = {
  month: "2026-11",
  settledMicros: "12500000",
  heldMicros: "250000",
  budgetMicros: "50000000",
  incidents: [{ threshold: 80, openedAt: "2026-11-20T00:00:00.000Z" }],
  rows: [{ purpose: "connection_test", model: "claude-haiku-5-5", calls: 2, costMicros: "1500" }],
};
const providers: ProviderRow[] = [
  { provider: "anthropic", connected: true, credentialId: "c1", credentialName: "Team key" },
  { provider: "openai", connected: false, credentialId: null, credentialName: null },
];
const page = (role: Parameters<typeof ws>[0], deployment: "cloud" | "self_host") =>
  renderToString(
    withQueries(createElement(Models, {
      workspace: ws(role),
      initial: { deployment, providers, usage, settings: { monthlyBudgetMicros: "50000000", allowUnpriced: false }, keys: [] },
    })),
  )
    .replaceAll("<!-- -->", "")
    .replace(/<[^>]+>/g, " ");

test("cost shows in dollars and cents, with holds, incidents and the models used under details", () => {
  const text = page("viewer", "self_host");
  // "Action credits" is defined nowhere on screen, so the page doesn't use the term.
  expect(text).not.toContain("action credits");
  expect(text).toContain("Details by model");
  expect(text).toContain("$12.50 of your $50.00 budget for November 2026, with $0.25 held");
  expect(text).toContain("reached 80% of the budget");
  expect(text).toContain("claude-haiku-5-5");
  expect(text).toContain("Under $0.01");
  expect(text).not.toContain("$0.0015");
});

test("an Admin on self-host picks keys, tests them and sets the budget; a Viewer only reads", () => {
  const admin = renderToString(withQueries(createElement(Models, { workspace: ws("admin"), initial: { deployment: "self_host", providers, usage, settings: { monthlyBudgetMicros: "1", allowUnpriced: false }, keys: [] } })));
  expect(admin).toContain('role="combobox"');
  expect(admin).toContain("Test");
  expect(admin).toContain("Save budget");
  expect(admin).toContain("no known price");
  const viewer = page("viewer", "self_host");
  for (const s of ["No key", "Test", "Save budget", "no known price"]) expect(viewer).not.toContain(s);
});

test("self-host warns about unpaid Gemini keys", () => {
  expect(page("viewer", "self_host")).toContain("unpaid Gemini API keys");
  expect(page("viewer", "cloud")).not.toContain("Gemini API keys");
});

test("cloud is read-only for keys, and says the budget can only go down", () => {
  const text = page("owner", "cloud");
  expect(text).toContain("Direx provides these models");
  expect(text).toContain("can only go down");
  expect(text).not.toContain("No key");
  expect(text).not.toContain("no known price");
  expect(text).toContain("Test");
});

test("no page text uses words the glossary avoids", () => {
  for (const role of ["owner", "viewer"] as const) for (const d of ["cloud", "self_host"] as const) expect(page(role, d)).not.toMatch(/\b(secret|token|connection)s?\b/i);
});

test("amounts convert both ways without rounding drift", () => {
  expect(toMicros("12.50")).toBe("12500000");
  expect(toMicros("$50")).toBe("50000000");
  expect(toMicros("0.000001")).toBe("1");
  expect(toMicros("-1")).toBeNull();
  expect(toMicros("abc")).toBeNull();
  expect(toMicros("1.0000001")).toBeNull();
  expect(dollars("1500", 4)).toBe("$0.0015");
  expect(cost("1500")).toBe("Under $0.01");
  expect(cost("0")).toBe("$0.00");
  expect(cost("12345678")).toBe("$12.35");
});

test("each action calls its endpoint and returns the error code", async () => {
  const on = { params: { path: { workspaceId: W, provider: "anthropic" } } };
  const put = vi.spyOn(api, "PUT").mockResolvedValue({ data: {} } as never);
  const del = vi.spyOn(api, "DELETE").mockResolvedValue({ error: { error: "step_up_required" } } as never);
  const post = vi.spyOn(api, "POST").mockResolvedValue({ data: { ok: false, reason: "no_connection", callId: null } } as never);

  expect(await setKey(W, "anthropic", "c1")).toBeNull();
  expect(put).toHaveBeenLastCalledWith("/api/w/{workspaceId}/models/connections/{provider}", { ...on, body: { credentialId: "c1" } });
  expect(await clearKey(W, "anthropic")).toBe("step_up_required");
  expect(del).toHaveBeenLastCalledWith("/api/w/{workspaceId}/models/connections/{provider}", on);
  expect(await testKey(W, "anthropic")).toBe("no_connection");
  expect(post).toHaveBeenLastCalledWith("/api/w/{workspaceId}/models/connections/{provider}/test", on);
  const body = { monthlyBudgetMicros: "1", allowUnpriced: true };
  expect(await saveSettings(W, body)).toBeNull();
  expect(put).toHaveBeenLastCalledWith("/api/w/{workspaceId}/models/settings", { params: { path: { workspaceId: W } }, body });
});

test("a key the provider refuses is taken back off and, when just pasted, deleted, so it never shows as ready", async () => {
  const on = { params: { path: { workspaceId: W, provider: "anthropic" } } };
  vi.spyOn(api, "PUT").mockResolvedValue({ data: {} } as never);
  const del = vi.spyOn(api, "DELETE").mockResolvedValue({ data: {} } as never);
  const post = vi.spyOn(api, "POST").mockImplementation((async (path: string) =>
    path.endsWith("/test") ? { data: { ok: false, reason: "provider_refused", callId: null } } : { data: { credential: { id: "k9" } } }) as never);

  expect(await pickKey(W, "anthropic", "c1")).toBe("provider_refused");
  expect(del).toHaveBeenLastCalledWith("/api/w/{workspaceId}/models/connections/{provider}", on);

  del.mockClear();
  expect(await addKey(W, "anthropic", "sk-fake")).toBe("provider_refused");
  expect(del).toHaveBeenCalledWith("/api/w/{workspaceId}/models/connections/{provider}", on);
  expect(del).toHaveBeenLastCalledWith("/api/w/{workspaceId}/credentials/{id}", { params: { path: { workspaceId: W, id: "k9" } } });

  post.mockImplementation((async (path: string) => (path.endsWith("/test") ? { data: { ok: true, callId: "x" } } : { data: { credential: { id: "k9" } } })) as never);
  del.mockClear();
  expect(await addKey(W, "anthropic", "sk-good")).toBeNull();
  expect(del).not.toHaveBeenCalled();
});

const adapter = (a: Partial<AdapterRow>): AdapterRow => ({ id: "claude_code", label: "Claude Code", signIn: "setup_token", models: ["claude-haiku-5-5"], blocked: null, shared: false, mine: false, signedOut: false, evaluated: false, writing: [], ...a });
const picker = (role: Parameters<typeof ws>[0], adapters: AdapterList, deployment: "cloud" | "self_host" = "self_host") =>
  renderToString(withQueries(createElement(Models, { workspace: ws(role), initial: { deployment, providers, usage, settings: { monthlyBudgetMicros: "1", allowUnpriced: false }, keys: [], adapters } })))
    .replaceAll("<!-- -->", "");
const list = (adapters: AdapterRow[], extra: Partial<AdapterList> = {}): AdapterList => ({ choice: null, agents: [], adapters, ...extra });

test("the picker shows each AI's state, and marks a choice nobody has tested", () => {
  const text = picker("owner", list([adapter({ blocked: "not_installed" }), adapter({ id: "codex", label: "Codex", signedOut: true, shared: true })], { choice: { adapter: "codex", model: null } }));
  expect(text).toContain("Not installed. Install Claude Code");
  expect(text).toContain("Signed out. Direx can&#x27;t use this sign-in");
  expect(text).toContain("Not tested with Direx");
  const blocked = picker("owner", list([adapter({ blocked: "This machine has no sandbox." })]));
  expect(blocked).toContain("This machine has no sandbox.");
  expect(blocked).not.toContain("Sign in just for me");
});

test("anyone signs in for themselves; only a manager signs in for the Workspace or sets agents", () => {
  const owner = picker("owner", list([adapter({})]));
  for (const s of ["Sign in just for me", "Sign in for this Workspace", "Same as the Workspace", "AI for this Workspace"]) expect(owner).toContain(s);
  const viewer = picker("viewer", list([adapter({ mine: true })]));
  expect(viewer).toContain("Signed in just for you");
  expect(viewer).toContain("Test");
  for (const s of ["Sign in for this Workspace", "Same as the Workspace", "<select"]) expect(viewer).not.toContain(s);
  expect(picker("owner", list([adapter({ shared: true })]))).toContain("Sign out for this Workspace");
});

test("cloud shows no picker, and the sign-in screen carries no warning", () => {
  expect(picker("owner", list([adapter({})]), "cloud")).not.toContain("Which AI runs");
  expect(picker("owner", list([adapter({})]))).not.toMatch(/\b(terms|at risk|token|secret|warning)\b/i);
});

test("each picker action calls its endpoint and returns the error code", async () => {
  const at = { params: { path: { workspaceId: W } } };
  const on = { params: { path: { workspaceId: W, adapter: "codex" } } };
  const put = vi.spyOn(api, "PUT").mockResolvedValue({ data: {} } as never);
  const del = vi.spyOn(api, "DELETE").mockResolvedValue({ data: {} } as never);
  const post = vi.spyOn(api, "POST").mockResolvedValue({ data: { id: "s", link: "https://x", userCode: null, ok: false, reason: "signed_out" } } as never);
  const choice = { adapter: "codex", model: null } as const;

  expect(await chooseAdapter(W, choice)).toBeNull();
  expect(put).toHaveBeenLastCalledWith("/api/w/{workspaceId}/models/adapter", { ...at, body: choice });
  expect(await chooseForAgent(W, "plan_drafter", choice)).toBeNull();
  expect(put).toHaveBeenLastCalledWith("/api/w/{workspaceId}/models/agents/{agent}/adapter", { params: { path: { workspaceId: W, agent: "plan_drafter" } }, body: choice });
  expect(await startSignIn(W, "codex", true)).toMatchObject({ id: "s" });
  expect(post).toHaveBeenLastCalledWith("/api/w/{workspaceId}/models/adapters/{adapter}/sign-in/shared", on);
  await startSignIn(W, "codex", false);
  expect(post).toHaveBeenLastCalledWith("/api/w/{workspaceId}/models/adapters/{adapter}/sign-in/personal", on);
  expect(await testAdapter(W, "codex")).toBe("signed_out");
  expect(post).toHaveBeenLastCalledWith("/api/w/{workspaceId}/models/adapters/{adapter}/test", on);
  expect(await finishSignIn(W, "s", null)).toBeNull();
  expect(post).toHaveBeenLastCalledWith("/api/w/{workspaceId}/models/sign-ins/{id}/finish", { params: { path: { workspaceId: W, id: "s" } }, body: { code: null } });
  expect(await signOut(W, "codex", true)).toBeNull();
  expect(del).toHaveBeenLastCalledWith("/api/w/{workspaceId}/models/adapters/{adapter}/sign-in/shared", on);
  post.mockResolvedValueOnce({ error: { error: "not_installed" } } as never);
  expect(await startSignIn(W, "codex", false)).toEqual({ error: "not_installed" });
});
