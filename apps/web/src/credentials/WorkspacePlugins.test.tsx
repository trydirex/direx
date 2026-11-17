// SPDX-License-Identifier: AGPL-3.0-only
// The connections page's third-party plugins: each with its Third-party label and what it can do and
// reach; an Owner turns one on and off; anyone else sees the state and who can change it; no section
// when none is installed.
import { afterEach, expect, test, vi } from "vitest";
import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { api } from "../client";
import { withQueries } from "../testing";
import { Credentials } from "./Credentials";

const W = "00000000-0000-4000-8000-0000000000aa";
const ME = "00000000-0000-4000-8000-000000000001";
const ws = (role: "owner" | "admin" | "marketer") => ({ id: W, name: "Shop", role, organization: { id: "o", name: "Acme" } });
const reply = (status: number, body: unknown) => Promise.resolve({ ...(status < 400 ? { data: body } : { error: body }), response: new Response(null, { status }) });
const crm = {
  pluginId: "com.acme.crm",
  name: "Acme CRM",
  version: "1.0.0",
  capabilities: [{ kind: "effect", name: "crm.add_contact", reachesPerson: true }],
  connections: [{ key: "com.acme.crm:api", auth: "api_key" }],
  egress: ["api.acme.test"],
};
const at = { params: { path: { workspaceId: W, pluginId: "com.acme.crm" } } };

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

/** The plugin list is `state.plugins`; once on, its key connection is listed as a key service. */
function serve(state: { plugins: { on: boolean }[] }) {
  vi.spyOn(api, "GET").mockImplementation(((path: string) => {
    if (path === "/api/w/{workspaceId}/plugins") return reply(200, { plugins: state.plugins });
    if (path === "/api/w/{workspaceId}/key-services") return reply(200, { services: state.plugins.some((p) => p.on) ? [{ connection: "com.acme.crm:api", name: "Acme CRM", canCheck: false }] : [] });
    return reply(200, { credentials: [], providers: [], checks: [], networks: [], platforms: [] });
  }) as never);
}
const section = () => screen.findByRole("region", { name: "Third-party plugins" });

test("an Owner sees each plugin labelled Third-party with what it can do and reach, and turns it on and off", async () => {
  const state = { plugins: [{ ...crm, on: false }] };
  serve(state);
  const put = vi.spyOn(api, "PUT").mockImplementation((() => {
    state.plugins = [{ ...crm, on: true }];
    return reply(200, { ok: true });
  }) as never);
  const del = vi.spyOn(api, "DELETE").mockImplementation((() => {
    state.plugins = [{ ...crm, on: false }];
    return reply(200, { ok: true });
  }) as never);
  render(withQueries(<Credentials workspace={ws("owner")} me={ME} />));
  const card = within(await section()).getByRole("listitem", { name: "Acme CRM" });
  expect(within(card).getByText("Third-party")).toBeTruthy();
  expect(within(card).getByText("crm.add_contact").parentElement!.textContent).toContain("Reaches a person");
  expect(within(card).getByText("api.acme.test")).toBeTruthy();
  expect(within(await section()).getByText(/A plugin can send anything it is handed/)).toBeTruthy();
  expect(within(await section()).queryByText("An Owner of this Workspace turns a plugin on or off.")).toBeNull();

  const toggle = within(card).getByRole("switch", { name: "Use Acme CRM in this Workspace" }) as HTMLInputElement;
  expect(toggle.checked).toBe(false);
  await userEvent.click(toggle);
  expect(put).toHaveBeenCalledWith("/api/w/{workspaceId}/plugins/{pluginId}", at);
  await vi.waitFor(() => expect(toggle.checked).toBe(true));
  expect(await within(card).findByText("Connect its key under Advanced: API keys, below.")).toBeTruthy();
  // On, its key connection is offered with the other API keys.
  await userEvent.click(screen.getByText("Advanced: API keys"));
  expect(await within(screen.getByRole("region", { name: "Shared with the team" })).findByText(/Acme CRM/)).toBeTruthy();

  await userEvent.click(toggle);
  expect(del).toHaveBeenCalledWith("/api/w/{workspaceId}/plugins/{pluginId}", at);
  await vi.waitFor(() => expect(toggle.checked).toBe(false));
});

test("someone who isn't an Owner sees whether it is on and that an Owner turns it on, and can't change it", async () => {
  serve({ plugins: [{ ...crm, on: true }] });
  const put = vi.spyOn(api, "PUT");
  const del = vi.spyOn(api, "DELETE");
  render(withQueries(<Credentials workspace={ws("admin")} me={ME} />));
  expect(await within(await section()).findByText("An Owner of this Workspace turns a plugin on or off.")).toBeTruthy();
  const toggle = screen.getByRole("switch", { name: "Use Acme CRM in this Workspace" }) as HTMLInputElement;
  expect(toggle.checked).toBe(true);
  // Astryx keeps a disabled switch focusable, so it says so with aria-disabled.
  expect(toggle.disabled || toggle.getAttribute("aria-disabled") === "true").toBe(true);
  await userEvent.click(toggle);
  expect(put).not.toHaveBeenCalled();
  expect(del).not.toHaveBeenCalled();
});

test("a refusal says why", async () => {
  serve({ plugins: [{ ...crm, on: false }] });
  vi.spyOn(api, "PUT").mockImplementation((() => reply(404, { error: "not_installed" })) as never);
  render(withQueries(<Credentials workspace={ws("owner")} me={ME} />));
  await section();
  await userEvent.click(screen.getByRole("switch", { name: "Use Acme CRM in this Workspace" }));
  expect((await screen.findByRole("alert")).textContent).toBe("That plugin was removed from this server. Reload the page.");
});

test("with no plugin installed there is no section", async () => {
  serve({ plugins: [] });
  render(withQueries(<Credentials workspace={ws("owner")} me={ME} />));
  expect(await screen.findByText("No email account is connected yet.")).toBeTruthy();
  await new Promise((done) => setTimeout(done, 20));
  expect(screen.queryByRole("region", { name: "Third-party plugins" })).toBeNull();
});
