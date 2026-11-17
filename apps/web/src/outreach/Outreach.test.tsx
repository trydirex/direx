// SPDX-License-Identifier: AGPL-3.0-only
// People loads through the query layer: a loading state, then the people; an error panel with Retry
// when they can't be read; the verdict header and column; and each row menu's writes.
import { afterEach, expect, test, vi } from "vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { api } from "../client";
import { choose, pick, withQueries } from "../testing";
import { momentWords } from "../campaigns/actions";
import { Outreach } from "./Outreach";
import { mailboxes, mailboxesQuery } from "./actions";

const W = "00000000-0000-4000-8000-0000000000aa";
const P = "00000000-0000-4000-8000-000000000001";
const reply = (status: number, body: unknown) => Promise.resolve({ ...(status < 400 ? { data: body } : { error: body }), response: new Response(null, { status }) });
const record = { country: "US", basis: "consent", entityType: "unknown", scope: null, expiresAt: null, confidence: "stated", warnings: [] };
const noContact = { name: null, company: null, campaign: null, lastEmailAt: null, replied: false };
const overview = {
  senderName: "Sam",
  postalAddress: "1 Main St",
  senderCountry: "US",
  paused: false,
  people: [
    { id: P, email: "kim@example.com", ...record, ...noContact, suppressed: false, suppressedBecause: null, quote: null, newsletterSince: null, hold: { reason: "in_conversation", detail: "Deal", release: null, waitUntil: null } },
    { id: "00000000-0000-4000-8000-000000000004", email: "said@example.com", ...record, ...noContact, suppressed: true, suppressedBecause: "reply", quote: "stop", newsletterSince: null, hold: null },
  ],
};

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

/** Every read answers from these; `outreach` decides the overview. Writes answer `code` (null is OK). */
function serve(o: { outreach?: () => Promise<unknown>; code?: string | null; hook?: unknown; holds?: unknown[] } = {}) {
  vi.spyOn(api, "GET").mockImplementation(((path: string) => {
    if (path === "/api/w/{workspaceId}/outreach") return o.outreach ? o.outreach() : reply(200, overview);
    if (path === "/api/w/{workspaceId}/credentials") return reply(200, { credentials: [{ id: "c1", name: "Sam's Gmail", connection: "gmail" }] });
    if (path === "/api/w/{workspaceId}/mailbox-providers") return reply(200, { providers: [{ connection: "gmail" }] });
    if (path === "/api/w/{workspaceId}/outreach/people/{personId}/outside-touches") return reply(200, { touches: [{ id: "t1", channel: "call", direction: "outbound", occurredAt: "2026-11-05T10:00:00.000Z", source: "manual", canDelete: true }], profiles: [{ kind: "linkedin", url: "https://www.linkedin.com/in/lee" }] });
    if (path === "/api/w/{workspaceId}/outreach/people/{personId}/holds") return reply(200, { holds: o.holds ?? [] });
    if (path === "/api/w/{workspaceId}/outreach/hold-hook") return reply(200, { hook: o.hook ?? null });
    return reply(404, { error: "not_found" });
  }) as never);
  const answer = (() => (o.code ? reply(400, { error: o.code }) : reply(200, {}))) as never;
  vi.spyOn(api, "DELETE").mockImplementation(answer);
  vi.spyOn(api, "PUT").mockImplementation(answer);
  return vi.spyOn(api, "POST").mockImplementation(((path: string) =>
    path.endsWith("/hold-hook") && !o.code ? reply(200, { id: "h1", path: "/api/hooks/holds/x", secret: "s3cr3t" }) : o.code ? reply(400, { error: o.code }) : reply(200, {})) as never);
}
const region = (name: string) => within(screen.getByRole("region", { name }));

const person = (id: string, email: string) => ({ id, email, ...record, ...noContact, suppressed: false, suppressedBecause: null, quote: null, newsletterSince: null, hold: null });
const LEE = "00000000-0000-4000-8000-000000000005";
const table = () => screen.findByRole("table", { name: "People" });
const row = async (email: string) => within(within(await table()).getByText(email).closest("tr")!);

test("People shows a loading state, then the people", async () => {
  serve();
  render(withQueries(<Outreach workspaceId={W} role="owner" />));
  expect(screen.getAllByRole("status").some((s) => s.textContent === "Loading")).toBe(true);
  expect(await within(await table()).findByText("kim@example.com")).toBeTruthy();
  expect(screen.getByRole("heading", { level: 1, name: "People" })).toBeTruthy();
});

