// SPDX-License-Identifier: AGPL-3.0-only
// The Server page's Plugins section: the installed plugins and what each asks for; an upload reviewed,
// then installed only on confirm; refusal reasons; an upgrade's changes; removal after a confirmation;
// and a stale sign-in asking for a fresh one.
import { afterEach, expect, test, vi } from "vitest";
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { api } from "../client";
import { openDialog, withQueries } from "../testing";
import { Server } from "./Server";
import { HANDED } from "./ServerPlugins";

const ME = "00000000-0000-4000-8000-000000000001";
const STAGE = "00000000-0000-4000-8000-0000000000ee";
const SHA = "ab12cd34ef56".padEnd(64, "0");
const reply = (status: number, body: unknown) => Promise.resolve({ ...(status < 400 ? { data: body } : { error: body }), response: new Response(null, { status }) });
const crm = {
  pluginId: "com.acme.crm",
  name: "Acme CRM",
  version: "1.0.0",
  capabilities: [
    { kind: "effect", name: "crm.add_contact", reachesPerson: true },
    { kind: "query", name: "crm.find_contact", reachesPerson: false },
  ],
  connections: [{ key: "com.acme.crm:api", auth: "api_key" }],
  egress: ["api.acme.test"],
};
const review = (r: object) => ({ stageId: STAGE, entrySha256: SHA, mode: "install", plugin: crm, added: [], removed: [], permissionsChanged: false, ...r });

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

function serve(plugins: unknown[] = []) {
  vi.spyOn(api, "GET").mockImplementation(((path: string) => {
    if (path === "/api/server/policy") return reply(200, { policy: "invite_only", domains: [] });
    if (path === "/api/server/mail-status") return reply(200, { ok: true });
    if (path === "/api/server/accounts") return reply(200, { accounts: [] });
    if (path === "/api/server/plugins") return reply(200, { plugins });
    return reply(404, { error: "not_found" });
  }) as never);
}
const section = () => screen.findByRole("region", { name: "Plugins" });
async function upload() {
  render(withQueries(<Server me={ME} />));
  const file = new File(["export default {}"], "plugin.js", { type: "text/javascript" });
  await userEvent.upload(await screen.findByLabelText(/Upload a plugin/, { selector: "input" }), file);
  return file;
}

test("each installed plugin shows its id, short file hash, what it can do, what it connects with and the hosts it may reach", async () => {
  serve([{ ...crm, entrySha256: SHA }]);
  render(withQueries(<Server me={ME} />));
  const card = await within(await section()).findByRole("listitem", { name: "Acme CRM" });
  expect(card.textContent).toContain("Acme CRM 1.0.0");
  expect(card.textContent).toContain("Id com.acme.crm");
  expect(within(card).getByText("File ab12cd34ef56")).toBeTruthy();
  expect(within(card).getByText("crm.add_contact").parentElement!.textContent).toContain("Reaches a person");
  expect(within(card).getByText("crm.find_contact").parentElement!.textContent).not.toContain("Reaches a person");
  expect(within(card).getByText("com.acme.crm:api").parentElement!.textContent).toContain("API key");
  expect(within(card).getByText("Hosts it may reach, on port 443 only")).toBeTruthy();
  expect(within(card).getByText("api.acme.test")).toBeTruthy();
  expect(within(await section()).getByText(new RegExp(HANDED.slice(0, 40)))).toBeTruthy();
});

test("with none installed the section says so", async () => {
  serve();
  render(withQueries(<Server me={ME} />));
  expect(await within(await section()).findByText("No plugin is installed.")).toBeTruthy();
});

test("an upload is reviewed first, and only Install installs exactly what was reviewed", async () => {
  serve();
  const post = vi.spyOn(api, "POST").mockImplementation(((path: string) => (path === "/api/server/plugins/review" ? reply(200, review({})) : reply(200, { plugin: crm }))) as never);
  const file = await upload();
  const panel = await screen.findByRole("region", { name: "Review the plugin" });
  const sent = post.mock.calls[0]! as unknown as [string, { bodySerializer: (b: unknown) => unknown; headers: Record<string, string> }];
  expect(sent[0]).toBe("/api/server/plugins/review");
  expect(sent[1].bodySerializer("")).toBe(file);
  expect(sent[1].headers["content-type"]).toBe("application/octet-stream");
  expect(within(panel).getByRole("heading", { name: "Install Acme CRM 1.0.0?" })).toBeTruthy();
  expect(within(panel).getByText("crm.add_contact").parentElement!.textContent).toContain("Reaches a person");
  expect(within(panel).getByText("api.acme.test")).toBeTruthy();
  expect(within(panel).getByText(HANDED)).toBeTruthy();
  expect(post).toHaveBeenCalledTimes(1);
  await userEvent.click(within(panel).getByRole("button", { name: "Install" }));
  expect(post).toHaveBeenLastCalledWith("/api/server/plugins/confirm", { body: { stageId: STAGE, entrySha256: SHA } });
  await waitFor(() => expect(screen.queryByRole("region", { name: "Review the plugin" })).toBeNull());
});

