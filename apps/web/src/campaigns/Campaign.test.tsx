// SPDX-License-Identifier: AGPL-3.0-only
// A Campaign loads through the query layer: a loading state, then the campaign, an error panel with
// Retry, and the main actions on each tab calling their endpoints.
import { afterEach, expect, test, vi } from "vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { api } from "../client";
import { choose, listFor, pick, withQueries } from "../testing";
import { campaignsQuery, dayWords, type Loaded } from "./actions";
import { useQuery } from "@tanstack/react-query";
import { Campaign, tabFor } from "./Campaign";
import { campaignStatus, resultTiles } from "./Overview";

const W = "00000000-0000-4000-8000-0000000000aa";
const ID = "00000000-0000-4000-8000-0000000000bb";
const reply = (status: number, body: unknown) => Promise.resolve({ ...(status < 400 ? { data: body } : { error: body }), response: new Response(null, { status }) });
const step = { key: "first", on: "2026-11-03", title: "First email", inPlan: true, type: "email", touchClass: "cold", mailboxCredentialId: null, audience: "everyone", dmChannel: null, templateRevision: 0, template: null, dependsOnStepKey: null, outputConnection: null, outputNetworkId: null, utm: false, waitingOn: null, output: null, draftingMode: null, cancelled: false, waived: false, planChange: null };
/** A day `n` days from today, as the API sends days, so a running campaign stays running. */
const inDays = (n: number) => new Date(Date.now() + n * 86_400_000).toLocaleDateString("en-CA");
const campaign = { id: ID, planId: "p", title: "Q4 push", ownerUserId: "u", draftingMode: null, paused: false, status: "running", changesWaiting: false, createdBy: null, outsideContentAllowed: false, advance: "offer", advanceSetBy: null, advanceUpToCents: 0, notes: "", notesRevision: 0, notesUpdatedBy: null, notesUpdatedAt: null, goal: "4 meetings", startsOn: inDays(-10), anchor: { on: "2026-11-01", stepKey: null }, endsOn: inDays(20), planned: 1, done: 0, skipped: 0, sent: 3, replied: 1, steps: [step] } as unknown as Loaded;
const person = { personId: "00000000-0000-4000-8000-000000000001", status: "active", firstName: "Kim", company: "Acme", website: null, email: "kim@acme.test", blocked: null, country: "US", warnings: [], lastEmailAt: null, conflict: null };

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

/** The campaign answers from `read`; its people, progress, Mailboxes and hook answer plainly. */
function serve(read: () => Promise<unknown> = () => reply(200, campaign), people: (cursor?: string) => unknown = () => ({ people: [person], next: null })) {
  vi.spyOn(api, "GET").mockImplementation(((path: string, o?: { params?: { query?: { cursor?: string } } }) => {
    if (path === "/api/w/{workspaceId}/campaigns/{id}") return read();
    if (path === "/api/w/{workspaceId}/campaigns/{id}/people") return reply(200, people(o?.params?.query?.cursor));
    if (path === "/api/w/{workspaceId}/items/{id}") return reply(200, { item: { id: "i1", revision: 3 } });
    if (path === "/api/w/{workspaceId}/campaigns/{id}/progress") return reply(200, { steps: [{ stepKey: "first", title: "First", mode: "template", written: 5, toWrite: 0, readyOn: null, waiting: [] }], counts: [] });
    if (path === "/api/w/{workspaceId}/campaigns/{id}/drafting-preview") return reply(200, { mode: "template", people: 2, runs: 0, worstCaseCents: 0, days: 0, leftOut: [] });
    if (path === "/api/w/{workspaceId}/credentials") return reply(200, { credentials: [{ id: "b", name: "sam@acme.test", connection: "google" }] });
    if (path === "/api/w/{workspaceId}/mailbox-providers") return reply(200, { providers: [{ connection: "google" }] });
    if (path === "/api/w/{workspaceId}/outreach/hold-hook") return reply(200, { hook: null });
    return reply(404, { error: "not_found" });
  }) as never);
  const post = vi.spyOn(api, "POST").mockImplementation(((path: string) => (path.endsWith("/drafting-confirm") ? reply(200, { mode: "template", made: 2 }) : reply(200, { results: [{ row: 2, ok: true, missing: [] }] }))) as never);
  const put = vi.spyOn(api, "PUT").mockImplementation(((_: string, o: { body: { preview?: boolean } }) => reply(200, o.body.preview ? { moved: 3, kept: 0, backToApproval: 1 } : {})) as never);
  return { post, put };
}
const at = { params: { path: { workspaceId: W, id: ID } } };

test("a Campaign shows a loading state, then its title and tabs; Results is gone, its numbers live on Overview", async () => {
  serve(() => reply(200, { ...campaign, sent: 0 }));
  render(withQueries(<Campaign workspaceId={W} id={ID} role="viewer" tab="people" />));
  expect(screen.getAllByRole("status").some((s) => s.textContent === "Loading")).toBe(true);
  expect(await screen.findByRole("heading", { name: "Q4 push" })).toBeTruthy();
  expect(screen.getByRole("link", { name: "People" }).getAttribute("aria-current")).toBe("page");
  expect(screen.queryByRole("link", { name: "Results" })).toBeNull();
  // An old link to the Results tab opens Overview.
  expect(tabFor("results", { status: "running" })).toBe("overview");
  expect(screen.getByRole("link", { name: "Content" }).getAttribute("href")).toBe(`/w/${W}/campaigns/${ID}?tab=drafts`);
  expect(screen.getByRole("link", { name: "Campaigns" }).getAttribute("href")).toBe(`/w/${W}/campaigns`);
  expect((await screen.findByRole("link", { name: "Connect your CRM" })).getAttribute("href")).toBe(`/w/${W}/settings/sending#hold-hook`);
});

