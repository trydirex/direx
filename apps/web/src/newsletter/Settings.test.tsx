// SPDX-License-Identifier: AGPL-3.0-only
// Newsletter settings load through the query layer: a loading state first, then the settings, and
// an error panel with Retry when they can't be read.
import { afterEach, expect, test, vi } from "vitest";
import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { api } from "../client";
import { choose, openDialog, pick, withQueries } from "../testing";
import type { SettingsPage } from "./actions";
import { Settings } from "./Settings";

const W = "00000000-0000-4000-8000-0000000000aa";
const reply = (status: number, body: unknown) => Promise.resolve({ ...(status < 400 ? { data: body } : { error: body }), response: new Response(null, { status }) });
const off: SettingsPage = { settings: { list: "substack", credentialId: null, weekday: 2, sendTime: "09:00", timeZone: "Europe/Berlin", enabled: false, readOnlySince: null, readOnlyReason: null, lastSentAt: null }, platforms: [], lists: [], nextSlot: null, quiet: false, subscriberCount: null };

const ISSUES = "/api/w/{workspaceId}/newsletter/issues";
/** The issue list's first page holds `list`; a request with `before` reads `older`. */
const issuesPage = (opts: { params: { query?: { before?: string } } }, list: unknown[] = [], older?: { issues: unknown[]; next: string | null }) =>
  reply(200, opts.params.query?.before ? older : { issues: list, next: older ? "older" : null });
/** GET answers the issue list from `issues` and `older`, and everything else from `other()`. */
const routed = (other: () => Promise<unknown>, issues: unknown[] = [], older?: { issues: unknown[]; next: string | null }) =>
  vi.spyOn(api, "GET").mockImplementation(((path: string, opts: never) => (path === ISSUES ? issuesPage(opts, issues, older) : other())) as never);

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

test("Settings shows a loading state, then the settings", async () => {
  routed(() => reply(200, off));
  render(withQueries(<Settings workspaceId={W} role="viewer" />));
  expect(screen.getAllByRole("status").some((s) => s.textContent === "Loading")).toBe(true);
  expect(await screen.findByText("The weekly issue is off.")).toBeTruthy();
});

test("when the settings can't be read, the page says so and Retry reads them again", async () => {
  let fail = true;
  routed(() => (fail ? reply(403, { error: "forbidden" }) : reply(200, off)));
  render(withQueries(<Settings workspaceId={W} role="viewer" />));
  expect((await screen.findByRole("alert")).textContent).toContain("Your role doesn't allow that.");
  fail = false;
  await userEvent.click(screen.getByRole("button", { name: "Retry" }));
  expect(await screen.findByText("The weekly issue is off.")).toBeTruthy();
});

const K = "00000000-0000-4000-8000-0000000000cc";
const buttondown = { connection: "buttondown", name: "Buttondown", credentialId: null, hasLists: false, listId: null, listName: null };
const kit = { connection: "kit", name: "Kit", credentialId: K, hasLists: true, listId: null, listName: null };
const at = { params: { path: { workspaceId: W } } };

/** GET answers the settings from `page()` and the account's lists from `lists()`. */
function serve(page: () => SettingsPage, lists: () => Promise<unknown> = () => reply(200, { lists: [] })) {
  vi.spyOn(api, "GET").mockImplementation(((path: string, opts: never) => (path === ISSUES ? issuesPage(opts) : path.endsWith("/lists") ? lists() : reply(200, page()))) as never);
}