test("one Person is counted as one Person, not 1 People", async () => {
  serve({ outreach: () => reply(200, { ...overview, people: overview.people.slice(0, 1) }) });
  render(withQueries(<Outreach workspaceId={W} role="owner" />));
  expect((await screen.findByRole("region", { name: "Who can be emailed" })).querySelector("p")?.textContent).toBe("1 Person");
  expect(screen.queryByText(/\b1 People\b/)).toBeNull();
});

test("when the people can't be read, People says so and Retry reads them again", async () => {
  let fail = true;
  serve({ outreach: () => (fail ? reply(403, { error: "forbidden" }) : reply(200, overview)) });
  render(withQueries(<Outreach workspaceId={W} role="owner" />));
  expect((await screen.findByRole("alert")).textContent).toContain("Your role doesn't allow that.");
  fail = false;
  await userEvent.click(screen.getByRole("button", { name: "Retry" }));
  expect(await within(await table()).findByText("kim@example.com")).toBeTruthy();
});

/** Opens Add a Person from the header and fills what it asks up front, then More details. */
async function fillAdd() {
  await userEvent.click(await screen.findByRole("button", { name: "Add a Person" }));
  const dialog = await screen.findByRole("dialog", { name: "Add a Person" });
  const add = within(dialog);
  const more = add.getByText("More details", { selector: "summary" }).closest("details")!;
  expect(add.getByLabelText("Email")).toBeTruthy();
  expect(add.getByRole("combobox", { name: "Country" })).toBeTruthy();
  expect(more.open).toBe(false);
  expect(more.contains(add.getByLabelText("Where it came from"))).toBe(true);
  expect(more.contains(add.getByRole("combobox", { name: "Why you may contact them" }))).toBe(true);
  await userEvent.type(add.getByLabelText("Email"), "new@example.com");
  await choose("Country", "Germany", add);
  await userEvent.click(add.getByText("More details"));
  expect(more.open).toBe(true);
  await choose("Why you may contact them", "Legitimate interest", add);
  await userEvent.clear(add.getByLabelText("Where it came from"));
  await userEvent.type(add.getByLabelText("Where it came from"), "their site");
  await userEvent.click(add.getByRole("button", { name: "Add Person" }));
  return dialog;
}
const added = { email: "new@example.com", country: "DE", basis: "legitimate_interest", evidence: "their site", entityType: "unknown", scope: null, expiresAt: null };

test("Add a Person in the header opens a dialog that asks for email and country, with the rest under More details", async () => {
  const post = serve();
  render(withQueries(<Outreach workspaceId={W} role="owner" />));
  const dialog = await fillAdd();
  expect(post).toHaveBeenCalledWith("/api/w/{workspaceId}/outreach/people", { params: { path: { workspaceId: W } }, body: added });
  expect(dialog.contains(await screen.findByText("Added."))).toBe(false);
  await vi.waitFor(() => expect(screen.queryByRole("dialog", { name: "Add a Person" })).toBeNull());

  await userEvent.click(screen.getByText("Someone not listed asked to stop"));
  await userEvent.type(screen.getByLabelText("Their email"), "no@example.com");
  await userEvent.click(screen.getByRole("button", { name: "Record it" }));
  expect(post).toHaveBeenCalledWith("/api/w/{workspaceId}/outreach/suppressions", { params: { path: { workspaceId: W } }, body: { email: "no@example.com" } });
});

test("adding an email that is already here says its record was updated, not Added", async () => {
  serve();
  vi.mocked(api.POST).mockImplementation((() => reply(200, { id: P, updated: true })) as never);
  render(withQueries(<Outreach workspaceId={W} role="owner" />));
  await fillAdd();
  expect(await screen.findByText("Updated. That email was already here, so its record was replaced.")).toBeTruthy();
  expect(screen.queryByText("Added.")).toBeNull();
});

test("email and country are enough: Where it came from says Added by hand until someone names the source", async () => {
  const post = serve();
  render(withQueries(<Outreach workspaceId={W} role="owner" />));
  await userEvent.click(await screen.findByRole("button", { name: "Add a Person" }));
  const add = within(await screen.findByRole("dialog", { name: "Add a Person" }));
  await userEvent.type(add.getByLabelText("Email"), "new@example.com");
  await choose("Country", "Germany", add);
  await userEvent.click(add.getByRole("button", { name: "Add Person" }));
  await vi.waitFor(() => expect(post).toHaveBeenCalledWith("/api/w/{workspaceId}/outreach/people", { params: { path: { workspaceId: W } }, body: expect.objectContaining({ email: "new@example.com", country: "DE", evidence: "Added by hand" }) }));
});