test("when the campaign can't be read, it says so and Retry reads it again", async () => {
  let fail = true;
  serve(() => (fail ? reply(403, { error: "forbidden" }) : reply(200, campaign)));
  render(withQueries(<Campaign workspaceId={W} id={ID} role="viewer" tab="people" />));
  expect((await screen.findByRole("alert")).textContent).toContain("Your role doesn't allow that.");
  fail = false;
  await userEvent.click(screen.getByRole("button", { name: "Retry" }));
  expect(await screen.findByRole("heading", { name: "Q4 push" })).toBeTruthy();
});

test("an approver pauses the campaign, and a refusal is shown", async () => {
  const { post } = serve();
  render(withQueries(<Campaign workspaceId={W} id={ID} role="owner" tab="people" />));
  await pick(await screen.findByRole("button", { name: "More actions" }), "Pause this campaign", "menuitem");
  expect(post).toHaveBeenCalledWith("/api/w/{workspaceId}/campaigns/{id}/pause", at);
  post.mockImplementation((() => reply(409, { error: "stale" })) as never);
  await pick(screen.getByRole("button", { name: "More actions" }), "Pause this campaign", "menuitem");
  expect((await screen.findByRole("alert")).textContent).toContain("Someone else changed this just now.");
  cleanup();
  render(withQueries(<Campaign workspaceId={W} id={ID} role="viewer" tab="people" />));
  await userEvent.click(await screen.findByRole("button", { name: "More actions" }));
  expect(await listFor(screen.getByRole("button", { name: "More actions" })).findByRole("menuitem", { name: "Campaign settings" })).toBeTruthy();
  expect(screen.queryByRole("menuitem", { name: "Pause this campaign" })).toBeNull();
});

test("an editor previews moving the launch, then moves it", async () => {
  const { put } = serve();
  render(withQueries(<Campaign workspaceId={W} id={ID} role="owner" tab="drafts" />));
  // The launch is one line in the header; its form opens in a drawer.
  expect(await screen.findByText(/^Launched Sun 1 Nov/)).toBeTruthy();
  expect(screen.queryByRole("region", { name: "Launch" })).toBeNull();
  await userEvent.click(screen.getByRole("button", { name: "Move dates" }));
  const launch = within(await screen.findByRole("region", { name: "Launch" }));
  await userEvent.click(launch.getByRole("button", { name: "Preview" }));
  expect(put).toHaveBeenCalledWith("/api/w/{workspaceId}/campaigns/{id}/anchor", { ...at, body: { on: "2026-11-01", preview: true } });
  expect(await launch.findByText(/3 not yet sent move to follow it\. 1 approved needs approving again/)).toBeTruthy();
  await userEvent.click(launch.getByRole("button", { name: "Move the launch" }));
  expect(put).toHaveBeenLastCalledWith("/api/w/{workspaceId}/campaigns/{id}/anchor", { ...at, body: { on: "2026-11-01", preview: false } });
});

test("an editor changes a step, picks its Mailbox and saves it; the Content tab shows its progress", async () => {
  const { put } = serve();
  render(withQueries(<Campaign workspaceId={W} id={ID} role="owner" tab="drafts" />));
  expect(await screen.findByText(/· 5 of 5 written$/)).toBeTruthy();
  expect(screen.getByRole("button", { name: /First email/ }).getAttribute("aria-current")).toBe("true");
  expect(screen.queryByRole("combobox", { name: "Email account" })).toBeNull();
  await userEvent.click(screen.getByRole("button", { name: "Step settings" }));
  await choose("Email account", "sam@acme.test");
  await choose("Who can receive this", "Subscribers who opted in");
  await userEvent.click(screen.getByRole("button", { name: "Save step" }));
  expect(put).toHaveBeenCalledWith("/api/w/{workspaceId}/campaigns/{id}/steps/{key}", {
    params: { path: { workspaceId: W, id: ID, key: "first" } },
    body: { type: "email", touchClass: "consented_marketing", mailboxCredentialId: "b", audience: "everyone", dmChannel: null, dependsOnStepKey: null, utm: false },
  });
  expect(await screen.findByText("Saved First email.")).toBeTruthy();
  // A saved step closes its drawer, so the page's own fields can be reached again.
  await vi.waitFor(() => expect(screen.queryByRole("button", { name: "Save step" })).toBeNull());
  await userEvent.click(screen.getByRole("button", { name: "Step settings" }));
  // "Written as" saves with the rest of the step: choosing it writes nothing until Save step.
  const calls = put.mock.calls.length;
  await choose(/Written as/, "Personalised for each person from their website (uses AI)");
  expect(put.mock.calls.length).toBe(calls);
  await userEvent.click(screen.getByRole("button", { name: "Save step" }));
  await vi.waitFor(() =>
    expect(put).toHaveBeenLastCalledWith("/api/w/{workspaceId}/campaigns/{id}/steps/{key}/drafting-mode", { params: { path: { workspaceId: W, id: ID, key: "first" } }, body: { mode: "per_person" } }),
  );
});