test("an Owner connects a tool's key, and Direx says what the check found", async () => {
  serve(() => ({ ...off, settings: null, platforms: [buttondown] }));
  const post = vi.spyOn(api, "POST").mockImplementation((() => reply(500, { error: "unexpected" })) as never).mockImplementationOnce((() => reply(400, { error: "bad_key" })) as never);
  render(withQueries(<Settings workspaceId={W} role="owner" />));
  const key = await screen.findByLabelText("Buttondown API key");
  await userEvent.type(key, "secret-1");
  await userEvent.click(screen.getByRole("button", { name: "Connect Buttondown" }));
  expect(post).toHaveBeenCalledWith("/api/w/{workspaceId}/key-services/{connection}", { params: { path: { workspaceId: W, connection: "buttondown" } }, body: { key: "secret-1" } });
  expect((key as HTMLInputElement).value).toBe("");
  expect(await screen.findByRole("alert")).toBeTruthy();

  post.mockImplementationOnce((() => reply(200, {})) as never).mockImplementationOnce((() => reply(200, { listName: "Main", subscriberCount: 1, canSend: false })) as never);
  await userEvent.type(key, "secret-2");
  await userEvent.click(screen.getByRole("button", { name: "Connect Buttondown" }));
  expect(post).toHaveBeenLastCalledWith("/api/w/{workspaceId}/key-services/{connection}/check", { params: { path: { workspaceId: W, connection: "buttondown" } } });
  expect(await screen.findByText(/The key works\. Main has 1 subscriber\. .*needs its Pro plan\./)).toBeTruthy();

  post.mockImplementationOnce((() => reply(200, {})) as never).mockImplementationOnce((() => reply(502, { error: "unreachable" })) as never);
  await userEvent.type(key, "secret-3");
  await userEvent.click(screen.getByRole("button", { name: "Connect Buttondown" }));
  await vi.waitFor(() => expect(post).toHaveBeenCalledTimes(5));
  expect(await screen.findByRole("alert")).toBeTruthy();
});

test("a key that needs a recent sign-in asks over the form, not at the top of the page", async () => {
  serve(() => ({ ...off, settings: null, platforms: [buttondown] }));
  vi.spyOn(api, "POST").mockImplementation((() => reply(403, { error: "step_up_required" })) as never);
  render(withQueries(<Settings workspaceId={W} role="owner" />));
  await userEvent.type(await screen.findByLabelText("Buttondown API key"), "secret-1");
  await userEvent.click(screen.getByRole("button", { name: "Connect Buttondown" }));
  const dialog = await vi.waitFor(() => openDialog("Confirm it's you")!);
  expect(within(dialog).getByText(/Changing a newsletter key needs a recent sign-in/)).toBeTruthy();
  expect(screen.queryByText(/sign-in from the last 10 minutes/)).toBeNull();
});

test("an Owner picks Substack and saves the slot; a bad time zone is refused", async () => {
  serve(() => ({ ...off, platforms: [buttondown] }));
  const put = vi.spyOn(api, "PUT").mockImplementation((() => reply(500, { error: "unexpected" })) as never).mockImplementationOnce((() => reply(400, { error: "bad_time_zone" })) as never);
  render(withQueries(<Settings workspaceId={W} role="admin" />));
  await choose("Newsletter tool", "Substack (you copy and paste each issue)");
  expect(screen.queryByLabelText("Buttondown API key")).toBeNull();
  await choose("Day", "Friday");
  await choose("Time zone", "America/New_York");
  await userEvent.click(screen.getByRole("button", { name: "Save" }));
  expect(put).toHaveBeenCalledWith("/api/w/{workspaceId}/newsletter/settings", { ...at, body: { list: "substack", credentialId: null, weekday: 5, sendTime: "09:00", timeZone: "America/New_York", enabled: false } });
  expect((await screen.findByRole("alert")).textContent).toBe("That time zone isn't one we know. Try a name such as Europe/Berlin.");
  put.mockImplementationOnce((() => reply(200, { settings: off.settings })) as never);
  await userEvent.click(screen.getByRole("button", { name: "Save" }));
  expect(await screen.findByText("Saved.")).toBeTruthy();
});