test("a refused Add a Person keeps the dialog open with what was typed, and says why", async () => {
  const post = serve({ code: "sender_identity_missing" });
  render(withQueries(<Outreach workspaceId={W} role="owner" />));
  const dialog = within(await fillAdd());
  expect(post).toHaveBeenCalledWith("/api/w/{workspaceId}/outreach/people", { params: { path: { workspaceId: W } }, body: added });
  expect((await dialog.findByRole("alert")).textContent).toBe("Save a sender name and postal address first.");
  expect((dialog.getByLabelText("Email") as HTMLInputElement).value).toBe("new@example.com");
  expect((dialog.getByLabelText("Where it came from") as HTMLInputElement).value).toBe("their site");
});

test("Write an email from a row drafts one email to that Person for approval, and a refusal is an alert", async () => {
  const post = serve({ code: "sender_identity_missing", outreach: () => reply(200, { ...overview, people: [person(P, "kim@example.com"), person(LEE, "lee@example.com")] }) });
  render(withQueries(<Outreach workspaceId={W} role="owner" />));
  await pick(await screen.findByRole("button", { name: "Actions for lee@example.com" }), "Write an email", "menuitem");
  const write = await screen.findByRole("dialog", { name: "Write to lee@example.com" });
  await within(write).findByRole("option", { name: "Sam's Gmail" });
  await userEvent.type(within(write).getByLabelText("Subject"), "Hello");
  await userEvent.type(within(write).getByLabelText("Message"), "A short note.");
  await userEvent.click(within(write).getByRole("button", { name: "Send for approval" }));
  expect(post).toHaveBeenCalledWith("/api/w/{workspaceId}/outreach/emails", {
    params: { path: { workspaceId: W } },
    body: { personId: LEE, credentialId: "c1", touchClass: "cold", subject: "Hello", text: "A short note." },
  });
  expect((await within(write).findByRole("alert")).textContent).toBe("Save a sender name and postal address first.");
});

test("Write an email with no Mailbox says to connect one first and can't be sent", async () => {
  const post = serve({ outreach: () => reply(200, { ...overview, people: [person(LEE, "lee@example.com")] }) });
  const get = vi.mocked(api.GET).getMockImplementation() as unknown as (path: string) => unknown;
  vi.mocked(api.GET).mockImplementation(((path: string) => (path === "/api/w/{workspaceId}/credentials" ? reply(200, { credentials: [] }) : get(path))) as never);
  render(withQueries(<Outreach workspaceId={W} role="owner" />));
  await pick(await screen.findByRole("button", { name: "Actions for lee@example.com" }), "Write an email", "menuitem");
  const write = within(await screen.findByRole("dialog", { name: "Write to lee@example.com" }));
  expect((await write.findByText(/Connect a Mailbox first/)).textContent).toBe("Connect a Mailbox first, in Settings, Email and keys. Emails go from a Mailbox.");
  expect(write.getByRole("link", { name: "Settings, Email and keys" }).getAttribute("href")).toBe(`/w/${W}/settings/credentials`);
  await userEvent.type(write.getByLabelText("Subject"), "Hello");
  await userEvent.type(write.getByLabelText("Message"), "A short note.");
  const send = write.getByRole("button", { name: "Send for approval" }) as HTMLButtonElement;
  expect(send.disabled).toBe(true);
  fireEvent.submit(send.closest("form")!);
  expect(post).not.toHaveBeenCalledWith("/api/w/{workspaceId}/outreach/emails", expect.anything());
});

test("an Owner undoes a misread opt-out from the row menu, with a reason", async () => {
  const post = serve();
  render(withQueries(<Outreach workspaceId={W} role="owner" />));
  await pick(await screen.findByRole("button", { name: "Actions for said@example.com" }), "Reply misread?", "menuitem");
  expect(await screen.findByText("Undo the opt-out for said@example.com?")).toBeTruthy();
  await userEvent.type(screen.getByLabelText("Why"), "misread");
  await userEvent.click(screen.getByRole("button", { name: "Undo opt-out" }));
  expect(post).toHaveBeenCalledWith("/api/w/{workspaceId}/outreach/people/{personId}/undo-opt-out", { params: { path: { workspaceId: W, personId: "00000000-0000-4000-8000-000000000004" } }, body: { reason: "misread" } });
  cleanup();
  vi.restoreAllMocks();
  serve();
  render(withQueries(<Outreach workspaceId={W} role="admin" />));
  expect(await screen.findByRole("button", { name: "Actions for kim@example.com" })).toBeTruthy();
  expect(screen.queryByRole("button", { name: "Actions for said@example.com" })).toBeNull();
});