test("once a step has writing, Written as isn't offered, and a refused save shows in the drawer and keeps it open", async () => {
  const { put } = serve(() => reply(200, { ...campaign, steps: [{ ...step, draftingMode: "template", template: { subject: "Hi", text: "Hello", warnings: [], citations: [], needsDecision: [] } }] }));
  put.mockImplementation((() => reply(409, { error: "mailbox_not_ready" })) as never);
  render(withQueries(<Campaign workspaceId={W} id={ID} role="owner" tab="drafts" />));
  await userEvent.click(await screen.findByRole("button", { name: "Step settings" }));
  const drawer = within(await screen.findByRole("dialog"));
  expect(drawer.queryByRole("combobox", { name: /Written as/ })).toBeNull();
  expect(drawer.getByText(/Written as: the same email for everyone\. This step already has writing in it/)).toBeTruthy();
  await userEvent.click(drawer.getByRole("button", { name: "Save step" }));
  expect(await drawer.findByRole("alert")).toBeTruthy();
  expect(screen.getByRole("button", { name: "Save step" })).toBeTruthy();
});

test("Plan and Content take the full width, without the list of campaigns beside them", async () => {
  serve();
  for (const tab of ["drafts", "plan"]) {
    render(withQueries(<Campaign workspaceId={W} id={ID} role="owner" tab={tab} />));
    await screen.findByRole("navigation", { name: "Campaign" });
    expect(screen.queryByRole("navigation", { name: "All campaigns" })).toBeNull();
    cleanup();
  }
});

test("an editor adds people from a CSV, then starts their drafts", async () => {
  const { post } = serve();
  render(withQueries(<Campaign workspaceId={W} id={ID} role="owner" tab="people" />));
  const del = vi.spyOn(api, "DELETE").mockImplementation((() => reply(200, {})) as never);
  await pick(await screen.findByRole("button", { name: "Actions for kim@acme.test" }), "Remove from this campaign", "menuitem");
  expect(del).toHaveBeenCalledWith("/api/w/{workspaceId}/campaigns/{id}/people/{personId}", { params: { path: { workspaceId: W, id: ID, personId: person.personId } } });
  await userEvent.type(screen.getByLabelText(/Paste a CSV/), "email{enter}lee@acme.test");
  await userEvent.click(screen.getByRole("button", { name: "Add people" }));
  expect(post).toHaveBeenCalledWith("/api/w/{workspaceId}/campaigns/{id}/people", { ...at, body: { csv: "email\nlee@acme.test" } });
  expect(await screen.findByText("Row 2: added.")).toBeTruthy();
  await userEvent.click(await screen.findByRole("button", { name: "Write the drafts" }));
  expect(post).toHaveBeenLastCalledWith("/api/w/{workspaceId}/campaigns/{id}/drafting-confirm", { ...at, body: { timeZone: expect.any(String) } });
  expect(await screen.findByText("Made 2 drafts. They wait on Home.")).toBeTruthy();
});

test("an editor imports a list, matching its columns, with one reason for everyone on it; or adds one person", async () => {
  const { post } = serve();
  render(withQueries(<Campaign workspaceId={W} id={ID} role="owner" tab="people" />));
  await userEvent.click(await screen.findByRole("button", { name: "Import a list" }));
  const file = new File(["Work email,Name,Country\nlee@acme.test,Lee,Germany\n"], "fair.csv", { type: "text/csv" });
  await userEvent.upload(screen.getByLabelText(/A CSV file/, { selector: "input" }), file);
  expect(await screen.findByText("1 row. Match your columns:")).toBeTruthy();
  await choose("Why you may contact them", "Legitimate interest");
  await userEvent.click(screen.getByRole("button", { name: "Import 1 person" }));
  expect(post).toHaveBeenCalledWith("/api/w/{workspaceId}/campaigns/{id}/people", { ...at, body: { csv: "email,first_name,country,basis,evidence\nlee@acme.test,Lee,DE,legitimate_interest,From fair.csv" } });
  expect(await screen.findByText("Row 2: added.")).toBeTruthy();

  await userEvent.click(screen.getByRole("button", { name: "Add one person" }));
  await userEvent.type(screen.getByLabelText("Email"), "max@acme.test");
  await userEvent.type(screen.getByLabelText("Company"), "Acme, Inc");
  await userEvent.click(screen.getByRole("button", { name: "Add to this campaign" }));
  expect(post).toHaveBeenCalledWith("/api/w/{workspaceId}/campaigns/{id}/people", { ...at, body: { csv: 'email,first_name,company,website,country\nmax@acme.test,,"Acme, Inc",,' } });
});

const page = { ...step, key: "page", title: "Launch page", type: "manual", touchClass: null };
const linked = { ...campaign, outsideContentAllowed: false, steps: [page, { ...step, dependsOnStepKey: "page", waitingOn: "page", draftingMode: "per_person" }] } as unknown as Loaded;

