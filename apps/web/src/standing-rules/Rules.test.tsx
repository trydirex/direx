// SPDX-License-Identifier: AGPL-3.0-only
// Standing rules load through the query layer: a loading state first, then the rules, and an error
// panel with Retry when they can't be read.
import { afterEach, expect, test, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { api } from "../client";
import { withQueries } from "../testing";
import { GrantForm, Rules } from "./Rules";

const W = "00000000-0000-4000-8000-0000000000aa";
const C = "00000000-0000-4000-8000-000000000002";
const reply = (status: number, body: unknown) => Promise.resolve({ ...(status < 400 ? { data: body } : { error: body }), response: new Response(null, { status }) });
const rule = { id: "00000000-0000-4000-8000-000000000001", campaignId: C, stepKey: "first", mode: "template", writtenBy: null, templateRevision: 3, dailyCap: 40, expiresAt: "2027-01-27T00:00:00.000Z", grantedBy: "g", granterEmail: "sam@acme.test", grantedAt: "2026-10-30T00:00:00.000Z", status: "active", suspendedReason: null, stoppedByEmail: null, stopReason: null, usedToday: 12, total: 90 };

const campaign = { id: C, title: "Q4 launch", steps: [{ key: "first", title: "Opening email." }, { key: "second", title: "Follow-up." }] };
/** The rules, and the Campaign they belong to. */
const rulesAnd = (rules: unknown[]) => ((path: string) => (path === "/api/w/{workspaceId}/campaigns/{id}" ? reply(200, campaign) : reply(200, { rules }))) as never;
const NAME = "Q4 launch › Opening email";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

test("Standing rules show a loading state, then each rule linking to its Campaign", async () => {
  vi.spyOn(api, "GET").mockImplementation(rulesAnd([rule]));
  render(withQueries(<Rules workspaceId={W} role="owner" />));
  expect(screen.getAllByRole("status").some((s) => s.textContent === "Loading")).toBe(true);
  const link = await screen.findByRole("link", { name: NAME });
  expect(link.getAttribute("href")).toBe(`/w/${W}/campaigns/${C}`);
  expect(screen.getByRole("button", { name: `Stop ${NAME}` })).toBeTruthy();
  expect(screen.getByRole("region", { name: "Always asks you first" }).textContent).toContain("Any email no rule below covers");
});

test("a rule never shows its step key or template version, even while its Campaign loads", async () => {
  let open: (v: unknown) => void = () => {};
  vi.spyOn(api, "GET").mockImplementation(((path: string) => (path === "/api/w/{workspaceId}/campaigns/{id}" ? new Promise((done) => (open = done)) : reply(200, { rules: [rule] }))) as never);
  render(withQueries(<Rules workspaceId={W} role="owner" />));
  expect(await screen.findByRole("button", { name: "Stop this rule" })).toBeTruthy();
  expect(document.body.textContent).not.toMatch(/template version|Step first/);
  open(await reply(200, campaign));
  expect(await screen.findByRole("link", { name: NAME })).toBeTruthy();
});

test("a rule whose Campaign was deleted says so", async () => {
  vi.spyOn(api, "GET").mockImplementation(((path: string) => (path === "/api/w/{workspaceId}/campaigns/{id}" ? reply(404, { error: "not_found" }) : reply(200, { rules: [rule] }))) as never);
  render(withQueries(<Rules workspaceId={W} role="owner" />));
  expect(await screen.findByRole("link", { name: "A Campaign that was deleted" })).toBeTruthy();
});

test("signing in again opens over the page, which stays behind it", async () => {
  vi.spyOn(api, "GET").mockImplementation(rulesAnd([rule]));
  vi.spyOn(api, "POST").mockImplementation((() => reply(403, { error: "step_up_required" })) as never);
  render(withQueries(<Rules workspaceId={W} role="owner" />));
  await userEvent.click(await screen.findByRole("button", { name: `Stop ${NAME}` }));
  await userEvent.type(screen.getByLabelText("Why"), "Wrong list");
  await userEvent.click(screen.getByRole("button", { name: `Confirm stop: ${NAME}` }));
  expect(await screen.findByRole("heading", { name: "Confirm it's you" })).toBeTruthy();
  expect(screen.getByRole("link", { name: NAME, hidden: true })).toBeTruthy();
});

test("when the rules can't be read, the page says so and Retry reads them again", async () => {
  let fail = true;
  vi.spyOn(api, "GET").mockImplementation((() => (fail ? reply(403, { error: "forbidden" }) : reply(200, { rules: [] }))) as never);
  render(withQueries(<Rules workspaceId={W} role="marketer" />));
  expect((await screen.findByRole("alert")).textContent).toContain("Your role doesn't allow that.");
  fail = false;
  await userEvent.click(screen.getByRole("button", { name: "Retry" }));
  expect(await screen.findByText(/No auto-approve rules yet/)).toBeTruthy();
});

test("each rule's Stop button names its rule", async () => {
  vi.spyOn(api, "GET").mockImplementation(rulesAnd([rule, { ...rule, id: "00000000-0000-4000-8000-000000000003", stepKey: "second" }]));
  render(withQueries(<Rules workspaceId={W} role="owner" />));
  expect(await screen.findByRole("button", { name: `Stop ${NAME}` })).toBeTruthy();
  expect(screen.getByRole("button", { name: "Stop Q4 launch › Follow-up" })).toBeTruthy();
});

test("Stop asks why only once pressed, then Confirm stop sends the reason", async () => {
  vi.spyOn(api, "GET").mockImplementation(rulesAnd([rule]));
  const post = vi.spyOn(api, "POST").mockImplementation((() => reply(200, { ok: true })) as never);
  render(withQueries(<Rules workspaceId={W} role="marketer" />));
  await userEvent.click(await screen.findByRole("button", { name: `Stop ${NAME}` }));
  expect(screen.queryByRole("button", { name: `Stop ${NAME}` })).toBeNull();
  await userEvent.type(screen.getByLabelText("Why"), "Wrong list");
  await userEvent.click(screen.getByRole("button", { name: `Confirm stop: ${NAME}` }));
  await vi.waitFor(() => expect(post).toHaveBeenCalledTimes(1));
  expect(JSON.stringify(post.mock.calls[0])).toContain("Wrong list");
});

test("no Why field shows until Stop is pressed, and Cancel hides it again", async () => {
  vi.spyOn(api, "GET").mockImplementation(rulesAnd([rule]));
  render(withQueries(<Rules workspaceId={W} role="owner" />));
  await userEvent.click(await screen.findByRole("button", { name: `Stop ${NAME}` }));
  expect(screen.getByLabelText("Why")).toBeTruthy();
  await userEvent.click(screen.getByRole("button", { name: "Cancel" }));
  expect(screen.queryByLabelText("Why")).toBeNull();
});

test("a rule whose step was removed from its Campaign says so", async () => {
  vi.spyOn(api, "GET").mockImplementation(rulesAnd([{ ...rule, stepKey: "gone" }]));
  render(withQueries(<Rules workspaceId={W} role="owner" />));
  expect(await screen.findByRole("link", { name: "Q4 launch › A step that was removed" })).toBeTruthy();
});

test("the grant form names the step by its title once the Campaign is read", async () => {
  vi.spyOn(api, "GET").mockImplementation(((path: string) =>
    path === "/api/w/{workspaceId}/campaigns/{id}" ? reply(200, { id: C, title: "Q4 launch", steps: [{ key: "first", title: "Opening email." }] }) : reply(200, { people: 3, waiting: 1 })) as never);
  render(withQueries(<GrantForm workspaceId={W} scope={{ campaignId: C, stepKey: "first" }} onDone={() => {}} />));
  expect(await screen.findByText(/emails from this template in the step “Opening email” without asking/)).toBeTruthy();
});
