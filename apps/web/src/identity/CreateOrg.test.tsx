// SPDX-License-Identifier: AGPL-3.0-only
// Creating an Organization from the business name, with the website handed on to setup, or saying it failed.
import { afterEach, expect, test, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { api } from "../client";
import { withQueries } from "../testing";
import { CreateOrg, NewOrg, siteAddress } from "./CreateOrg";

const reply = (status: number, body: unknown) => Promise.resolve({ ...(status < 400 ? { data: body } : { error: body }), response: new Response(null, { status }) });

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

async function create(website = "") {
  await userEvent.type(screen.getByLabelText("Business name"), "Acme Rota");
  if (website) await userEvent.type(screen.getByLabelText(/^Website/), website);
  await userEvent.click(screen.getByRole("button", { name: "Create and set up" }));
}

test("the business name names both the Organization and its first Workspace, and the website goes on to setup", async () => {
  const post = vi.spyOn(api, "POST").mockImplementation((() => reply(201, { workspace: { id: "w1" } })) as never);
  const onCreated = vi.fn();
  render(<CreateOrg onCreated={onCreated} />);
  await create("acmerota.com");
  await vi.waitFor(() => expect(onCreated).toHaveBeenCalledWith("w1", "https://acmerota.com"));
  expect(post).toHaveBeenCalledWith("/api/orgs", { body: { name: "Acme Rota", workspaceName: "Acme Rota" } });
});

test("an agency gives the Organization its own name under Setting up for clients", async () => {
  const post = vi.spyOn(api, "POST").mockImplementation((() => reply(201, { workspace: { id: "w1" } })) as never);
  const onCreated = vi.fn();
  render(<CreateOrg onCreated={onCreated} />);
  await userEvent.click(screen.getByText("Setting up for clients?"));
  await userEvent.type(screen.getByLabelText("Organization name"), "North Agency");
  await create();
  await vi.waitFor(() => expect(onCreated).toHaveBeenCalledWith("w1", ""));
  expect(post).toHaveBeenCalledWith("/api/orgs", { body: { name: "North Agency", workspaceName: "Acme Rota" } });
});

test("a typed website gets https unless it has a scheme", () => {
  expect(siteAddress(" acmerota.com ")).toBe("https://acmerota.com");
  expect(siteAddress("http://acmerota.com")).toBe("http://acmerota.com");
  expect(siteAddress("  ")).toBe("");
});

test.each([
  [400, "invalid", "We couldn't create the Organization. Check the names and try again."],
  [403, "cannot_create_organization", "Your account can't create an Organization on this server. Ask whoever runs it, or ask to be invited to a Workspace."],
] as const)("when creation returns %i (%s), the form shows the matching guidance", async (statusCode, code, guidance) => {
  vi.spyOn(api, "POST").mockImplementation((() => reply(statusCode, { error: code })) as never);
  const onCreated = vi.fn();
  render(<CreateOrg onCreated={onCreated} />);
  await create();
  expect((await screen.findByRole("alert")).textContent).toContain(guidance);
  expect(onCreated).not.toHaveBeenCalled();
});

const status = (s: { claimed: boolean; canCreateOrganization: boolean }) => vi.spyOn(api, "GET").mockImplementation((() => reply(200, s)) as never);

test("on a server nobody has claimed, /new-org says how to claim it instead of the form", async () => {
  status({ claimed: false, canCreateOrganization: false });
  render(withQueries(<NewOrg onCreated={vi.fn()} />));
  expect(await screen.findByRole("heading", { name: "This server has no Server admin yet" })).toBeTruthy();
  expect(screen.getByText("bun run server-admin --invite")).toBeTruthy();
  expect(screen.queryByLabelText("Business name")).toBeNull();
});

test("on a claimed server, someone the Admission refuses is told why without naming a rule, instead of the form", async () => {
  status({ claimed: true, canCreateOrganization: false });
  render(withQueries(<NewOrg onCreated={vi.fn()} />));
  expect(await screen.findByRole("heading", { name: "You can't create an Organization here" })).toBeTruthy();
  expect(screen.getByText("Your account can't create an Organization on this server. Ask whoever runs it, or ask to be invited to a Workspace.")).toBeTruthy();
  expect(document.body.textContent).not.toMatch(/Server admin/);
  expect(screen.queryByLabelText("Business name")).toBeNull();
});

test("a Server admin, or anyone in dev, gets the form", async () => {
  for (const s of [{ claimed: true, canCreateOrganization: true }, { claimed: false, canCreateOrganization: true }]) {
    status(s);
    render(withQueries(<NewOrg onCreated={vi.fn()} />));
    expect(await screen.findByLabelText("Business name")).toBeTruthy();
    cleanup();
    vi.restoreAllMocks();
  }
});