test("an editor links steps: saves a link, turns an email into a DM, ties the launch to the link and sets how drafts start", async () => {
  const { post, put } = serve(() => reply(200, linked));
  render(withQueries(<Campaign workspaceId={W} id={ID} role="owner" tab="drafts" />));
  await userEvent.type(await screen.findByLabelText(/Link for Launch page/), "https://acme.test/l");
  await userEvent.click(screen.getByRole("button", { name: "Save link" }));
  expect(post).toHaveBeenCalledWith("/api/w/{workspaceId}/campaigns/{id}/steps/{key}/output", { params: { path: { workspaceId: W, id: ID, key: "page" } }, body: { url: "https://acme.test/l" } });

  await userEvent.click(screen.getByRole("button", { name: /First email/ }));
  expect(screen.getByRole("button", { name: /First email/ }).getAttribute("aria-current")).toBe("true");
  await userEvent.click(screen.getByRole("button", { name: "Step settings" }));
  await choose("Goes to", "People who haven't replied yet");
  await userEvent.click(screen.getByLabelText(/Add tracking tags/));
  await pick(screen.getByRole("combobox", { name: "Goes out after" }), "No other step");
  await pick(screen.getByRole("combobox", { name: "Type" }), "DM you send yourself");
  await choose("On", "X");
  await userEvent.click(screen.getByRole("button", { name: "Save step" }));
  expect(put).toHaveBeenCalledWith("/api/w/{workspaceId}/campaigns/{id}/steps/{key}", {
    params: { path: { workspaceId: W, id: ID, key: "first" } },
    body: { type: "dm", touchClass: "cold", mailboxCredentialId: null, audience: "no_reply_yet", dmChannel: "x", dependsOnStepKey: null, utm: true },
  });

  await userEvent.keyboard("{Escape}");
  await userEvent.click(await screen.findByRole("button", { name: "Move dates" }));
  fireEvent.change(await screen.findByLabelText("Move the launch to"), { target: { value: "2026-12-01" } });
  await userEvent.click(screen.getByRole("button", { name: "Preview" }));
  expect(put).toHaveBeenLastCalledWith("/api/w/{workspaceId}/campaigns/{id}/anchor", { ...at, body: { on: "2026-12-01", preview: true } });
  await choose(/Launch when/, "Launch page goes live");
  expect(put).toHaveBeenLastCalledWith("/api/w/{workspaceId}/campaigns/{id}/anchor", { ...at, body: { stepKey: "page" } });

  await userEvent.keyboard("{Escape}");
  await pick(await screen.findByRole("button", { name: "More actions" }), "Campaign settings", "menuitem");
  await userEvent.click(await screen.findByLabelText(/Start next steps on their own/));
  expect(post).toHaveBeenLastCalledWith("/api/w/{workspaceId}/campaigns/{id}/advance", { ...at, body: { advance: "run", timeZone: expect.any(String) } });
  await userEvent.click(screen.getByLabelText(/may go out under auto-approve/));
  expect(post).toHaveBeenLastCalledWith("/api/w/{workspaceId}/campaigns/{id}/outside-content", { ...at, body: { allowed: true } });
});

test("a step the plan changed is kept by approving its Item with the choice", async () => {
  const held = { ...campaign, steps: [{ ...step, planChange: { kinds: ["channel"], suggestedTemplate: null, itemId: "i1" } }] } as unknown as Loaded;
  const { post } = serve(() => reply(200, held));
  render(withQueries(<Campaign workspaceId={W} id={ID} role="owner" tab="drafts" />));
  await userEvent.click(await screen.findByRole("button", { name: "Keep the step as it is" }));
  expect(post).toHaveBeenCalledWith("/api/w/{workspaceId}/items/{id}/approve", { params: { path: { workspaceId: W, id: "i1" } }, body: { revision: 3, choice: "keep" } });
});

test("a post step the plan changed, or cancelled, speaks of its posts, not emails", async () => {
  const post = { ...step, type: "post", touchClass: null, title: "Launch post" };
  serve(() => reply(200, { ...campaign, steps: [{ ...post, planChange: { kinds: ["channel"], suggestedTemplate: null, itemId: "i1" } }] } as unknown as Loaded));
  render(withQueries(<Campaign workspaceId={W} id={ID} role="owner" tab="drafts" />));
  expect(await screen.findByText("The plan changed this step. Its posts wait until you choose.")).toBeTruthy();
  cleanup();
  serve(() => reply(200, { ...campaign, steps: [{ ...post, cancelled: true }] } as unknown as Loaded));
  render(withQueries(<Campaign workspaceId={W} id={ID} role="owner" tab="drafts" />));
  expect(await screen.findByText("Cancelled. Its unsent posts were cancelled too.")).toBeTruthy();
});

test("someone in another campaign is skipped, more people show on request, and drafting can wait", async () => {
  const other = { ...person, personId: "00000000-0000-4000-8000-000000000002", email: "lee@acme.test", conflict: { itemId: "c1", revision: 2 } };
  const { post } = serve(undefined, (cursor) => (cursor ? { people: [{ ...person, personId: "00000000-0000-4000-8000-000000000003", email: "max@acme.test" }], next: null } : { people: [other], next: "c2" }));
  render(withQueries(<Campaign workspaceId={W} id={ID} role="owner" tab="people" />));
  await userEvent.click(await screen.findByRole("button", { name: "Skip lee@acme.test" }));
  expect(post).toHaveBeenCalledWith("/api/w/{workspaceId}/items/{id}/approve", { params: { path: { workspaceId: W, id: "c1" } }, body: { revision: 2, choice: "skip" } });
  await userEvent.click(await screen.findByRole("button", { name: "Show more" }));
  expect(await screen.findByRole("button", { name: "Actions for max@acme.test" })).toBeTruthy();
  await userEvent.type(screen.getByLabelText(/Paste a CSV/), "email");
  await userEvent.click(screen.getByRole("button", { name: "Add people" }));
  await userEvent.click(await screen.findByRole("button", { name: "Not now" }));
  expect(screen.queryByRole("button", { name: "Write the drafts" })).toBeNull();
});