test("Cancel drops the review and installs nothing", async () => {
  serve();
  const post = vi.spyOn(api, "POST").mockImplementation((() => reply(200, review({}))) as never);
  await upload();
  await userEvent.click(within(await screen.findByRole("region", { name: "Review the plugin" })).getByRole("button", { name: "Cancel" }));
  expect(screen.queryByRole("region", { name: "Review the plugin" })).toBeNull();
  expect(post).toHaveBeenCalledTimes(1);
});

test("a refused file lists every reason plainly, and offers nothing to install", async () => {
  serve();
  vi.spyOn(api, "POST").mockImplementation((() => reply(422, { error: "refused", reasons: ["It claims to be first-party.", "It may reach co.uk, a public suffix."] })) as never);
  await upload();
  const alert = await screen.findByRole("alert");
  expect(alert.textContent).toContain("Direx won't install this file:");
  expect(within(alert).getAllByRole("listitem").map((li) => li.textContent)).toEqual(["It claims to be first-party.", "It may reach co.uk, a public suffix."]);
  expect(screen.queryByRole("button", { name: "Install" })).toBeNull();
});

test("a file over 10 MB says so", async () => {
  serve();
  vi.spyOn(api, "POST").mockImplementation((() => reply(413, { error: "too_large" })) as never);
  await upload();
  expect((await screen.findByRole("alert")).textContent).toBe("That file is over 10 MB. A plugin is one bundled file of at most 10 MB.");
});

test("an upgrade shows what is new and gone, and that every Workspace must turn it on again", async () => {
  serve([{ ...crm, entrySha256: "f".repeat(64) }]);
  const post = vi
    .spyOn(api, "POST")
    .mockImplementation(((path: string) =>
      path === "/api/server/plugins/review" ? reply(200, review({ mode: "upgrade", plugin: { ...crm, version: "2.0.0" }, added: ["reaches api2.acme.test"], removed: ["query crm.find_contact"], permissionsChanged: true })) : reply(200, { plugin: crm })) as never);
  await upload();
  const panel = await screen.findByRole("region", { name: "Review the plugin" });
  expect(within(panel).getByRole("heading", { name: "Upgrade Acme CRM to 2.0.0?" })).toBeTruthy();
  expect(within(panel).getByText("New in this version").parentElement!.textContent).toContain("reaches api2.acme.test");
  expect(within(panel).getByText("Gone in this version").parentElement!.textContent).toContain("query crm.find_contact");
  expect(within(panel).getByText(/every Workspace that has it on must turn it on again/)).toBeTruthy();
  await userEvent.click(within(panel).getByRole("button", { name: "Upgrade" }));
  expect(post).toHaveBeenLastCalledWith("/api/server/plugins/confirm", { body: { stageId: STAGE, entrySha256: SHA } });
});

test("an upgrade that asks for the same keeps it on where it is on", async () => {
  serve([{ ...crm, entrySha256: "f".repeat(64) }]);
  vi.spyOn(api, "POST").mockImplementation((() => reply(200, review({ mode: "upgrade" }))) as never);
  await upload();
  const panel = await screen.findByRole("region", { name: "Review the plugin" });
  expect(within(panel).getByText("What it asks for is the same, so it stays on wherever it is on.")).toBeTruthy();
  expect(within(panel).getByText("Nothing new.")).toBeTruthy();
});

test("Remove asks first, saying it stops in every Workspace, then removes it", async () => {
  serve([{ ...crm, entrySha256: SHA }]);
  const del = vi.spyOn(api, "DELETE").mockImplementation((() => reply(200, { ok: true })) as never);
  render(withQueries(<Server me={ME} />));
  await userEvent.click(await screen.findByRole("button", { name: "Remove Acme CRM" }));
  expect(await screen.findByText("It stops in every Workspace that has it on, right away.")).toBeTruthy();
  expect(del).not.toHaveBeenCalled();
  await userEvent.click(within(openDialog("Remove Acme CRM?")!).getByRole("button", { name: "Remove" }));
  expect(del).toHaveBeenCalledWith("/api/server/plugins/{pluginId}", { params: { path: { pluginId: "com.acme.crm" } } });
});

test("a stale sign-in on upload asks to sign in again", async () => {
  serve();
  vi.spyOn(api, "POST").mockImplementation((() => reply(403, { error: "step_up_required" })) as never);
  await upload();
  expect(await screen.findByRole("heading", { name: "Confirm it's you" })).toBeTruthy();
  expect(screen.getByText(/Changing Server admins or plugins needs a recent sign-in/)).toBeTruthy();
});

test("a stale sign-in on Install asks to sign in again", async () => {
  serve();
  vi.spyOn(api, "POST").mockImplementation(((path: string) => (path === "/api/server/plugins/review" ? reply(200, review({})) : reply(403, { error: "step_up_required" }))) as never);
  await upload();
  await userEvent.click(within(await screen.findByRole("region", { name: "Review the plugin" })).getByRole("button", { name: "Install" }));
  expect(await screen.findByRole("heading", { name: "Confirm it's you" })).toBeTruthy();
});
