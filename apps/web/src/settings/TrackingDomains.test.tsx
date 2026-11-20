// SPDX-License-Identifier: AGPL-3.0-only
// Tracking domains in Settings: only Owners and Admins see the controls; adding shows the records to set,
// a refusal says why, Check says what it found, and a domain in use can't be removed.
import { afterEach, expect, test, vi } from "vitest";
import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { api } from "../client";
import { withQueries } from "../testing";
import { TrackingDomains } from "./TrackingDomains";

const W = "00000000-0000-4000-8000-0000000000aa";
const D = "00000000-0000-4000-8000-0000000000d1";
const reply = (status: number, body: unknown) => Promise.resolve({ ...(status < 400 ? { data: body } : { error: body }), response: new Response(null, { status }) });
const domain = (state: string) => ({ id: D, hostname: "links.acme.example", state, cnameTarget: "track.direx.example", txtName: "_direx-tracking.links.acme.example", txtValue: "abcDEF123_-abcDEF123_-", checkedAt: null });

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

function serve(o: { state?: string; post?: (path: string) => ReturnType<typeof reply>; del?: () => ReturnType<typeof reply> } = {}) {
  const get = vi.spyOn(api, "GET").mockImplementation(((path: string) =>
    path === "/api/w/{workspaceId}/tracking/domains" ? reply(200, { domains: o.state ? [domain(o.state)] : [] }) : reply(404, { error: "not_found" })) as never);
  const post = vi.spyOn(api, "POST").mockImplementation(((path: string) => (o.post ? o.post(path) : reply(200, { ok: true }))) as never);
  const del = vi.spyOn(api, "DELETE").mockImplementation((() => (o.del ? o.del() : reply(200, { ok: true }))) as never);
  return { get, post, del };
}

test("a Marketer is told who manages tracking domains, and nothing is fetched", () => {
  const { get } = serve();
  render(withQueries(<TrackingDomains workspaceId={W} role="marketer" />));
  expect(screen.getByRole("heading", { level: 1, name: "Tracking domains" })).toBeTruthy();
  expect(screen.getByText("Only Owners and Admins manage tracking domains.")).toBeTruthy();
  expect(screen.queryByRole("button", { name: "Add" })).toBeNull();
  expect(get).not.toHaveBeenCalled();
});

test("an Admin adds a hostname, and a refusal says why", async () => {
  let code: string | undefined = "taken";
  const { post } = serve({ post: () => (code ? reply(409, { error: code }) : reply(201, { domain: domain("pending") })) });
  render(withQueries(<TrackingDomains workspaceId={W} role="admin" />));
  expect(await screen.findByText("None yet.")).toBeTruthy();
  await userEvent.type(screen.getByLabelText(/Hostname/), "links.acme.example");
  await userEvent.click(screen.getByRole("button", { name: "Add" }));
  expect(post).toHaveBeenCalledWith("/api/w/{workspaceId}/tracking/domains", { params: { path: { workspaceId: W } }, body: { hostname: "links.acme.example" } });
  expect(await screen.findByText("This hostname is already in use on this server.")).toBeTruthy();
  code = undefined;
  await userEvent.click(screen.getByRole("button", { name: "Add" }));
  await vi.waitFor(() => expect(screen.queryByText("This hostname is already in use on this server.")).toBeNull());
});

test("a pending domain shows its two records; Check says what it found", async () => {
  serve({ state: "pending", post: (path) => (path.endsWith("/check") ? reply(200, { result: "dns_mismatch" }) : reply(200, { ok: true })) });
  render(withQueries(<TrackingDomains workspaceId={W} role="owner" />));
  const item = within((await screen.findByText("links.acme.example", { selector: "span" })).closest("li")!);
  expect(item.getByText("Waiting for DNS")).toBeTruthy();
  expect(item.getByText("track.direx.example")).toBeTruthy();
  expect(item.getByText("_direx-tracking.links.acme.example")).toBeTruthy();
  expect(item.getByText("abcDEF123_-abcDEF123_-")).toBeTruthy();
  await userEvent.click(item.getByRole("button", { name: "Check" }));
  expect(await screen.findByText("The records don't match yet. DNS changes can take up to an hour.")).toBeTruthy();
});

test("Stop posts, a stopped domain offers only Remove, and one in use can't be removed", async () => {
  const { post } = serve({ state: "verified", del: () => reply(409, { error: "in_use" }) });
  render(withQueries(<TrackingDomains workspaceId={W} role="admin" />));
  const item = within((await screen.findByText("links.acme.example", { selector: "span" })).closest("li")!);
  expect(item.getByText("Ready")).toBeTruthy();
  await userEvent.click(item.getByRole("button", { name: "Stop" }));
  expect(post).toHaveBeenCalledWith("/api/w/{workspaceId}/tracking/domains/{id}/stop", { params: { path: { workspaceId: W, id: D } } });
  await userEvent.click(item.getByRole("button", { name: "Remove" }));
  expect(await screen.findByText("Links or a Campaign use this domain, so it can't be removed. Stop it instead.")).toBeTruthy();
  cleanup();

  serve({ state: "stopped" });
  render(withQueries(<TrackingDomains workspaceId={W} role="admin" />));
  const stopped = within((await screen.findByText("links.acme.example", { selector: "span" })).closest("li")!);
  expect(stopped.getByText("Stopped: no new links")).toBeTruthy();
  expect(stopped.queryByRole("button", { name: "Check" })).toBeNull();
  expect(stopped.queryByText("track.direx.example")).toBeNull();
  expect(stopped.getByRole("button", { name: "Remove" })).toBeTruthy();
});
