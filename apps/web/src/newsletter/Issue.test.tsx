// SPDX-License-Identifier: AGPL-3.0-only
// An issue loads through the query layer: a loading state first, then the issue, and an error panel
// with Retry when it can't be read.
import { afterEach, expect, test, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { api } from "../client";
import { withQueries } from "../testing";
import type { Issue as IssueData } from "./actions";
import { Issue } from "./Issue";

const W = "00000000-0000-4000-8000-0000000000aa";
const ID = "00000000-0000-4000-8000-000000000010";
const reply = (status: number, body: unknown) => Promise.resolve({ ...(status < 400 ? { data: body } : { error: body }), response: new Response(null, { status }) });
const issue: IssueData = { itemId: ID, state: "draft", approveBy: "2026-11-10T08:00:00.000Z", warnings: [], revision: 1, slot: "2026-11-10T08:00:00.000Z", title: "Week 45", previewText: "", markdown: "We **shipped**.", html: "<p>We shipped.</p>", handoffTo: null, sentAt: null, stats: null, statsReadAt: null };

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

test("Issue shows a loading state, then the issue", async () => {
  vi.spyOn(api, "GET").mockImplementation((() => reply(200, issue)) as never);
  render(withQueries(<Issue workspaceId={W} itemId={ID} role="owner" />));
  expect(screen.getAllByRole("status").some((s) => s.textContent === "Loading")).toBe(true);
  expect(await screen.findByRole("heading", { name: "Week 45" })).toBeTruthy();
  expect(screen.getByRole("textbox", { name: "Body" })).toBeTruthy();
});

test("an issue that isn't there says so, with no Retry, which can't bring it back", async () => {
  vi.spyOn(api, "GET").mockImplementation((() => reply(404, { error: "not_found" })) as never);
  render(withQueries(<Issue workspaceId={W} itemId={ID} role="owner" />));
  expect((await screen.findByRole("alert")).textContent).toContain("This issue isn't here any more.");
  expect(screen.queryByRole("button", { name: "Retry" })).toBeNull();
});

const one = { params: { path: { workspaceId: W, itemId: ID } } };

test("writing an issue previews the Markdown, saves it, and sends it for approval", async () => {
  let stored: IssueData = issue;
  vi.spyOn(api, "GET").mockImplementation((() => reply(200, stored)) as never);
  const put = vi.spyOn(api, "PUT").mockImplementation((() => reply(500, { error: "unexpected" })) as never).mockImplementationOnce((() => reply(400, { error: "issue_empty" })) as never);
  const post = vi.spyOn(api, "POST").mockImplementation(((path: string) => {
    if (path.endsWith("/preview")) return reply(200, { html: "<p>We shipped twice.</p>" });
    stored = { ...issue, state: "needs_approval", revision: 3 };
    return reply(200, stored);
  }) as never);
  render(withQueries(<Issue workspaceId={W} itemId={ID} role="contributor" initial={issue} />));
  expect(screen.queryByText("Saving after approval sends it back for approval.")).toBeNull();
  const box = screen.getByRole("textbox", { name: "Body" });
  await userEvent.clear(box);
  await userEvent.type(box, "We shipped twice.");
  await vi.waitFor(() => expect((screen.getByTitle("Issue preview") as HTMLIFrameElement).getAttribute("srcdoc")).toBe("<p>We shipped twice.</p>"));
  expect(post).toHaveBeenLastCalledWith("/api/w/{workspaceId}/newsletter/preview", { params: { path: { workspaceId: W } }, body: { markdown: "We shipped twice." } });

  await userEvent.type(screen.getByRole("textbox", { name: "Preview text" }), " Two releases ");
  await userEvent.click(screen.getByRole("button", { name: "Save" }));
  expect(put).toHaveBeenCalledWith("/api/w/{workspaceId}/newsletter/issues/{itemId}", { ...one, body: { title: "Week 45", previewText: "Two releases", markdown: "We shipped twice." } });
  expect((await screen.findByRole("alert")).textContent).toBe("Give it a title and some words first.");

  put.mockImplementationOnce((() => reply(200, { ...issue, markdown: "We shipped twice.", revision: 2 })) as never);
  await userEvent.click(screen.getByRole("button", { name: "Save" }));
  expect(await screen.findByText("Saved.")).toBeTruthy();

  await userEvent.click(screen.getByRole("button", { name: "Send for approval" }));
  expect(post).toHaveBeenLastCalledWith("/api/w/{workspaceId}/newsletter/issues/{itemId}/submit", one);
  expect(await screen.findByText("Sent for approval.")).toBeTruthy();
  expect(screen.queryByRole("button", { name: "Send for approval" })).toBeNull();
});

test("saving a scheduled issue says it needs approving again", async () => {
  const scheduled = { ...issue, state: "scheduled" as const };
  vi.spyOn(api, "GET").mockImplementation((() => reply(200, scheduled)) as never);
  vi.spyOn(api, "PUT").mockImplementation((() => reply(200, { ...scheduled, state: "needs_approval", revision: 2 })) as never);
  render(withQueries(<Issue workspaceId={W} itemId={ID} role="owner" initial={scheduled} />));
  expect(screen.getByText("Saving after approval sends it back for approval.")).toBeTruthy();
  await userEvent.click(screen.getByRole("button", { name: "Save" }));
  expect(await screen.findByText("Saved. The approval was taken back, so it needs approving again.")).toBeTruthy();
});

test("approving an issue posts its revision, and a refusal says why", async () => {
  const waiting = { ...issue, state: "needs_approval" as const, approveBy: "2026-11-10T06:00:00.000Z", warnings: [{ code: "no_unsubscribe", text: "No unsubscribe link." }] };
  vi.spyOn(api, "GET").mockImplementation((() => reply(200, waiting)) as never);
  const post = vi.spyOn(api, "POST").mockImplementation((() => reply(500, { error: "unexpected" })) as never).mockImplementationOnce((() => reply(409, { error: "slot_in_past" })) as never);
  render(withQueries(<Issue workspaceId={W} itemId={ID} role="marketer" initial={waiting} />));
  expect(screen.getByRole("list", { name: "Warnings" }).textContent).toBe("No unsubscribe link.");
  expect(screen.getByText(/Approve by .* so it can go out at/)).toBeTruthy();
  const button = screen.getByRole("button", { name: /^Approve · goes out/ });
  await userEvent.click(button);
  expect(post).toHaveBeenCalledWith("/api/w/{workspaceId}/items/{id}/approve", { params: { path: { workspaceId: W, id: ID } }, body: { revision: 1 } });
  expect((await screen.findByRole("alert")).textContent).toBe("Its time has passed, so it can't be approved now. It will be skipped.");
  post.mockImplementationOnce((() => reply(200, {})) as never);
  await userEvent.click(button);
  expect(await screen.findByText("Approved. It goes out at its time.")).toBeTruthy();
});

test("with unsaved edits the header saves first and approves the saved revision; a refused save approves nothing", async () => {
  const waiting = { ...issue, state: "needs_approval" as const };
  vi.spyOn(api, "GET").mockImplementation((() => reply(200, waiting)) as never);
  const calls: string[] = [];
  const put = vi.spyOn(api, "PUT").mockImplementation(((path: string) => (calls.push(path), reply(400, { error: "issue_empty" }))) as never);
  const post = vi.spyOn(api, "POST").mockImplementation(((path: string) => (path.endsWith("/preview") ? reply(200, { html: "<p>x</p>" }) : (calls.push(path), reply(200, {})))) as never);
  render(withQueries(<Issue workspaceId={W} itemId={ID} role="owner" initial={waiting} />));
  expect(screen.getByRole("button", { name: /^Approve · goes out/ })).toBeTruthy();
  expect(screen.queryByText("Unsaved changes")).toBeNull();

  await userEvent.type(screen.getByRole("textbox", { name: "Body" }), " Fixed a typo.");
  expect(screen.getByText("Unsaved changes")).toBeTruthy();

  await userEvent.click(screen.getByRole("button", { name: /^Save and approve · goes out/ }));
  expect((await screen.findByRole("alert")).textContent).toBe("Give it a title and some words first.");
  expect(calls).toEqual(["/api/w/{workspaceId}/newsletter/issues/{itemId}"]);

  put.mockImplementationOnce(((path: string) => (calls.push(path), reply(200, { ...waiting, markdown: "We **shipped**. Fixed a typo.", revision: 7 }))) as never);
  await userEvent.click(screen.getByRole("button", { name: /^Save and approve · goes out/ }));
  expect(await screen.findByText("Approved. It goes out at its time.")).toBeTruthy();
  expect(put).toHaveBeenLastCalledWith("/api/w/{workspaceId}/newsletter/issues/{itemId}", { ...one, body: { title: "Week 45", markdown: "We **shipped**. Fixed a typo." } });
  expect(calls.slice(1)).toEqual(["/api/w/{workspaceId}/newsletter/issues/{itemId}", "/api/w/{workspaceId}/items/{id}/approve"]);
  expect(post).toHaveBeenLastCalledWith("/api/w/{workspaceId}/items/{id}/approve", { params: { path: { workspaceId: W, id: ID } }, body: { revision: 7 } });
});

test("a handoff issue is approved, then copied and recorded as sent", async () => {
  const handed = { ...issue, state: "needs_approval" as const, handoffTo: "Substack" };
  vi.spyOn(api, "GET").mockImplementation((() => reply(200, handed)) as never);
  vi.spyOn(api, "POST").mockImplementation((() => reply(500, { error: "unexpected" })) as never).mockImplementationOnce((() => reply(200, {})) as never);
  render(withQueries(<Issue workspaceId={W} itemId={ID} role="owner" initial={handed} />));
  expect(screen.getByText(/sent by you in Substack/)).toBeTruthy();
  await userEvent.click(screen.getByRole("button", { name: "Approve" }));
  expect(await screen.findByText("Approved. Copy it into Substack and send it there.")).toBeTruthy();
});

test("a scheduled handoff shows the HTML to copy, and I sent it records the send", async () => {
  const copying = { ...issue, state: "scheduled" as const, handoffTo: "Substack" };
  let stored: IssueData = copying;
  vi.spyOn(api, "GET").mockImplementation((() => reply(200, stored)) as never);
  const post = vi.spyOn(api, "POST").mockImplementation((() => {
    stored = { ...copying, state: "sent", revision: 2, sentAt: "2026-11-10T08:05:00.000Z" };
    return reply(200, stored);
  }) as never);
  const write = vi.fn(() => Promise.resolve());
  Object.defineProperty(navigator, "clipboard", { value: { writeText: write }, configurable: true });
  render(withQueries(<Issue workspaceId={W} itemId={ID} role="owner" initial={copying} />));
  expect(screen.queryByRole("textbox", { name: "Body" })).toBeNull();
  expect(screen.getByRole("region", { name: "Copy this into Substack" })).toBeTruthy();
  await userEvent.click(screen.getByRole("button", { name: "Copy HTML" }));
  expect(write).toHaveBeenCalledWith("<p>We shipped.</p>");
  expect(await screen.findByText("Copied.")).toBeTruthy();
  await userEvent.click(screen.getByRole("button", { name: "I sent it" }));
  expect(post).toHaveBeenCalledWith("/api/w/{workspaceId}/newsletter/issues/{itemId}/sent", one);
  expect(await screen.findByText("Recorded as sent.")).toBeTruthy();
  expect(screen.getByText("Substack doesn't tell Direx how an issue did. Check it there.")).toBeTruthy();
});

test("a sent issue shows its stats and when they were read", async () => {
  const sent = { ...issue, state: "sent" as const, sentAt: "2026-11-10T08:00:00.000Z", statsReadAt: "2026-11-10T09:00:00.000Z", stats: { recipients: 1, delivered: 1, clicks: 2, unsubscribes: 0, opens: 3 } };
  vi.spyOn(api, "GET").mockImplementation(((path: string) => reply(200, path.endsWith("/issues") ? { issues: [], next: null } : sent)) as never);
  render(withQueries(<Issue workspaceId={W} itemId={ID} role="viewer" initial={sent as IssueData} />));
  const tile = (label: string) => screen.getByText(label, { selector: "dt" }).parentElement!.textContent;
  expect(tile("Delivered")).toBe("Delivered1of 1 sent");
  expect(tile("Click rate")).toBe("Click rate200.0%2 clicks");
  expect(tile("Unsubscribes")).toBe("Unsubscribes0");
  expect(screen.getByText(/^3 opens, but many are recorded automatically/)).toBeTruthy();
  expect(screen.getByText(/^Last read /)).toBeTruthy();
});

test("a tool that doesn't report deliveries shows who it was sent to, and the click rate over that", () => {
  const sent = { ...issue, state: "sent" as const, sentAt: "2026-11-10T08:00:00.000Z", stats: { recipients: 200, clicks: 5, unsubscribes: 1, opens: 3 } };
  vi.spyOn(api, "GET").mockImplementation(((path: string) => reply(200, path.endsWith("/issues") ? { issues: [], next: null } : sent)) as never);
  render(withQueries(<Issue workspaceId={W} itemId={ID} role="viewer" initial={sent as IssueData} />));
  expect(screen.queryByText("Delivered", { selector: "dt" })).toBeNull();
  expect(screen.getByText("Sent to", { selector: "dt" }).parentElement!.textContent).toBe("Sent to200");
  expect(screen.getByText("Click rate", { selector: "dt" }).parentElement!.textContent).toBe("Click rate2.5%5 clicks");
});

test("the inbox row shows the subject line and preview text as they are typed", async () => {
  vi.spyOn(api, "GET").mockImplementation((() => reply(200, issue)) as never);
  render(withQueries(<Issue workspaceId={W} itemId={ID} role="owner" initial={issue} />));
  const row = screen.getByLabelText("In the inbox");
  expect(row.textContent).toBe("Week 45No preview text: the inbox shows the first words of the body.");
  const subject = screen.getByRole("textbox", { name: "Subject line" });
  await userEvent.clear(subject);
  await userEvent.type(subject, "Two releases");
  await userEvent.type(screen.getByRole("textbox", { name: "Preview text" }), "And a fix");
  expect(row.textContent).toBe("Two releasesAnd a fix");
});

test("the header shows the state and the one next step, and the preview switches to a phone's width", async () => {
  vi.spyOn(api, "GET").mockImplementation((() => reply(200, issue)) as never);
  render(withQueries(<Issue workspaceId={W} itemId={ID} role="owner" initial={issue} />));
  expect(screen.getByText("Draft")).toBeTruthy();
  expect(screen.getByText(/^Goes out .*, once someone approves it\.$/)).toBeTruthy();
  expect(screen.getByRole("button", { name: "Save" })).toBeTruthy();
  expect(screen.getByText("7 characters. Most inboxes show about 60.")).toBeTruthy();
  expect(screen.getByText("Shown after the subject in the inbox. 0 characters; about 90 show.")).toBeTruthy();
  const frame = () => screen.getByLabelText("In the inbox").parentElement!;
  expect(frame().className).not.toContain("max-w-sm");
  await userEvent.click(screen.getByRole("button", { name: "Phone" }));
  expect(screen.getByRole("button", { name: "Phone" }).getAttribute("aria-pressed")).toBe("true");
  expect(frame().className).toContain("max-w-sm");
  await userEvent.click(screen.getByRole("button", { name: "Desktop" }));
  expect(frame().className).not.toContain("max-w-sm");
});

test("a viewer sees the state but no next step, and a sent issue says nothing about going out", () => {
  const sent = { ...issue, state: "sent" as const, sentAt: "2026-11-10T08:00:00.000Z" };
  vi.spyOn(api, "GET").mockImplementation((() => reply(200, sent)) as never);
  render(withQueries(<Issue workspaceId={W} itemId={ID} role="owner" initial={sent} />));
  expect(screen.getByText("Sent")).toBeTruthy();
  expect(screen.queryByText(/^Goes out/)).toBeNull();
  expect(screen.queryByRole("button", { name: "Send for approval" })).toBeNull();
  expect(screen.queryByRole("textbox", { name: "Body" })).toBeNull();
});

test("a sent issue's tiles show the change from the last sent issue", async () => {
  const sent = { ...issue, state: "sent" as const, sentAt: "2026-11-10T08:00:00.000Z", stats: { recipients: 220, delivered: 200, clicks: 10, unsubscribes: 1, opens: 3 } };
  const older = { itemId: "00000000-0000-4000-8000-000000000011", slot: "2026-11-03T08:00:00.000Z", title: "Week 44", state: "sent", reason: null, sentAt: "2026-11-03T08:00:00.000Z", stats: { recipients: 200, delivered: 190, clicks: 6, unsubscribes: 3, opens: 2 } };
  const get = vi.spyOn(api, "GET").mockImplementation(((path: string) => reply(200, path.endsWith("/issues") ? { issues: [{ ...older, itemId: ID, slot: sent.slot, stats: sent.stats }, older], next: null } : sent)) as never);
  render(withQueries(<Issue workspaceId={W} itemId={ID} role="viewer" initial={sent} />));
  const tile = (label: string) => screen.getByText(label, { selector: "dt" }).parentElement!.textContent;
  await vi.waitFor(() => expect(tile("Delivered")).toBe("Delivered200of 220 sent+10 vs last issue"));
  expect(tile("Click rate")).toBe("Click rate5.0%10 clicks+1.8 points vs last issue");
  expect(tile("Unsubscribes")).toBe("Unsubscribes1-2 vs last issue");
  expect(get).toHaveBeenCalledWith("/api/w/{workspaceId}/newsletter/issues", { params: { path: { workspaceId: W }, query: {} } });
});

const settingsPage = (over: object) => ({
  settings: { list: "connected", credentialId: "k1", weekday: 2, sendTime: "09:00", timeZone: "Europe/Berlin", enabled: true, readOnlySince: null, readOnlyReason: null, lastSentAt: null },
  platforms: [{ connection: "mailchimp", name: "Mailchimp", credentialId: "k1", hasLists: true, listId: "a1", listName: "Founders" }],
  lists: [],
  nextSlot: null,
  quiet: false,
  subscriberCount: 1200,
  ...over,
});

test("the header says who the issue goes to, and its times are in the newsletter's own zone", async () => {
  const waiting = { ...issue, state: "needs_approval" as const, approveBy: "2026-11-10T06:00:00.000Z" };
  vi.spyOn(api, "GET").mockImplementation(((path: string) => reply(200, path.endsWith("/settings") ? settingsPage({}) : waiting)) as never);
  render(withQueries(<Issue workspaceId={W} itemId={ID} role="owner" initial={waiting} />));
  expect(await screen.findByText("Goes to Founders, 1,200 subscribers.")).toBeTruthy();
  expect(screen.getByText("Goes out Tuesday 10 November, 09:00 (Europe/Berlin), once someone approves it. Approve by 07:00 so it can go out at 09:00.")).toBeTruthy();
});

test("Substack has no count, so the header names only the list; a sent issue names none", async () => {
  const handed = { ...issue, state: "needs_approval" as const, handoffTo: "Substack" };
  let shown: IssueData = handed;
  vi.spyOn(api, "GET").mockImplementation(((path: string) => reply(200, path.endsWith("/settings") ? settingsPage({ settings: { ...settingsPage({}).settings, list: "substack", credentialId: null }, subscriberCount: null }) : shown)) as never);
  const { unmount } = render(withQueries(<Issue workspaceId={W} itemId={ID} role="owner" initial={handed} />));
  expect(await screen.findByText("Goes to your Substack list.")).toBeTruthy();
  unmount();
  shown = { ...handed, state: "sent", sentAt: "2026-11-10T08:00:00.000Z" };
  render(withQueries(<Issue workspaceId={W} itemId={ID} role="owner" initial={shown} />));
  expect(await screen.findByText("Went out Tuesday 10 November, 09:00 (Europe/Berlin).")).toBeTruthy();
  expect(screen.queryByText(/^Goes to/)).toBeNull();
});