test("a connected tool with several lists asks which one, and saves the choice", async () => {
  const page = { ...off, settings: { ...off.settings!, list: "connected" as const, credentialId: K, enabled: true }, platforms: [kit], nextSlot: "2026-11-10T08:00:00.000Z", quiet: true };
  serve(() => page, () => reply(200, { lists: [{ id: "l1", name: "Weekly", subscriberCount: 1200 }, { id: "l2", name: "Customers", subscriberCount: 40 }] }));
  const put = vi.spyOn(api, "PUT").mockImplementation((() => reply(500, { error: "unexpected" })) as never).mockImplementationOnce((() => reply(400, { error: "not_listed" })) as never);
  render(withQueries(<Settings workspaceId={W} role="owner" initial={page} />));
  expect(screen.getByText(/Readers forget a quiet list/)).toBeTruthy();
  expect(screen.getByText(/^Next issue: .*\(Europe\/Berlin\), to Kit\./)).toBeTruthy();
  expect(screen.getByText(/Reading your Kit lists\./)).toBeTruthy();
  const which = await screen.findByRole("combobox", { name: "Which Kit list gets the newsletter" });
  expect(screen.getByText(/No issue is made until you do\./)).toBeTruthy();
  await pick(which, "Customers (40 subscribers)");
  expect(put).toHaveBeenCalledWith("/api/w/{workspaceId}/newsletter/keys/{credentialId}/list", { params: { path: { workspaceId: W, credentialId: K } }, body: { listId: "l2" } });
  expect((await screen.findByRole("alert")).textContent).toBe("That list isn't in the account any more. Pick another.");
  put.mockImplementationOnce((() => reply(200, {})) as never);
  await pick(which, "Weekly (1,200 subscribers)");
  expect(await screen.findByText("Saved. The newsletter goes to the Kit list Weekly.")).toBeTruthy();
  put.mockImplementationOnce((() => reply(200, {})) as never);
  await userEvent.click(screen.getByRole("button", { name: "Save" }));
  expect(put).toHaveBeenLastCalledWith("/api/w/{workspaceId}/newsletter/settings", { ...at, body: { list: "connected", credentialId: K, weekday: 2, sendTime: "09:00", timeZone: "Europe/Berlin", enabled: true } });
  expect(await screen.findByText("Saved.")).toBeTruthy();
});

test("a tool with one list says so, and lists that can't be read say why", async () => {
  const page = { ...off, settings: null, platforms: [kit, { ...kit, connection: "beehiiv", name: "Beehiiv", credentialId: "k2" }] };
  let fail = false;
  serve(() => page, () => (fail ? reply(502, { error: "tool_unreachable" }) : reply(200, { lists: [{ id: "l1", name: "Weekly", subscriberCount: 3 }] })));
  render(withQueries(<Settings workspaceId={W} role="owner" initial={page} />));
  expect(await screen.findByText("Kit has one list, Weekly, so the newsletter goes there.")).toBeTruthy();
  fail = true;
  await choose("Newsletter tool", "Beehiiv");
  expect((await screen.findByRole("alert")).textContent).toBe("Direx couldn't reach the tool to read its lists. Try again in a minute.");
});

test("a read-only key and a Viewer's summary name the list", async () => {
  const page = {
    ...off,
    settings: { ...off.settings!, list: "connected" as const, credentialId: "gone", readOnlyReason: "a key with send access" },
    lists: [{ credentialId: "gone", connection: "kit", name: "Old Kit" }],
  };
  routed(() => reply(200, page));
  render(withQueries(<Settings workspaceId={W} role="viewer" initial={page} />));
  expect(screen.getByRole("alert").textContent).toContain("it needs a key with send access.");
  expect(screen.getByText("Tuesdays at 09:00 (Europe/Berlin), to Old Kit. Only an Admin or Owner can change this.")).toBeTruthy();
});

const issue = (itemId: string, state: string, title: string, slot: string) => ({ itemId, slot, title, state, reason: null, sentAt: null, stats: null });

test("Issues lists the next issue with its state, then the sent ones newest first, with older ones on Show more", async () => {
  const get = routed(
    () => reply(200, off),
    [issue("i2", "needs_approval", "Week 46", "2026-11-17T08:00:00.000Z"), { ...issue("i3", "applied", "Week 45", "2026-11-10T08:00:00.000Z"), stats: { recipients: 200, delivered: 160, clicks: 8, unsubscribes: 0, opens: 40 } }],
    { issues: [issue("i0", "cancelled", "Skipped", "2026-11-05T08:00:00.000Z"), issue("i1", "sent", "Week 44", "2026-11-03T08:00:00.000Z")], next: null },
  );
  render(withQueries(<Settings workspaceId={W} role="viewer" initial={off} />));
  const issues = within(screen.getByRole("region", { name: "Issues" }));
  const next = await issues.findByRole("link", { name: "Week 46" });
  expect(next.getAttribute("href")).toBe(`/w/${W}/newsletter/i2`);
  expect(issues.getByText("Needs approval")).toBeTruthy();
  expect(issues.getByText("Goes out Tue 17 Nov")).toBeTruthy();
  expect(issues.getByText("Sent Tue 10 Nov")).toBeTruthy();
  expect(issues.getByText("5.0% clicked")).toBeTruthy();
  await userEvent.click(issues.getByRole("button", { name: "Show more" }));
  expect(await issues.findByText("Sent Tue 3 Nov")).toBeTruthy();
  expect(issues.getAllByRole("link").map((a) => a.textContent)).toEqual(["Week 46", "Week 45", "Week 44"]);
  expect(issues.queryByRole("button", { name: "Show more" })).toBeNull();
  expect(get).toHaveBeenCalledWith(ISSUES, { params: { path: { workspaceId: W }, query: { before: "older" } } });
});