test("an Admin's Stop holding says when nothing is running, and ends what is", async () => {
  serve();
  render(withQueries(<Outreach workspaceId={W} role="admin" />));
  await pick(await screen.findByRole("button", { name: "Actions for kim@example.com" }), "Stop holding", "menuitem");
  await userEvent.click(await screen.findByRole("button", { name: "Stop holding" }));
  expect(await screen.findByText(/Nothing is running/)).toBeTruthy();
  cleanup();
  vi.restoreAllMocks();
  const post = serve({ holds: [{ id: "h9" }] });
  render(withQueries(<Outreach workspaceId={W} role="admin" />));
  await pick(await screen.findByRole("button", { name: "Actions for kim@example.com" }), "Stop holding", "menuitem");
  await userEvent.click(await screen.findByRole("button", { name: "Stop holding" }));
  expect(await screen.findByText("Stopped holding. Cold email stays off for 90 more days.")).toBeTruthy();
  expect(post).toHaveBeenCalledWith("/api/w/{workspaceId}/outreach/holds/{holdId}/end", { params: { path: { workspaceId: W, holdId: "h9" } } });
});

test("a hold that has ended shows as held until a date, and Stop holding isn't offered again", async () => {
  const ended = { ...overview.people[0]!, hold: { reason: "in_conversation", detail: "Deal", release: null, waitUntil: "2027-02-11T09:00:00.000Z" } };
  serve({ outreach: () => reply(200, { ...overview, people: [ended] }) });
  render(withQueries(<Outreach workspaceId={W} role="admin" />));
  expect(await screen.findByText(/Held until 2027-02-11/)).toBeTruthy();
  expect(screen.queryByText(/Talking to them/)).toBeNull();
  await userEvent.click(screen.getByRole("button", { name: "Actions for kim@example.com" }));
  expect(await screen.findByRole("menuitem", { name: "Write an email" })).toBeTruthy();
  expect(screen.queryByRole("menuitem", { name: "Stop holding" })).toBeNull();
});

test("Log a call or message opens that Person's touches: log one, save a profile, remove one", async () => {
  const post = serve({ outreach: () => reply(200, { ...overview, people: [person(P, "kim@example.com"), person(LEE, "lee@example.com")] }) });
  render(withQueries(<Outreach workspaceId={W} role="owner" />));
  await pick(await screen.findByRole("button", { name: "Actions for lee@example.com" }), "Log a call or message", "menuitem");
  const touches = within(await screen.findByRole("dialog", { name: "lee@example.com" }));
  expect(touches.queryByRole("combobox", { name: "Person" })).toBeNull();
  expect(await touches.findByText(/Call, sent/)).toBeTruthy();
  // A profile saved earlier shows when the form opens again.
  expect(within(touches.getByRole("list", { name: "Saved profiles" })).getByText("LinkedIn: https://www.linkedin.com/in/lee")).toBeTruthy();
  await userEvent.click(touches.getByLabelText("They replied"));
  await userEvent.click(touches.getByRole("button", { name: "Log it" }));
  expect(post.mock.calls.at(-1)![0]).toBe("/api/w/{workspaceId}/outreach/people/{personId}/outside-touches");
  expect(post.mock.calls.at(-1)![1]).toMatchObject({ params: { path: { personId: LEE } }, body: { channel: "call", direction: "inbound" } });
  expect(await screen.findByText("Logged.")).toBeTruthy();
  await userEvent.type(touches.getByLabelText("URL or handle"), "@lee");
  await userEvent.click(touches.getByRole("button", { name: "Save profile" }));
  expect(await screen.findByText("Profile saved. DM steps can draft for them now.")).toBeTruthy();
  await userEvent.click(await touches.findByRole("button", { name: /^Remove / }));
  expect(await screen.findByText("Removed.")).toBeTruthy();
});

test("each person's row menu names the person, so two rows can be told apart", async () => {
  serve({ outreach: () => reply(200, { ...overview, people: [person(P, "kim@example.com"), person(LEE, "lee@example.com")] }) });
  render(withQueries(<Outreach workspaceId={W} role="owner" />));
  expect(await screen.findByRole("button", { name: "Actions for kim@example.com" })).toBeTruthy();
  expect(screen.getByRole("button", { name: "Actions for lee@example.com" })).toBeTruthy();
});