test("Drafts shows each step's drafts written, and every campaign beside it with this one marked", async () => {
  serve();
  const listed = { ...campaign, needApproval: 2, channels: ["email"] };
  const read = vi.mocked(api.GET).getMockImplementation() as unknown as (path: string, o: unknown) => unknown;
  vi.mocked(api.GET).mockImplementation(((path: string, o: unknown) => (path === "/api/w/{workspaceId}/campaigns" ? reply(200, { campaigns: [listed, { ...listed, id: "c2", title: "Newsletter", needApproval: 0, paused: true, status: "paused", channels: [] }] }) : path.endsWith("/activity") ? reply(200, { events: [{ at: new Date(Date.now() - 120_000).toISOString(), text: "Drafted First email for 14 people", by: "direx" }, { at: "2026-11-01T09:00:00Z", text: "Created the campaign from its plan", by: "person" }] }) : read(path, o))) as never);
  render(withQueries(<Campaign workspaceId={W} id={ID} role="viewer" tab="drafts" />));
  await screen.findByRole("heading", { name: "Q4 push" });
  // The list beside it says each status too, so look past the nav.
  expect(screen.getAllByText("Running").some((e) => !e.closest("nav"))).toBe(true);
  expect((await screen.findByRole("progressbar", { name: "First email: drafts written" })).getAttribute("aria-valuenow")).toBe("5");
  const did = await screen.findByRole("complementary", { name: "What Direx did" });
  const lines = within(did).getAllByRole("listitem").map((l) => l.textContent);
  expect(lines[0]).toMatch(/^Drafted First email for 14 people.*2 minutes ago$/);
  expect(lines[1]).toMatch(/^Created the campaign from its plan.* · by a person$/);
  // Content is an editor and takes the full width (D2); the list of campaigns shows beside the other tabs, keeping the tab.
  expect(screen.queryByRole("navigation", { name: "All campaigns" })).toBeNull();
  cleanup();
  render(withQueries(<Campaign workspaceId={W} id={ID} role="viewer" tab="people" />));
  const all = await screen.findByRole("navigation", { name: "All campaigns" });
  const rows = within(all).getAllByRole("link");
  expect(rows.map((r) => r.textContent)).toEqual([expect.stringMatching(/^Q4 pushRunning.* to .* · 2 need approval$/), expect.stringMatching(/^NewsletterPaused.* to [^·]*$/)]);
  expect(within(rows[0]!).getByRole("img", { name: "Email" })).toBeTruthy();
  expect(rows[0]!.getAttribute("aria-current")).toBe("page");
  expect(rows[1]!.getAttribute("href")).toBe(`/w/${W}/campaigns/c2?tab=people`);
});

test("the latest launch move undoes from What Direx did: what moving back does first, then the move; a viewer has no Undo", async () => {
  const { put } = serve();
  const read = vi.mocked(api.GET).getMockImplementation() as unknown as (path: string, o: unknown) => unknown;
  const moved = { at: new Date().toISOString(), text: "The launch moved to Fri 6 Nov", by: "direx", undo: { kind: "launch", on: "2026-11-05" } };
  vi.mocked(api.GET).mockImplementation(((path: string, o: unknown) => (path.endsWith("/activity") ? reply(200, { events: [moved] }) : read(path, o))) as never);
  render(withQueries(<Campaign workspaceId={W} id={ID} role="owner" tab="drafts" />));
  await userEvent.click(await screen.findByRole("button", { name: "Undo: move the launch back to Thu 5 Nov" }));
  expect(put).toHaveBeenLastCalledWith("/api/w/{workspaceId}/campaigns/{id}/anchor", expect.objectContaining({ body: { on: "2026-11-05", preview: true } }));
  expect(await screen.findByText(/^Back to Thu 5 Nov\. 3 not yet sent move with it\. 1 approved needs approving again/)).toBeTruthy();
  await userEvent.click(screen.getByRole("button", { name: "Move it back" }));
  expect(put).toHaveBeenLastCalledWith("/api/w/{workspaceId}/campaigns/{id}/anchor", expect.objectContaining({ body: { on: "2026-11-05", preview: false } }));
  cleanup();
  render(withQueries(<Campaign workspaceId={W} id={ID} role="viewer" tab="drafts" />));
  await screen.findByText("The launch moved to Fri 6 Nov");
  expect(screen.queryByRole("button", { name: /^Undo/ })).toBeNull();
});

