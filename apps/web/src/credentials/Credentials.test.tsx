// SPDX-License-Identifier: AGPL-3.0-only
// Credentials loads through the query layer: a loading state first, then the credentials, and an
// error panel with Retry when they can't be read.
import { afterEach, expect, test, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { api } from "../client";
import { withQueries } from "../testing";
import { Credentials } from "./Credentials";

const W = "00000000-0000-4000-8000-0000000000aa";
const ME = "00000000-0000-4000-8000-000000000001";
const workspace = { id: W, name: "Shop", role: "marketer" as const, organization: { id: "o", name: "Acme" } };
const reply = (status: number, body: unknown) => Promise.resolve({ ...(status < 400 ? { data: body } : { error: body }), response: new Response(null, { status }) });

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

/** The credentials call answers with `credentials`; every other list is empty. */
function serve(credentials: () => Promise<unknown>) {
  vi.spyOn(api, "GET").mockImplementation(((path: string) => {
    if (path === "/api/w/{workspaceId}/credentials") return credentials();
    return reply(200, { providers: [], services: [], checks: [], networks: [] });
  }) as never);
}

test("Credentials shows a loading state, then my credentials", async () => {
  serve(() => reply(200, { credentials: [{ id: "c1", name: "CRM login", scope: "user", kind: "basic", ownerUserId: ME, connection: null, status: "active", lastUsedAt: null, version: 1 }] }));
  render(withQueries(<Credentials workspace={workspace} me={ME} tab="mine" />));
  expect(screen.getAllByRole("status").some((s) => s.textContent === "Loading")).toBe(true);
  expect(await screen.findByText("CRM login")).toBeTruthy();
  // Direx keeps no test of a typed login, so it never claims one works.
  expect(screen.getByText("Not checked")).toBeTruthy();
  expect(screen.queryByText("Working")).toBeNull();
});

test("when the credentials can't be read, Credentials says so and Retry reads them again", async () => {
  let fail = true;
  serve(() => (fail ? reply(403, { error: "forbidden" }) : reply(200, { credentials: [] })));
  render(withQueries(<Credentials workspace={workspace} me={ME} tab="mine" />));
  expect((await screen.findByRole("alert")).textContent).toContain("Your role doesn't allow that.");
  fail = false;
  await userEvent.click(screen.getByRole("button", { name: "Retry" }));
  expect(await screen.findByText("You haven't added a credential yet.")).toBeTruthy();
});