test("the verdict comes right after the Person, with its reason under it and the basis in its own column", async () => {
  serve();
  render(withQueries(<Outreach workspaceId={W} role="owner" />));
  expect(within(await table()).getAllByRole("columnheader").map((c) => c.textContent)).toEqual(["Person", "Can email?", "Allowed by", "Company", "Campaign", "Last email", "Reply", "Actions"]);
  const kim = await row("kim@example.com");
  expect(kim.getByText("Not now")).toBeTruthy();
  expect(kim.getByText("Talking to them: Deal")).toBeTruthy();
  expect(kim.getByText("US, Consent")).toBeTruthy();
  const said = await row("said@example.com");
  expect(said.getByText("Asked to stop")).toBeTruthy();
  expect(said.getByText('Replied "stop"')).toBeTruthy();
  expect(said.getByText("No longer applies")).toBeTruthy();
});

test("the header splits the total by verdict, and each verdict filters the table", async () => {
  serve({ outreach: () => reply(200, { ...overview, people: [...overview.people, person(LEE, "lee@example.com")] }) });
  render(withQueries(<Outreach workspaceId={W} role="owner" />));
  const head = within(await screen.findByRole("region", { name: "Who can be emailed" }));
  expect(head.getByText("3")).toBeTruthy();
  const counts = head.getAllByRole("term").map((t) => [t.textContent, t.nextElementSibling?.textContent]);
  expect(counts).toEqual([
    ["Can be emailed", "1"],
    ["Not now", "1"],
    ["Asked to stop", "1"],
  ]);
  expect(head.getByText("1 talking to them")).toBeTruthy();
  expect(head.getByText("Never emailed again")).toBeTruthy();
  const filter = within(screen.getByRole("group", { name: "Filter" }));
  expect(filter.getAllByRole("button").map((b) => [b.textContent, b.getAttribute("aria-pressed")])).toEqual([
    ["All 3", "true"],
    ["Can be emailed 1", "false"],
    ["Not now 1", "false"],
    ["Asked to stop 1", "false"],
    ["Newsletter 0", "false"],
  ]);
  await userEvent.click(filter.getByRole("button", { name: "Can be emailed 1" }));
  expect(filter.getByRole("button", { name: "Can be emailed 1" }).getAttribute("aria-pressed")).toBe("true");
  expect(filter.getByRole("button", { name: "All 3" }).getAttribute("aria-pressed")).toBe("false");
  expect(within(await table()).getByText("lee@example.com")).toBeTruthy();
  expect(within(await table()).queryByText("kim@example.com")).toBeNull();
  await userEvent.click(filter.getByRole("button", { name: "Can be emailed 1" }));
  expect(within(await table()).getByText("kim@example.com")).toBeTruthy();
});

test("a row shows the Person's name, company, latest Campaign, last email and whether they replied", async () => {
  const C = "00000000-0000-4000-8000-0000000000c1";
  const at = "2026-11-10T09:30:00.000Z";
  serve({ outreach: () => reply(200, { ...overview, people: [{ ...person(P, "kim@example.com"), name: "Kim", company: "Acme Ltd", campaign: { id: C, title: "Autumn audits" }, lastEmailAt: at, replied: true }, person(LEE, "lee@example.com")] }) });
  render(withQueries(<Outreach workspaceId={W} role="owner" />));
  const kim = await row("kim@example.com");
  expect(kim.getByText("Kim")).toBeTruthy();
  // Once in its column, once under the name for narrow screens.
  expect(kim.getAllByText("Acme Ltd")).toHaveLength(2);
  expect(kim.getByRole("link", { name: "Autumn audits" }).getAttribute("href")).toBe(`/w/${W}/campaigns/${C}`);
  expect(kim.getByText(momentWords(at))).toBeTruthy();
  expect(kim.getByText("Replied")).toBeTruthy();
  expect(kim.getByText("Can be emailed")).toBeTruthy();
  const lee = await row("lee@example.com");
  expect(lee.getByText("Never")).toBeTruthy();
  expect(lee.getByText("None")).toBeTruthy();
  expect(lee.getByText("No reply")).toBeTruthy();
  await userEvent.type(screen.getByRole("searchbox", { name: "Search People" }), "acme");
  expect(within(await table()).queryByText("lee@example.com")).toBeNull();
});