const tracking = {
  planned: 1, done: 0, skipped: 0,
  steps: [{ key: "first", on: "2026-11-03", title: "First email", status: "done" }],
  measures: [
    { key: "signups", label: "signups", target: "200", basis: { kind: "assumption" }, latest: { value: "142", observedOn: "2026-11-10", source: "person" } },
    { key: "meetings", label: "meetings", target: "4", basis: { kind: "assumption" }, latest: null },
  ],
};
/** Serves the campaign, its plan's tracking, the list with 2 needing approval and a log of seven lines. */
function serveOverview(c: unknown = campaign) {
  serve(() => reply(200, c));
  const read = vi.mocked(api.GET).getMockImplementation() as unknown as (path: string, o: unknown) => unknown;
  const events = Array.from({ length: 7 }, (_, n) => ({ at: "2026-11-01T09:00:00Z", text: `Line ${n + 1}`, by: "direx", undo: null }));
  vi.mocked(api.GET).mockImplementation(((path: string, o: unknown) =>
    path === "/api/w/{workspaceId}/plans/{id}"
      ? reply(200, { id: "p", title: "Q4", request: null, currentVersion: 1, archived: false, draftRevision: 0, strategyVersion: null, missing: [], waiting: null, notes: [], tracking })
      : path === "/api/w/{workspaceId}/campaigns"
        ? reply(200, { campaigns: [{ ...campaign, needApproval: 2, channels: [] }] })
        : path.endsWith("/activity")
          ? reply(200, { events })
          : path.endsWith("/results")
            ? reply(200, results)
            : read(path, o)) as never);
}
// Sends on three channels and what came back on email. No opens or clicks: Direx doesn't record them.
const results = { sent: [{ kind: "email", channel: "email", n: 3 }, { kind: "post", channel: "linkedin", n: 2 }, { kind: "dm", channel: "x", n: 1 }], email: { replied: 1, bounced: 0, optedOut: 2 }, measures: [] };

test("a Campaign opens on its Overview: status, numbers, measures against target, steps by date and the latest of what Direx did", async () => {
  const later = { ...step, key: "second", on: "2026-11-20", title: "Follow-up", type: "dm", dmChannel: "x", touchClass: null };
  serveOverview({ ...campaign, steps: [later, step] });
  render(withQueries(<Campaign workspaceId={W} id={ID} role="viewer" />));
  await screen.findByRole("heading", { name: "Q4 push" });
  expect(screen.getByRole("link", { name: "Overview" }).getAttribute("aria-current")).toBe("page");
  expect(screen.getByRole("link", { name: "Overview" }).getAttribute("href")).toBe(`/w/${W}/campaigns/${ID}?tab=overview`);
  expect(screen.getAllByText("Running").some((e) => !e.closest("nav"))).toBe(true);
  await screen.findByText("Emails sent");
  const numbers = [...screen.getAllByRole("definition")].map((d) => `${d.previousElementSibling?.textContent ?? d.nextElementSibling?.textContent}: ${d.textContent}`);
  expect(numbers).toEqual(["Emails sent: 3", "LinkedIn posts: 2", "X DMs sent: 1", "Replied: 1", "Bounced: 0", "Opted out by reply: 2", "Steps done: 0 of 1"]);
  expect(await screen.findByText("signups (71%)")).toBeTruthy();
  expect(screen.getByText("142").textContent).toBe("142 / 200");
  expect(screen.getByRole("progressbar", { name: "signups against its target" }).getAttribute("aria-valuenow")).toBe("142");
  expect(screen.getByText("No reading yet")).toBeTruthy();
  const timeline = within(screen.getByRole("list", { name: "Steps by date" })).getAllByRole("listitem").map((l) => l.textContent);
  expect(timeline).toEqual(["Tue 3 NovFirst email · emailDone", "Fri 20 NovXFollow-up · X DM you send yourselfNot drafted yet"]);
  expect((await screen.findByRole("link", { name: "Review 2 drafts" })).getAttribute("href")).toBe(`/w/${W}/campaigns/${ID}?tab=drafts`);
  const did = await screen.findByRole("complementary", { name: "What Direx did" });
  expect(within(did).getAllByRole("listitem")).toHaveLength(5);
  expect(within(did).getByRole("link", { name: "See all on Content" }).getAttribute("href")).toBe(`/w/${W}/campaigns/${ID}?tab=drafts`);
});

const item = (o: Record<string, unknown>) => ({ id: "i", kind: "action", state: "needs_approval", reason: null, reasonCode: null, revision: 1, title: "Hi Kim", workArea: "outreach", channel: "email", groupKey: `campaign:${ID}:step:first`, groupLabel: "First email", at: inDays(1), warnings: [], clean: true, movable: true, decideBy: null, snoozedUntil: null, createdAt: "2026-11-01T09:00:00Z", ...o });
/** The Overview served with Items: `waiting` on Needs you, and each step's Items by state as the progress counts them. */
function serveItems(c: unknown, waiting: unknown[], counts: unknown[], listed?: unknown[]) {
  serveOverview(c);
  const read = vi.mocked(api.GET).getMockImplementation() as unknown as (path: string, o: unknown) => unknown;
  vi.mocked(api.GET).mockImplementation(((path: string, o: { params?: { query?: { needsYou?: string } } }) =>
    path === "/api/w/{workspaceId}/items"
      ? reply(200, o?.params?.query?.needsYou ? { items: waiting, needsYouCount: waiting.length, nextCursor: null } : { items: [], needsYouCount: 0, nextCursor: null })
      : path === "/api/w/{workspaceId}/campaigns/{id}/progress"
        ? reply(200, { steps: [], counts })
      : path === "/api/w/{workspaceId}/campaigns" && listed
        ? reply(200, { campaigns: listed })
        : path === "/api/w/{workspaceId}/campaign-launches"
        ? reply(200, { launches: [] })
        : read(path, o)) as never);
}

