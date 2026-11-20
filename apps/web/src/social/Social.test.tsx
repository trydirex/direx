// SPDX-License-Identifier: AGPL-3.0-only
// Social loads through the query layer: a loading state first, then the accounts and networks, and
// an error panel with Retry when they can't be read.
import { defaultParseSearch } from "@tanstack/react-router";
import { afterEach, expect, test, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { api } from "../client";
import { legacyPath } from "../shell/legacy";
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

test("a failed connect says what the network answered and which setup step to check", async () => {
  serve(() => reply(200, { networks: [network] }));
  render(withQueries(<Social workspace={workspace} me={ME} notice="network_refused" noticeCode="redirect_uri_mismatch" />));
  const text = (await screen.findByText(/The network refused the connection/)).textContent;
  expect(text).toBe('The network refused the connection. Nothing was saved. The network answered "redirect_uri_mismatch". The callback URL in your app must match the one in the setup steps exactly, with no extra slash.');
});

test("a new refusal in the address on the same page replaces the hint shown", async () => {
  serve(() => reply(200, { networks: [network] }));
  const ui = (code: string) => <Social workspace={workspace} me={ME} notice="network_refused" noticeCode={code} />;
  const { rerender } = render(withQueries(ui("redirect_uri_mismatch")));
  expect((await screen.findByText(/The network refused the connection/)).textContent).toContain("callback URL");
  rerender(withQueries(ui("invalid_client")));
  expect((await screen.findByText(/The network refused the connection/)).textContent).toContain("client ID and secret");
});

test("a code the router would read as a number reaches Social as the string the API sent", () => {
  for (const code of ["190", "1e3", "1.50", "true", "redirect_uri_mismatch"]) {
    const path = legacyPath(`?page=social&connect_error=network_refused&connect_code=${code}`, W)!;
    expect(defaultParseSearch(new URL(path, "http://direx.test").search)).toEqual({ connect_error: "network_refused", connect_code: code });
  }
});

test.each(["check your client settings", "x".repeat(61)])("a malformed code from the address leaves only the refusal notice (%s)", async (code) => {
  serve(() => reply(200, { networks: [network] }));
  render(withQueries(<Social workspace={workspace} me={ME} notice="network_refused" noticeCode={code} />));
  expect((await screen.findByText(/The network refused the connection/)).textContent).toBe("The network refused the connection. Nothing was saved.");
});

test("legacy redirects leave numeric-looking values in other search keys unchanged", () => {
  expect(legacyPath("?page=rules&step=1", W)).toBe(`/w/${W}/settings/rules?step=1`);
});