test("the row menu holds with \"We're talking to them\" or records Asked to stop only after a confirm", async () => {
  const post = serve({ outreach: () => reply(200, { ...overview, people: [person(P, "kim@example.com")] }) });
  render(withQueries(<Outreach workspaceId={W} role="owner" />));
  const menu = await screen.findByRole("button", { name: "Actions for kim@example.com" });
  await pick(menu, "We're talking to them", "menuitem");
  expect(await screen.findByText("Are you talking to kim@example.com?")).toBeTruthy();
  expect(post).not.toHaveBeenCalledWith("/api/w/{workspaceId}/outreach/people/{personId}/holds", expect.anything());
  await userEvent.click(screen.getByRole("button", { name: "We're talking to them" }));
  expect(post).toHaveBeenCalledWith("/api/w/{workspaceId}/outreach/people/{personId}/holds", { params: { path: { workspaceId: W, personId: P } }, body: { reason: "Marked on People" } });
  expect(await screen.findByText("Their Campaigns stopped.")).toBeTruthy();

  await pick(menu, "Asked to stop", "menuitem");
  expect(await screen.findByText("Did kim@example.com ask to stop?")).toBeTruthy();
  await userEvent.click(screen.getByRole("button", { name: "Cancel" }));
  expect(post).not.toHaveBeenCalledWith("/api/w/{workspaceId}/outreach/suppressions", expect.anything());
  await pick(menu, "Asked to stop", "menuitem");
  await userEvent.click(within(await screen.findByRole("dialog", { name: "Did kim@example.com ask to stop?" })).getByRole("button", { name: "Record it" }));
  expect(post).toHaveBeenCalledWith("/api/w/{workspaceId}/outreach/suppressions", { params: { path: { workspaceId: W } }, body: { email: "kim@example.com" } });
});

test("a missing sender links to Settings, and the page says where sending and the CRM went", async () => {
  serve({ outreach: () => reply(200, { ...overview, senderName: null }) });
  render(withQueries(<Outreach workspaceId={W} role="owner" />));
  expect((await screen.findByRole("link", { name: "Add who is sending" })).getAttribute("href")).toBe(`/w/${W}/settings/sending`);
  expect(screen.getByRole("link", { name: "Settings, Who is sending" }).getAttribute("href")).toBe(`/w/${W}/settings/sending`);
  expect(screen.queryByRole("tab")).toBeNull();
  expect(screen.queryByRole("region", { name: "Deals in another CRM" })).toBeNull();
});

test("with nobody yet, the empty state leads to Find companies and Add a Person, and nothing opens by itself", async () => {
  serve({ outreach: () => reply(200, { ...overview, people: [] }) });
  render(withQueries(<Outreach workspaceId={W} role="owner" />));
  const empty = within((await screen.findByText("No People yet")).closest("[role=status]") as HTMLElement);
  expect(empty.getByRole("link", { name: "Find companies" }).getAttribute("href")).toBe(`/w/${W}/people/find`);
  expect(screen.getAllByRole("link", { name: "Find companies" })).toHaveLength(1);
  expect(screen.queryByRole("dialog")).toBeNull();
  expect(screen.queryByRole("table")).toBeNull();
  await userEvent.click(empty.getByRole("button", { name: "Add a Person" }));
  expect(within(await screen.findByRole("dialog", { name: "Add a Person" })).getByLabelText("Email")).toBeTruthy();
  cleanup();

  serve();
  render(withQueries(<Outreach workspaceId={W} role="owner" />));
  expect((await screen.findByRole("link", { name: "Find companies" })).getAttribute("href")).toBe(`/w/${W}/people/find`);
  expect(screen.queryByRole("dialog")).toBeNull();
  expect(screen.getByText("Someone not listed asked to stop").closest("details")!.open).toBe(false);
});

test("both mailbox loaders recognize existing Gmail independently of connection availability", async () => {
  vi.spyOn(api, "GET").mockImplementation(((path: string, options: { params: { query?: { purpose?: string } } }) => {
    if (path.endsWith("/credentials")) return reply(200, { credentials: [{ id: "gmail", name: "Stored Gmail", connection: "google" }, { id: "other", connection: "unrelated" }] });
    return reply(200, { providers: options.params.query?.purpose === "existing" ? [{ connection: "google" }] : [] });
  }) as never);
  expect(await mailboxes(W)).toEqual([{ id: "gmail", name: "Stored Gmail", connection: "google" }]);
  const query = mailboxesQuery(W);
  expect(await query.queryFn!({} as never)).toEqual([{ id: "gmail", name: "Stored Gmail" }]);
});