test("Needs you lists what waits in this Campaign by step and approves the clean ones here; each step shows its drafts by state", async () => {
  const waiting = [item({ id: "a1" }), item({ id: "a2", revision: 2 }), item({ id: "h1", state: "held", reason: "not sure it sent", clean: false })];
  // Counted by the server, undated Items too.
  const counts = [{ stepKey: "first", state: "sent", n: 3 }, { stepKey: "first", state: "needs_approval", n: 2 }, { stepKey: "gone", state: "sent", n: 9 }];
  serveItems(campaign, waiting, counts);
  const post = vi.mocked(api.POST);
  render(withQueries(<Campaign workspaceId={W} id={ID} role="owner" />));
  const needs = within(await screen.findByRole("region", { name: "Needs you" }));
  expect(needs.getByText("2 waiting, such as \"Hi Kim\"")).toBeTruthy();
  expect(needs.getByText("Held: not sure it sent")).toBeTruthy();
  expect(needs.getAllByRole("button", { name: "Open Hi Kim" })).toHaveLength(2);
  expect(await screen.findByText("3 Sent · 2 Needs approval")).toBeTruthy();
  await userEvent.click(needs.getByRole("button", { name: "Approve 2" }));
  expect(await screen.findByText("Each goes out at its planned time. Drafts with a warning stay here for you to read first.")).toBeTruthy();
  await userEvent.click(screen.getAllByRole("button", { name: "Approve 2" }).at(-1)!);
  expect(post).toHaveBeenCalledWith("/api/w/{workspaceId}/items/approve-clean", { params: { path: { workspaceId: W } }, body: { items: [{ id: "a1", revision: 1 }, { id: "a2", revision: 2 }] } });
  cleanup();
  render(withQueries(<Campaign workspaceId={W} id={ID} role="viewer" />));
  await screen.findByRole("region", { name: "Needs you" });
  expect(screen.queryByRole("button", { name: "Approve 2" })).toBeNull();
});

test("the header's one main button follows the state: a launch date to pick, a plan to sign off, and nothing when nothing waits", async () => {
  serveItems({ ...campaign, status: "no_launch_date", anchor: { on: null, stepKey: null } }, [], [], []);
  render(withQueries(<Campaign workspaceId={W} id={ID} role="owner" tab="overview" />));
  expect(await screen.findByText("No launch date yet")).toBeTruthy();
  await userEvent.click(screen.getByRole("button", { name: "Pick a launch date" }));
  expect(await screen.findByRole("region", { name: "Launch" })).toBeTruthy();
  cleanup();
  vi.restoreAllMocks();
  serveItems({ ...campaign, status: "awaiting_signoff" }, [item({ id: "pv", kind: "plan_version", groupKey: "plan:p", title: "Q4 plan" })], []);
  render(withQueries(<Campaign workspaceId={W} id={ID} role="owner" tab="overview" />));
  expect(await screen.findByRole("button", { name: "Sign off plan" })).toBeTruthy();
  expect(screen.queryByRole("button", { name: "More actions" })).toBeTruthy();
  cleanup();
  render(withQueries(<Campaign workspaceId={W} id={ID} role="viewer" tab="overview" />));
  await screen.findByRole("heading", { name: "Q4 push" });
  expect(screen.queryByRole("button", { name: "Sign off plan" })).toBeNull();
});

test("Content opens on the first step that needs approval, and another step opens from the list", async () => {
  const later = { ...step, key: "second", title: "Follow-up", on: "2026-11-20" };
  serveItems({ ...campaign, steps: [step, later] }, [item({ groupKey: `campaign:${ID}:step:second` })], []);
  render(withQueries(<Campaign workspaceId={W} id={ID} role="owner" tab="drafts" />));
  const steps = within(await screen.findByRole("navigation", { name: "Steps" }));
  expect(steps.getByRole("button", { name: /Follow-up/ }).getAttribute("aria-current")).toBe("true");
  expect(screen.getByRole("heading", { name: "Follow-up" })).toBeTruthy();
  await userEvent.click(steps.getByRole("button", { name: /First email/ }));
  expect(screen.getByRole("heading", { name: "First email" })).toBeTruthy();
  expect(steps.getByRole("button", { name: /Follow-up/ }).getAttribute("aria-current")).toBeNull();
});

test("a number Direx doesn't record has no tile: no email sent means no email numbers", () => {
  expect(resultTiles(undefined)).toEqual([]);
  expect(resultTiles({ sent: [{ kind: "post", channel: "mastodon2", n: 4 }], email: null, measures: [] })).toEqual([[4, "mastodon2 posts"]]);
});