test("with no issues yet, Issues says when the first appears", async () => {
  routed(() => reply(200, off));
  render(withQueries(<Settings workspaceId={W} role="viewer" initial={off} />));
  expect(await screen.findByText("No issues yet")).toBeTruthy();
});

test("settings fold under a disclosure, open only until the newsletter is set up", () => {
  routed(() => reply(200, off));
  const { unmount } = render(withQueries(<Settings workspaceId={W} role="owner" initial={off} />));
  const summary = screen.getByText("Where and when it sends");
  expect((summary.closest("details") as HTMLDetailsElement).open).toBe(false);
  unmount();
  render(withQueries(<Settings workspaceId={W} role="owner" initial={{ ...off, settings: null }} />));
  expect((screen.getByText("Where and when it sends").closest("details") as HTMLDetailsElement).open).toBe(true);
});

test("before set up, the time zone is the browser's, picked from a list; the steps are numbered", () => {
  routed(() => reply(200, off));
  render(withQueries(<Settings workspaceId={W} role="owner" initial={{ ...off, settings: null }} />));
  const zone = screen.getByRole("combobox", { name: "Time zone" });
  expect(zone.textContent).toContain(Intl.DateTimeFormat().resolvedOptions().timeZone);
  const steps = screen.getByRole("region", { name: "Set up" }).querySelector("ol")!;
  expect(steps.children.length).toBe(2);
});

test("once set up, the weekly switch saves on its own, and a refusal turns it back", async () => {
  routed(() => reply(200, off));
  const put = vi.spyOn(api, "PUT").mockImplementationOnce((() => reply(400, { error: "bad_time_zone" })) as never);
  render(withQueries(<Settings workspaceId={W} role="owner" initial={off} />));
  const toggle = screen.getByRole("switch", { name: "Send a weekly issue" }) as HTMLInputElement;
  expect(toggle.checked).toBe(false);
  await userEvent.click(toggle);
  expect(put).toHaveBeenLastCalledWith("/api/w/{workspaceId}/newsletter/settings", { ...at, body: { list: "substack", credentialId: null, weekday: 2, sendTime: "09:00", timeZone: "Europe/Berlin", enabled: true } });
  expect((await screen.findByRole("alert")).textContent).toBe("That time zone isn't one we know. Try a name such as Europe/Berlin.");
  await vi.waitFor(() => expect(toggle.checked).toBe(false));
  put.mockImplementationOnce((() => reply(200, { settings: off.settings })) as never);
  await userEvent.click(toggle);
  expect(await screen.findByText("Saved.")).toBeTruthy();
  expect(toggle.checked).toBe(true);
});

test("a connected tool's key is replaced, checked or disconnected here, its one place", async () => {
  const page = { ...off, settings: null, platforms: [{ ...kit, hasLists: false }] };
  vi.spyOn(api, "GET").mockImplementation(((path: string, opts: never) =>
    path === ISSUES
      ? issuesPage(opts)
      : path === "/api/w/{workspaceId}/credentials"
        ? reply(200, { credentials: [{ id: K, name: "Kit", connection: "kit", kind: "api_key", scope: "workspace", status: "active", ownerUserId: null }] })
        : reply(200, page)) as never);
  render(withQueries(<Settings workspaceId={W} role="owner" />));
  const key = await screen.findByRole("region", { name: "Kit" });
  expect(within(key).getByText("Connected")).toBeTruthy();
  expect(within(key).getByRole("button", { name: "Replace Kit" })).toBeTruthy();
  expect(within(key).getByRole("button", { name: "Check the Kit key" })).toBeTruthy();
  expect(within(key).getByRole("button", { name: "Disconnect Kit" })).toBeTruthy();
});
