// SPDX-License-Identifier: AGPL-3.0-only
// Social loads through the query layer: a loading state first, then the accounts and networks, and
// an error panel with Retry when they can't be read.
import { afterEach, expect, test, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { api } from "../client";
import { withQueries } from "../testing";
import { Social } from "./Social";

const W = "00000000-0000-4000-8000-0000000000aa";
const ME = "00000000-0000-4000-8000-000000000001";
const workspace = { id: W, name: "Shop", role: "owner" as const, organization: { id: "o", name: "Acme" } };
const reply = (status: number, body: unknown) => Promise.resolve({ ...(status < 400 ? { data: body } : { error: body }), response: new Response(null, { status }) });
const network = { connection: "net", label: "Net", accountTypes: ["page"], connect: "oauth", availability: "available", canConnect: true, publishes: true, app: "system" };

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

function serve(networks: () => Promise<unknown>) {
  vi.spyOn(api, "GET").mockImplementation(((path: string) => {
    if (path === "/api/w/{workspaceId}/social/networks") return networks();
    if (path === "/api/w/{workspaceId}/social/accounts") return reply(200, { accounts: [] });
    return reply(404, { error: "not_found" });
  }) as never);
}

test("Social shows a loading state, then the networks and what is connected", async () => {
  serve(() => reply(200, { networks: [network] }));
  render(withQueries(<Social workspace={workspace} me={ME} />));
  expect(screen.getAllByRole("status").some((s) => s.textContent === "Loading")).toBe(true);
  expect(await screen.findByRole("button", { name: "Connect Net" })).toBeTruthy();
  expect(await screen.findByText("No account is connected yet.")).toBeTruthy();
});

test("when the networks can't be read, Social says so and Retry reads them again", async () => {
  let fail = true;
  serve(() => (fail ? reply(403, { error: "forbidden" }) : reply(200, { networks: [network] })));
  render(withQueries(<Social workspace={workspace} me={ME} />));
  expect((await screen.findByRole("alert")).textContent).toContain("Your role doesn't allow that.");
  fail = false;
  await userEvent.click(screen.getByRole("button", { name: "Retry" }));
  expect(await screen.findByRole("button", { name: "Connect Net" })).toBeTruthy();
});