test("the status is the server's: upcoming, running, paused, ended and the Draft states, with changes waiting marked", async () => {
  for (const [dates, want] of [
    [{ status: "scheduled", startsOn: inDays(5), anchor: { on: inDays(5), stepKey: null }, endsOn: inDays(30) }, `Starts ${dayWords(inDays(5))}`],
    [{ status: "running", startsOn: inDays(-5), anchor: { on: inDays(-5), stepKey: null }, endsOn: inDays(30) }, "Running"],
    [{ status: "paused", startsOn: inDays(-5), anchor: { on: inDays(-5), stepKey: null }, endsOn: inDays(30), paused: true }, "Paused"],
    [{ status: "ended", startsOn: inDays(-30), anchor: { on: inDays(-30), stepKey: null }, endsOn: inDays(-1) }, "Ended"],
    [{ status: "awaiting_signoff", startsOn: null, anchor: { on: null, stepKey: null }, endsOn: null }, "Awaiting sign-off"],
  ] as const) {
    serveOverview({ ...campaign, ...dates });
    render(withQueries(<Campaign workspaceId={W} id={ID} role="viewer" tab="overview" />));
    await screen.findByRole("heading", { name: "Q4 push" });
    expect(screen.getAllByText(want).some((e) => !e.closest("nav"))).toBe(true);
    cleanup();
    vi.restoreAllMocks();
  }
  expect(campaignStatus({ status: "no_launch_date", startsOn: null, anchor: { on: null, stepKey: null } })).toBe("No launch date");
  expect(campaignStatus({ status: "scheduled", startsOn: "2026-11-01", anchor: { on: "2026-11-12", stepKey: null } })).toBe("Starts Thu 12 Nov");
  expect(campaignStatus({ status: "draft", startsOn: null })).toBe("Draft");
  serveOverview({ ...campaign, changesWaiting: true });
  render(withQueries(<Campaign workspaceId={W} id={ID} role="viewer" />));
  expect(await screen.findByText("Changes waiting for sign-off")).toBeTruthy();
});

/** Stands in for the Campaigns page, which reads the list. */
function Listed() {
  useQuery(campaignsQuery(W));
  return null;
}

test("Delete draft shows on a Draft for an Owner, asks first, deletes and goes to Campaigns; a Contributor who didn't start it sees none", async () => {
  serveOverview({ ...campaign, status: "draft", startsOn: null, endsOn: null, anchor: { on: null, stepKey: null } });
  const del = vi.spyOn(api, "DELETE").mockImplementation((() => reply(200, { ok: true })) as never);
  render(withQueries(<><Campaign workspaceId={W} id={ID} role="owner" tab="overview" /><Listed /></>));
  await userEvent.click(await screen.findByRole("button", { name: "Delete draft" }));
  const lists = () => vi.mocked(api.GET).mock.calls.filter((c) => (c as unknown[])[0] === "/api/w/{workspaceId}/campaigns").length;
  const listed = lists();
  expect(await screen.findByText("The campaign and its plan are deleted for good. This can't be undone.")).toBeTruthy();
  expect(del).not.toHaveBeenCalled();
  await userEvent.click(screen.getAllByRole("button", { name: "Delete draft" }).at(-1)!);
  expect(del).toHaveBeenCalledWith("/api/w/{workspaceId}/campaigns/{id}/draft", at);
  expect(await screen.findByText("Draft deleted.")).toBeTruthy();
  // The Campaigns list is read again, so the deleted Draft leaves it without a reload.
  await vi.waitFor(() => expect(lists()).toBe(listed + 1));
  cleanup();
  vi.restoreAllMocks();
  serveOverview({ ...campaign, status: "draft", createdBy: "00000000-0000-4000-8000-0000000000ee" });
  render(withQueries(<Campaign workspaceId={W} id={ID} role="contributor" tab="overview" />));
  await screen.findByRole("heading", { name: "Q4 push" });
  expect(screen.queryByRole("button", { name: "Delete draft" })).toBeNull();
});

test("a Draft or Awaiting sign-off Campaign shows only Overview and Plan, and opens on Plan with the drafting run's refusal", async () => {
  serveOverview({ ...campaign, status: "draft", startsOn: null, endsOn: null, anchor: { on: null, stepKey: null } });
  render(withQueries(<Campaign workspaceId={W} id={ID} role="marketer" tab="drafts" notice="no_route" />));
  expect(await screen.findByText(/write this one yourself/)).toBeTruthy();
  const nav = within(screen.getByRole("navigation", { name: "Campaign" }));
  expect(nav.getAllByRole("link").map((l) => l.textContent)).toEqual(["Overview", "Plan"]);
  expect(screen.getAllByRole("link", { name: "Campaigns" })[0]!.getAttribute("href")).toBe(`/w/${W}/campaigns`);
  expect(nav.getByRole("link", { name: "Plan" }).getAttribute("aria-current")).toBe("page");
  // Which tab shows, for each state and ask.
  for (const status of ["draft", "awaiting_signoff"] as const) {
    expect(tabFor(null, { status })).toBe("plan");
    expect(tabFor("overview", { status })).toBe("overview");
    expect(tabFor("people", { status })).toBe("plan");
  }
  expect(tabFor(null, { status: "running" })).toBe("overview");
  expect(tabFor("people", { status: "running" })).toBe("people");
  expect(tabFor("nope", undefined)).toBe("overview");
});

test("Overview leads with the goal: the measures sit above the sent and other counts", async () => {
  serveOverview();
  render(withQueries(<Campaign workspaceId={W} id={ID} role="viewer" tab="overview" />));
  const bar = await screen.findByText("signups (71%)");
  const counts = screen.getByText("Steps done");
  expect(bar.compareDocumentPosition(counts) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
});
