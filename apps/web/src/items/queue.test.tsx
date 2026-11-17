// SPDX-License-Identifier: AGPL-3.0-only
// Review and Home with notices and posts in the queue: the toast after a change, what a notice's body
// shows, the setup box beside the queue, and a network's name where its key would be.
import { afterEach, expect, test, vi } from "vitest";
import { StrictMode } from "react";
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { api } from "../client";
import { withQueries } from "../testing";
import type { Item } from "./actions";
import { Review } from "./Review";
import { Home } from "./Home";

const W = "00000000-0000-4000-8000-0000000000aa";
const C = "00000000-0000-4000-8000-0000000000cc";
const reply = (status: number, body: unknown) => Promise.resolve({ ...(status < 400 ? { data: body } : { error: body }), response: new Response(null, { status }) });
const item = (o: Partial<Item> = {}): Item => ({
  id: "i1",
  kind: "campaign_launch_moved",
  state: "needs_approval",
  reason: null,
  reasonCode: null,
  revision: 1,
  title: "Launch moved Tue 8 Dec to Tue 1 Dec",
  workArea: "outreach",
  channel: null,
  groupKey: null,
  groupLabel: null,
  at: null,
  warnings: [],
  clean: true,
  movable: false,
  decideBy: null,
  snoozedUntil: null,
  createdAt: new Date(2026, 10, 3).toISOString(),
  ...o,
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

function serve(o: { list: () => Item[]; content?: unknown; facts?: unknown[]; state?: () => Item["state"] }) {
  vi.spyOn(api, "GET").mockImplementation(((path: string, init: { params: { path: { id?: string } } }) => {
    const list = o.list();
    if (path === "/api/w/{workspaceId}/items") return reply(200, { items: list, needsYouCount: list.length });
    if (path === "/api/w/{workspaceId}/social/networks") return reply(200, { networks: [{ connection: "linkedin_page", label: "LinkedIn Page", publishes: false }] });
    if (path === "/api/w/{workspaceId}/facts" && o.facts) return reply(200, { facts: o.facts });
    if (path === "/api/w/{workspaceId}/items/{id}") {
      const i = list.find((x) => x.id === init.params.path.id) ?? item({ id: init.params.path.id });
      return reply(200, { item: { ...i, state: o.state?.() ?? i.state }, content: o.content ?? { campaignId: C, from: "2026-12-08", to: "2026-12-01" }, timeline: [], ruleGrantedBy: null });
    }
    return reply(404, { error: "not_found" });
  }) as never);
  return vi.spyOn(api, "POST").mockImplementation((() => reply(200, {})) as never);
}

test("dismissing the open notice says where it went once, from outside the render", async () => {
  let gone = false;
  const post = serve({ list: () => (gone ? [] : [item()]), state: () => (gone ? "cancelled" : "needs_approval") });
  post.mockImplementation((() => {
    gone = true;
    return reply(200, {});
  }) as never);
  const error = vi.spyOn(console, "error");
  render(<StrictMode>{withQueries(<Review workspaceId={W} role="marketer" />)}</StrictMode>);
  const panel = await screen.findByRole("article", { name: item().title });
  await userEvent.click(within(panel).getByRole("button", { name: "Dismiss" }));
  expect(await screen.findByText(`${item().title}: Dismissed`)).toBeTruthy();
  await screen.findByText("All caught up");
  expect(screen.getAllByText(`${item().title}: Dismissed`)).toHaveLength(1);
  expect(error.mock.calls.flat().join(" ")).not.toContain("Cannot update a component");
});

test("a notice whose content only points at records shows no JSON, and a launch move links to its Campaign", async () => {
  serve({ list: () => [item()] });
  render(withQueries(<Review workspaceId={W} role="owner" />));
  const panel = await screen.findByRole("article", { name: item().title });
  expect(within(panel).getByRole("link", { name: "Open the Campaign" }).getAttribute("href")).toBe(`/w/${W}/campaigns/${C}`);
  expect(panel.textContent).not.toContain("campaignId");
  cleanup();
  serve({ list: () => [item({ kind: "plan_version", title: 'Plan "Spring", version 1' })], content: { version: 1, targetId: C } });
  render(withQueries(<Review workspaceId={W} role="owner" />));
  expect((await screen.findByRole("article", { name: 'Plan "Spring", version 1' })).textContent).not.toContain("targetId");
});

test("Home shows the setup box and the waiting queue together, and a post row names its network", async () => {
  serve({ list: () => [item({ id: "p1", kind: "manual_post", workArea: "social", channel: "linkedin_page", title: "LinkedIn Page: Hello" })], facts: [] });
  render(withQueries(<Home workspaceId={W} role="owner" />));
  expect(await screen.findByText("Set up this Workspace")).toBeTruthy();
  const row = await screen.findByRole("link", { name: "Open LinkedIn Page: Hello" });
  await waitFor(() => expect(row.textContent).toContain("Post· LinkedIn Page"));
  expect(row.textContent).not.toContain("linkedin_page");
});
