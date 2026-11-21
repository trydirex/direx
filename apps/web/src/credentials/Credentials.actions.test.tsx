// SPDX-License-Identifier: AGPL-3.0-only
// What a person does on the Credentials page: connect a Mailbox, check it again, look at its history,
// save, replace, check and remove keys and credentials. Each action makes one call, then the page
// says how it went and reads the lists again.
import { afterEach, expect, test, vi } from "vitest";
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { api } from "../client";
import { withQueries, choose } from "../testing";
import { Credentials, type Tab } from "./Credentials";
import { PROBE_WORDING_VERSION } from "./actions";

const W = "00000000-0000-4000-8000-0000000000aa";
const ME = "00000000-0000-4000-8000-000000000001";
const workspace = { id: W, name: "Shop", role: "owner" as const, organization: { id: "o", name: "Acme" } };
const reply = (status: number, body: unknown) => Promise.resolve({ ...(status < 400 ? { data: body } : { error: body }), response: new Response(null, { status }) });
const ok = () => reply(200, {});
const refused = (error: string, detail?: string) => reply(400, { error, ...(detail ? { detail } : {}) });
const cred = (over: Record<string, unknown>) => ({ scope: "user", kind: "oauth2", ownerUserId: ME, connection: null, status: "active", lastUsedAt: null, version: 3, ...over });

const google = { connection: "google", label: "Connect Google", connect: "oauth" };
const imap = {
  connection: "imap_smtp",
  label: "Connect another provider",
  connect: "form",
  fields: [
    { name: "host", label: "Mail server" },
    { name: "nick", label: "Nickname", optional: true },
  ],
  presets: [{ label: "Fastmail", values: { host: "imap.fastmail.com" } }],
};
const checker = { connection: "checker", name: "Checker", canCheck: true };
const lists = { connection: "lists", name: "Lists", canCheck: true };

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

/** Every list the page reads, changeable between calls so a test can see the page read them again. */
function serve(data: { credentials?: unknown[]; providers?: unknown[]; existingProviders?: unknown[]; services?: unknown[]; checks?: unknown[]; events?: () => Promise<unknown> }) {
  const get = vi.spyOn(api, "GET").mockImplementation(((path: string, options?: { params?: { query?: { purpose?: string } } }) => {
    if (path === "/api/w/{workspaceId}/credentials") return reply(200, { credentials: data.credentials ?? [] });
    if (path === "/api/w/{workspaceId}/mailbox-providers") return reply(200, { providers: (options?.params?.query?.purpose === "existing" ? data.existingProviders ?? data.providers : data.providers) ?? [] });
    if (path === "/api/w/{workspaceId}/key-services") return reply(200, { services: data.services ?? [] });
    if (path === "/api/w/{workspaceId}/outreach/mailbox-pauses") return reply(200, { pauses: [] });
    if (path === "/api/w/{workspaceId}/outreach/mailbox-checks") return reply(200, { checks: data.checks ?? [] });
    if (path === "/api/w/{workspaceId}/social/networks") return reply(200, { networks: [{ connection: "linkedin" }] });
    if (path === "/api/w/{workspaceId}/credentials/{id}/events") return data.events?.() ?? reply(200, { events: [] });
    return reply(404, { error: "not_found" });
  }) as never);
  return { get, data };
}
const reads = (get: ReturnType<typeof serve>["get"], path: string) => (get.mock.calls as unknown as [string][]).filter(([p]) => p === path).length;
const open = (tab: Tab = "mailboxes") => render(withQueries(<Credentials workspace={workspace} me={ME} tab={tab} />));

test("an OAuth provider sends the browser to its consent page, and a refusal is said on the page", async () => {
  serve({ providers: [google] });
  const assign = vi.spyOn(window.location, "assign").mockImplementation(() => {});
  const post = vi.spyOn(api, "POST").mockImplementationOnce((() => reply(200, { url: "https://accounts.example/consent" })) as never);
  open();
  await userEvent.click(await screen.findByRole("button", { name: "Connect Google" }));
  expect(post).toHaveBeenLastCalledWith("/api/w/{workspaceId}/connections/{connection}/start", { params: { path: { workspaceId: W, connection: "google" } } });
  expect(assign).toHaveBeenCalledWith("https://accounts.example/consent");

  post.mockImplementationOnce((() => refused("unknown_connection")) as never);
  await userEvent.click(screen.getByRole("button", { name: "Connect Google" }));
  expect((await screen.findByRole("alert")).textContent).toBe("Direx isn't set up to connect that provider.");
  expect(assign).toHaveBeenCalledTimes(1);
});

test("the Mailbox form signs in with a preset, says what the check found, and reads the Mailboxes again", async () => {
  const { get, data } = serve({ providers: [imap] });
  const post = vi.spyOn(api, "POST").mockImplementation((() => reply(200, { hasSent: false, check: { state: "failed", reason: "provider_refused" } })) as never);
  open();
  const toggle = await screen.findByRole("button", { name: "Connect another provider" });
  expect(toggle.getAttribute("aria-expanded")).toBe("false");
  await userEvent.click(toggle);
  expect(toggle.getAttribute("aria-expanded")).toBe("true");

  await choose("Mail service", "Fastmail");
  expect((screen.getByLabelText("Mail server") as HTMLInputElement).value).toBe("imap.fastmail.com");
  await userEvent.type(screen.getByLabelText("Sign-in name, usually your email address"), "me@example.com");
  expect(screen.getByText(/Direx sends one test email to me@example.com/)).toBeTruthy();
  await userEvent.type(screen.getByLabelText("Nickname"), "Work");
  await userEvent.type(screen.getByLabelText("App password"), "app-pw");
  data.credentials = [cred({ id: "m1", name: "me@example.com", connection: "imap_smtp" })];
  const before = reads(get, "/api/w/{workspaceId}/credentials");
  await userEvent.click(screen.getByRole("button", { name: "Sign in and save" }));

  expect(post).toHaveBeenLastCalledWith("/api/w/{workspaceId}/mailboxes/{connection}", {
    params: { path: { workspaceId: W, connection: "imap_smtp" } },
    body: { username: "me@example.com", password: "app-pw", settings: { host: "imap.fastmail.com", nick: "Work" }, probeWording: PROBE_WORDING_VERSION },
  });
  expect(
    (await screen.findByText(/^Connected\./)).textContent,
  ).toBe("Connected. We couldn't find a Sent folder, so if a send is ever cut off, you'll be asked to check it yourself. The test email couldn't be sent: your provider refused it");
  expect((screen.getByLabelText("App password") as HTMLInputElement).value).toBe("");
  expect(await screen.findByRole("listitem", { name: "me@example.com" })).toBeTruthy();
  expect(reads(get, "/api/w/{workspaceId}/credentials")).toBeGreaterThan(before);

  // A sign-in the mail server refused keeps the password and says the server's reason, or the code's words.
  post.mockImplementationOnce((() => refused("sign_in_failed", "SMTP 535")) as never);
  await userEvent.type(screen.getByLabelText("App password"), "wrong");
  await userEvent.click(screen.getByRole("button", { name: "Sign in and save" }));
  expect(await screen.findByText("Nothing was saved. SMTP 535")).toBeTruthy();
  expect((screen.getByLabelText("App password") as HTMLInputElement).value).toBe("wrong");
  post.mockImplementationOnce((() => refused("stale_wording")) as never);
  await userEvent.click(screen.getByRole("button", { name: "Sign in and save" }));
  expect(await screen.findByText("This page is out of date. Reload it and try again.")).toBeTruthy();

  // A check that has not run yet, and a check with no reason.
  post.mockImplementationOnce((() => reply(200, { hasSent: true, check: null })) as never);
  await userEvent.click(screen.getByRole("button", { name: "Sign in and save" }));
  expect(await screen.findByText("Connected. Not checked yet. Cold email from it waits.")).toBeTruthy();
  post.mockImplementationOnce((() => reply(200, { hasSent: true, check: { state: "failed", reason: null } })) as never);
  await userEvent.type(screen.getByLabelText("App password"), "pw");
  await userEvent.click(screen.getByRole("button", { name: "Sign in and save" }));
  expect(await screen.findByText("Connected. The test email couldn't be sent.")).toBeTruthy();

  await userEvent.click(toggle);
  expect(toggle.getAttribute("aria-expanded")).toBe("false");
  expect(screen.queryByLabelText("App password")).toBeNull();
});

test("Check again sends a new test email, and the daily limit is said when it is reached", async () => {
  const mailbox = (id: string, name: string) => cred({ id, name, connection: "google" });
  const { data } = serve({
    providers: [google],
    credentials: [mailbox("m1", "a@example.com"), mailbox("m2", "b@example.com")],
    checks: [{ credentialId: "m1", state: "unchecked", reason: "sender_identity_missing", failures: [], warnings: ["text_added", "not_a_known_warning"], checkedAt: "2026-11-01T00:00:00.000Z" }],
  });
  const post = vi.spyOn(api, "POST").mockImplementation(ok as never);
  open();
  expect(await screen.findByText("2 email accounts haven't passed the unsubscribe check, so no cold email goes from them yet. Press Check again on each card below. If one fails again, the line under it says what to fix.")).toBeTruthy();
  expect(screen.getByText(/Add your sender name and postal address, then check again\./)).toBeTruthy();
  expect(screen.getByText("Your provider adds its own text to every email.").closest("details")!.open).toBe(false);

  data.checks = [{ credentialId: "m1", state: "pending", reason: null, failures: [], warnings: [], checkedAt: "2026-11-09T00:00:00.000Z" }];
  await userEvent.click(screen.getAllByRole("button", { name: "Check again: a@example.com" })[0]!);
  expect(post).toHaveBeenLastCalledWith("/api/w/{workspaceId}/mailboxes/{credentialId}/check", { params: { path: { workspaceId: W, credentialId: "m1" } }, body: { probeWording: PROBE_WORDING_VERSION } });
  expect(await screen.findByText("Checking unsubscribe links")).toBeTruthy();
  // The pending Mailbox has no button now; only the unchecked one does.
  const again = screen.getAllByRole("button", { name: /^Check again/ });
  expect(again).toHaveLength(1);

  post.mockImplementationOnce((() => refused("daily_limit")) as never);
  await userEvent.click(again[0]!);
  expect(post).toHaveBeenLastCalledWith("/api/w/{workspaceId}/mailboxes/{credentialId}/check", { params: { path: { workspaceId: W, credentialId: "m2" } }, body: { probeWording: PROBE_WORDING_VERSION } });
  expect((await screen.findByRole("alert")).textContent).toBe("You can check an email account five times a day.");
});

test("History opens and closes a Mailbox's access log, and a refusal to read it is said", async () => {
  let events = () => reply(200, { events: [{ at: "2026-11-01T10:00:00.000Z", consumer: "outreach", outcome: "denied", errorCode: "revoked", actionId: null, actorUserId: null }] });
  serve({ providers: [google], credentials: [cred({ id: "m1", name: "a@example.com", connection: "google" })], events: () => events() });
  const get = vi.mocked(api.GET);
  open();
  const button = await screen.findByRole("button", { name: "History of a@example.com" });
  expect(screen.getByText("1 email account hasn't passed the unsubscribe check, so no cold email goes from it yet. Press Check again on its card below. If it fails again, the line under it says what to fix.")).toBeTruthy();
  await userEvent.click(button);
  expect(get).toHaveBeenCalledWith("/api/w/{workspaceId}/credentials/{id}/events", { params: { path: { workspaceId: W, id: "m1" } } });
  expect(await screen.findByText(/outreach, denied \(revoked\)/)).toBeTruthy();
  expect(button.getAttribute("aria-expanded")).toBe("true");
  await userEvent.click(screen.getByRole("button", { name: "Hide history of a@example.com" }));
  expect(screen.queryByText(/outreach, denied/)).toBeNull();

  events = () => refused("missing");
  await userEvent.click(screen.getByRole("button", { name: "History of a@example.com" }));
  expect((await screen.findByRole("alert")).textContent).toBe("We couldn't find that credential. It may have been removed.");
});

test("Disconnect removes a Mailbox and reads the list again; a stale sign-in asks to sign in again", async () => {
  const { data } = serve({ providers: [google], credentials: [cred({ id: "m1", name: "a@example.com", connection: "google" }), cred({ id: "m2", name: "b@example.com", connection: "google" })] });
  const del = vi.spyOn(api, "DELETE").mockImplementationOnce((() => {
    data.credentials = data.credentials!.slice(1);
    return ok();
  }) as never);
  open();
  await userEvent.click((await screen.findAllByRole("button", { name: "Disconnect a@example.com" }))[0]!);
  await userEvent.click(await screen.findByRole("button", { name: "Disconnect" }));
  expect(del).toHaveBeenLastCalledWith("/api/w/{workspaceId}/credentials/{id}", { params: { path: { workspaceId: W, id: "m1" } } });
  await waitFor(() => expect(screen.queryByText("a@example.com")).toBeNull());
  expect(screen.getByText("b@example.com")).toBeTruthy();

  del.mockImplementationOnce((() => refused("step_up_required")) as never);
  await userEvent.click(screen.getByRole("button", { name: "Disconnect b@example.com" }));
  await userEvent.click(await screen.findByRole("button", { name: "Disconnect" }));
  expect(await screen.findByText("Confirm it's you")).toBeTruthy();
  expect(screen.getByText(/Changing a Workspace credential needs a recent sign-in/)).toBeTruthy();
});

test("a service key is connected, replaced, checked and disconnected by an Owner", async () => {
  const saved = cred({ id: "k1", name: "Checker key", scope: "workspace", kind: "api_key", connection: "checker" });
  const { data } = serve({ services: [checker, lists], credentials: [saved] });
  const post = vi.spyOn(api, "POST").mockImplementation(ok as never);
  const put = vi.spyOn(api, "PUT").mockImplementation(ok as never);
  const del = vi.spyOn(api, "DELETE").mockImplementation(ok as never);
  open("workspace");
  const lists$ = within(await screen.findByRole("region", { name: "Lists" }));
  const checker$ = within(screen.getByRole("region", { name: "Checker" }));
  expect(lists$.getByText("Not connected")).toBeTruthy();
  expect(checker$.getByText("Connected")).toBeTruthy();

  await userEvent.type(lists$.getByLabelText("API key"), "lists-key");
  data.credentials = [saved, cred({ id: "k2", name: "Lists key", scope: "workspace", kind: "api_key", connection: "lists" })];
  await userEvent.click(lists$.getByRole("button", { name: "Connect Lists" }));
  expect(post).toHaveBeenLastCalledWith("/api/w/{workspaceId}/key-services/{connection}", { params: { path: { workspaceId: W, connection: "lists" } }, body: { key: "lists-key" } });
  expect(await lists$.findByText("Connected")).toBeTruthy();

  put.mockImplementationOnce((() => refused("check_failed")) as never);
  await userEvent.type(checker$.getByLabelText("New API key"), "bad-key");
  await userEvent.click(checker$.getByRole("button", { name: "Replace Checker" }));
  expect(put).toHaveBeenLastCalledWith("/api/w/{workspaceId}/key-services/{connection}", { params: { path: { workspaceId: W, connection: "checker" } }, body: { key: "bad-key" } });
  expect((await screen.findByRole("alert")).textContent).toBe("The service didn't accept the key, or couldn't be reached. Nothing was saved. Check the key and try again.");
  expect((checker$.getByLabelText("New API key") as HTMLInputElement).value).toBe("");

  post.mockImplementationOnce((() => reply(200, { remainingCredits: 42 })) as never);
  await userEvent.click(checker$.getByRole("button", { name: "Check the Checker key" }));
  expect(post).toHaveBeenLastCalledWith("/api/w/{workspaceId}/key-services/{connection}/check", { params: { path: { workspaceId: W, connection: "checker" } } });
  expect(await screen.findByText("The key works. Checker says 42 checks are left.")).toBeTruthy();
  post.mockImplementationOnce((() => refused("check_failed")) as never);
  await userEvent.click(checker$.getByRole("button", { name: "Check the Checker key" }));
  expect(await checker$.findByText(/The service didn't accept the key/, { selector: "[role=status]" })).toBeTruthy();

  data.credentials = [saved];
  await userEvent.click(lists$.getByRole("button", { name: "Disconnect Lists" }));
  await userEvent.click(await screen.findByRole("button", { name: "Disconnect" }));
  expect(del).toHaveBeenLastCalledWith("/api/w/{workspaceId}/credentials/{id}", { params: { path: { workspaceId: W, id: "k2" } } });
  expect(await lists$.findByText("Not connected")).toBeTruthy();
  // A change that worked clears the refusal shown earlier.
  expect(screen.queryByRole("alert")).toBeNull();
});

test("Replace sends a Workspace credential's new value with the version it was read at", async () => {
  serve({ credentials: [cred({ id: "w1", name: "CRM", scope: "workspace", kind: "header", ownerUserId: "someone-else" })] });
  const put = vi.spyOn(api, "PUT").mockImplementationOnce((() => refused("stale_version")) as never);
  open("workspace");
  await userEvent.type(await screen.findByLabelText("New header value"), "Bearer new");
  await userEvent.click(screen.getByRole("button", { name: "Replace CRM" }));
  expect(put).toHaveBeenLastCalledWith("/api/w/{workspaceId}/credentials/{id}/value", { params: { path: { workspaceId: W, id: "w1" } }, body: { version: 3, value: { value: "Bearer new" } } });
  expect((await screen.findByRole("alert")).textContent).toBe("Someone changed this credential while you were editing. Reload and try again.");
  expect((screen.getByLabelText("New header value") as HTMLInputElement).value).toBe("");
});

test("adding a Workspace credential posts its plain field and value, then clears the form", async () => {
  const { data } = serve({});
  const post = vi.spyOn(api, "POST").mockImplementationOnce((() => refused("duplicate_key")) as never);
  open("workspace");
  const form = within(await screen.findByRole("form", { name: "Add a Workspace credential" }));
  await choose("Kind", "Request header", form);
  await userEvent.type(form.getByLabelText("Name"), "CRM");
  await userEvent.type(form.getByLabelText("Reference"), "crm.token");
  await userEvent.type(form.getByLabelText("Header name"), "Authorization");
  await userEvent.type(form.getByLabelText("Header value"), "Bearer one");
  await userEvent.click(form.getByRole("button", { name: "Save" }));
  const body = { scope: "workspace", kind: "header", key: "crm.token", name: "CRM", meta: { headerName: "Authorization" }, value: { value: "Bearer one" } };
  expect(post).toHaveBeenLastCalledWith("/api/w/{workspaceId}/credentials", { params: { path: { workspaceId: W } }, body });
  expect((await screen.findByRole("alert")).textContent).toBe("That key is already in use here. Pick another.");
  // A refusal keeps what was typed, except the value.
  expect((form.getByLabelText("Name") as HTMLInputElement).value).toBe("CRM");
  expect((form.getByLabelText("Header value") as HTMLInputElement).value).toBe("");

  post.mockImplementationOnce(ok as never);
  data.credentials = [cred({ id: "w1", name: "CRM", scope: "workspace", kind: "header" })];
  await userEvent.type(form.getByLabelText("Header value"), "Bearer two");
  await userEvent.click(form.getByRole("button", { name: "Save" }));
  expect(post).toHaveBeenLastCalledWith("/api/w/{workspaceId}/credentials", { params: { path: { workspaceId: W } }, body: { ...body, value: { value: "Bearer two" } } });
  expect(await screen.findByText("CRM", { selector: "td" })).toBeTruthy();
  expect((form.getByLabelText("Name") as HTMLInputElement).value).toBe("");
  expect(form.getByRole("combobox", { name: "Kind" }).textContent).toContain("API key");
  expect(screen.queryByRole("alert")).toBeNull();
});

test("my own credential is added with my scope, under the closed Advanced: API keys", async () => {
  const { data } = serve({});
  const post = vi.spyOn(api, "POST").mockImplementationOnce((() => {
    data.credentials = [cred({ id: "u1", name: "My key", kind: "api_key" })];
    return ok();
  }) as never);
  open();
  const advanced = screen.getByText("Advanced: API keys").closest("details")!;
  expect(advanced.open).toBe(false);
  await userEvent.click(screen.getByText("Advanced: API keys"));
  expect(advanced.open).toBe(true);
  const form = within(await screen.findByRole("form", { name: "Add a credential" }));
  await userEvent.type(form.getByLabelText("Name"), "My key");
  await userEvent.type(form.getByLabelText("Reference"), "my_key");
  await userEvent.type(form.getByLabelText("Key"), "k-123");
  await userEvent.click(form.getByRole("button", { name: "Save" }));
  expect(post).toHaveBeenLastCalledWith("/api/w/{workspaceId}/credentials", {
    params: { path: { workspaceId: W } },
    body: { scope: "user", kind: "api_key", key: "my_key", name: "My key", meta: {}, value: { key: "k-123" } },
  });
  expect(await screen.findByText("My key", { selector: "td" })).toBeTruthy();
});

test("each credential's buttons name the credential, so two rows can be told apart", async () => {
  serve({ providers: [google], credentials: [cred({ id: "m1", name: "a@example.com", connection: "google" }), cred({ id: "m2", name: "b@example.com", connection: "google" })] });
  open();
  expect(await screen.findByRole("button", { name: "Disconnect a@example.com" })).toBeTruthy();
  expect(screen.getByRole("button", { name: "Disconnect b@example.com" })).toBeTruthy();
  expect(screen.getByRole("button", { name: "Check again: a@example.com" })).toBeTruthy();
  expect(screen.getByRole("button", { name: "Check again: b@example.com" })).toBeTruthy();
});

test("a credentials table has a header row naming each column", async () => {
  serve({ credentials: [cred({ id: "w1", name: "CRM", scope: "workspace", kind: "header" })] });
  open("workspace");
  await screen.findByText("CRM");
  expect(screen.getAllByRole("columnheader").map((h) => h.textContent)).toEqual(["Name", "Type", "Status", "Last used", "Actions"]);
});

test("each email account shows one line with its check, pace and latest Placement check, and the rest under a closed Details", async () => {
  const { get } = serve({ providers: [google], credentials: [cred({ id: "m1", name: "a@example.com", connection: "google" })], checks: [{ credentialId: "m1", state: "passed", reason: null, failures: [], warnings: [], checkedAt: "2026-11-01T00:00:00.000Z" }] });
  const pace = { pace: { dailyLimit: 40, sendFrom: 540, sendUntil: 1020, sendWeekends: false }, timeZone: "Europe/Berlin" };
  const week = { week: "2026-W49", plain: { sent: 4, counted: 4, verdicts: [{ verdict: "primary", reports: 3 }], note: null }, content: { sent: 0, counted: 0, verdicts: [], note: "none" }, difference: [] };
  const before = get.getMockImplementation()!;
  get.mockImplementation(((path: string, init: unknown) => {
    if (path === "/api/w/{workspaceId}/mailboxes/{credentialId}/pace") return reply(200, pace);
    if (path === "/api/w/{workspaceId}/mailboxes/{credentialId}/placement/results") return reply(200, { bootstrap: false, bootstrapNote: null, weeks: [week], reportsSent: [] });
    return (before as (...a: unknown[]) => unknown)(path, init);
  }) as never);
  open();
  expect(await screen.findByText("Up to 40 a day")).toBeTruthy();
  expect(await screen.findByText("Latest Placement check, Week 49, 2026: Primary")).toBeTruthy();
  expect(screen.getByText("Unsubscribe check passed")).toBeTruthy();
  const details = screen.getByLabelText("Details: a@example.com").closest("details")!;
  expect(details.open).toBe(false);
  expect(details.textContent).toContain("Sends up to 40 a day");
  expect(within(details).getByRole("region", { name: "Placement checks: a@example.com" })).toBeTruthy();
});

test("a key tab in the address opens Advanced: API keys, and closing it says so", async () => {
  serve({});
  const onTab = vi.fn();
  render(withQueries(<Credentials workspace={workspace} me={ME} tab="workspace" onTab={onTab} />));
  const advanced = screen.getByText("Advanced: API keys").closest("details")!;
  expect(advanced.open).toBe(true);
  expect(within(advanced).getByRole("heading", { name: "Shared with the team" })).toBeTruthy();
  await userEvent.click(screen.getByText("Advanced: API keys"));
  await vi.waitFor(() => expect(onTab).toHaveBeenLastCalledWith("mailboxes"));
});

test("a newsletter tool's key isn't set up here: Email and keys points to the Newsletter page", async () => {
  const { get } = serve({ services: [checker, lists] });
  const real = get.getMockImplementation() as unknown as (path: string) => unknown;
  get.mockImplementation(((path: string) =>
    path === "/api/w/{workspaceId}/newsletter/settings" ? reply(200, { platforms: [{ connection: "lists", name: "Lists" }] }) : real(path)) as never);
  open("workspace");
  expect(await screen.findByRole("region", { name: "Checker" })).toBeTruthy();
  const link = await screen.findByRole("link", { name: "Newsletter page" });
  expect(link.getAttribute("href")).toBe(`/w/${W}/newsletter`);
  expect(link.parentElement!.textContent).toBe("Lists: set up on the Newsletter page.");
  expect(screen.queryByRole("region", { name: "Lists" })).toBeNull();
});

test("each email account is a card with its name, its state and its own buttons", async () => {
  serve({ providers: [google], credentials: [cred({ id: "m1", name: "a@example.com", connection: "google", status: "needs_reauth" }), cred({ id: "m2", name: "b@example.com", connection: "google" })] });
  open();
  const a = within(await screen.findByRole("listitem", { name: "a@example.com" }));
  expect(a.getByText("Reconnect needed")).toBeTruthy();
  expect(a.getByRole("button", { name: "Disconnect a@example.com" })).toBeTruthy();
  expect(a.queryByRole("button", { name: "Disconnect b@example.com" })).toBeNull();
  expect(screen.queryByRole("table")).toBeNull();
});

test("stored Gmail retains mailbox controls when Google connections are unavailable", async () => {
  serve({ providers: [], existingProviders: [google], credentials: [cred({ id: "m1", name: "stored@example.com", connection: "google", ownerUserId: "another-member" })] });
  open();
  expect(await screen.findByRole("button", { name: "Check again: stored@example.com" })).toBeTruthy();
  expect(screen.getByRole("button", { name: "History of stored@example.com" })).toBeTruthy();
  expect(screen.queryByRole("button", { name: "Connect Google" })).toBeNull();
});

// Gmail's own Google app: who may set it, the steps, the reconnect warning, and change and remove.
const gmailApp = { id: "a1", scope: "workspace", kind: "basic", ownerUserId: null, connection: null, key: "oauth_app:google", name: "Gmail app", meta: { username: "own-id.apps.googleusercontent.com" }, status: "active", lastUsedAt: null, version: 1 };
const gmailAccount = (id: string) => cred({ id, name: `${id}@shop.example`, connection: "google" });
const as = (role: "owner" | "admin" | "marketer" | "viewer") => render(withQueries(<Credentials workspace={{ ...workspace, role }} me={ME} tab="mailboxes" />));
async function fillWizard(title: string) {
  const summary = await screen.findByText(title);
  await userEvent.click(summary);
  const wizard = within(summary.closest("details")!);
  await userEvent.type(wizard.getByLabelText("Client ID"), "new-id.apps.googleusercontent.com");
  await userEvent.type(wizard.getByLabelText("Client secret"), "new-secret");
  await userEvent.click(wizard.getByRole("button", { name: "Save" }));
}
const confirmBox = () => screen.getByRole("region", { name: "Gmail accounts to reconnect" });

test("Owners and Admins see Use your own Google app next to Connect Gmail, and Marketers don't", async () => {
  serve({ providers: [{ ...google, app: "system" }] });
  for (const role of ["owner", "admin"] as const) {
    as(role);
    await screen.findByRole("button", { name: "Connect Google" });
    expect(screen.getByText("Use your own Google app")).toBeTruthy();
    cleanup();
  }
  as("marketer");
  await screen.findByRole("button", { name: "Connect Google" });
  expect(screen.queryByText("Use your own Google app")).toBeNull();
  expect(screen.queryByText(/can't connect/)).toBeNull();
});

test("with no Google app at all, a Viewer is told why Gmail can't connect, and only an Owner gets the link", async () => {
  serve({ providers: [] });
  as("viewer");
  expect(await screen.findByText("Gmail can't connect until an Owner or Admin sets up a Google app.")).toBeTruthy();
  expect(screen.queryByText("Use your own Google app")).toBeNull();
  cleanup();
  as("owner");
  expect(await screen.findByText("Gmail can't connect until a Google app is set up.")).toBeTruthy();
  expect(screen.getByText("Use your own Google app")).toBeTruthy();
});

test("the wizard shows Gmail's steps and the callback URL, and saves the Workspace's own app without a warning when no Gmail account is connected", async () => {
  serve({ providers: [{ ...google, app: "system" }] });
  const post = vi.spyOn(api, "POST").mockImplementation(ok as never);
  as("owner");
  await userEvent.click(await screen.findByText("Use your own Google app"));
  expect(screen.getByText("Turn on the Gmail API for that project.")).toBeTruthy();
  expect(screen.getByText(/Never leave it in Testing/)).toBeTruthy();
  expect(screen.getByText(`${location.origin}/api/connections/callback`)).toBeTruthy();
  await fillWizard("Use your own Google app");
  await waitFor(() =>
    expect(post).toHaveBeenCalledWith("/api/w/{workspaceId}/credentials", {
      params: { path: { workspaceId: W } },
      body: { scope: "workspace", kind: "basic", key: "oauth_app:google", name: "Gmail app", meta: { username: "new-id.apps.googleusercontent.com" }, value: { password: "new-secret" } },
    }),
  );
  expect(screen.queryByText(/will need reconnecting/)).toBeNull();
});

test("with Gmail accounts connected, saving says how many will need reconnecting, and Cancel saves nothing", async () => {
  serve({ providers: [google], existingProviders: [google], credentials: [gmailAccount("ana"), gmailAccount("ben")] });
  const post = vi.spyOn(api, "POST").mockImplementation(ok as never);
  as("admin");
  await fillWizard("Use your own Google app");
  expect(within(confirmBox()).getByRole("status").textContent).toBe("Your 2 Gmail accounts will need reconnecting once. Until each one is, its scheduled email waits.");
  expect(post).not.toHaveBeenCalled();
  await userEvent.click(within(confirmBox()).getByRole("button", { name: "Cancel" }));
  expect(screen.queryByRole("region", { name: "Gmail accounts to reconnect" })).toBeNull();
  expect(post).not.toHaveBeenCalled();

  await fillWizard("Use your own Google app");
  await userEvent.click(within(confirmBox()).getByRole("button", { name: "Save" }));
  await waitFor(() => expect(post).toHaveBeenCalledTimes(1));
  expect((post.mock.calls[0] as unknown as [string, { body: { key: string } }])[1].body.key).toBe("oauth_app:google");
});

test("with its own app, Gmail says so and still offers Connect when the server has no app; the secret is never shown", async () => {
  serve({ providers: [{ ...google, app: "own" }], credentials: [gmailApp] });
  as("marketer");
  expect(await screen.findByText("Gmail connects through your own Google app. Client ID: own-id.apps.googleusercontent.com")).toBeTruthy();
  expect(screen.getByRole("button", { name: "Connect Google" })).toBeTruthy();
  expect(screen.queryByRole("button", { name: "Remove your own Google app" })).toBeNull();
  expect(screen.queryByText("Change")).toBeNull();
});

test("a Gmail account already waiting to reconnect isn't counted again, and the page says it can reconnect once an app is set", async () => {
  serve({ providers: [], existingProviders: [google], credentials: [{ ...gmailAccount("cy"), status: "needs_reauth" }] });
  const post = vi.spyOn(api, "POST").mockImplementation(ok as never);
  as("owner");
  expect(await screen.findByText("Your Gmail account that needs reconnecting can reconnect once one is.")).toBeTruthy();
  // No working account would newly need reconnecting, so Save goes straight through.
  await fillWizard("Use your own Google app");
  await waitFor(() => expect(post).toHaveBeenCalledTimes(1));
  expect(screen.queryByRole("region", { name: "Gmail accounts to reconnect" })).toBeNull();
});

test("deleting the Gmail app under Advanced says Gmail falls back and its accounts reconnect", async () => {
  serve({ providers: [{ ...google, app: "own" }], existingProviders: [google], credentials: [gmailApp, gmailAccount("ana")] });
  as("owner");
  await userEvent.click(await screen.findByText("Advanced: API keys"));
  await userEvent.click(await screen.findByRole("button", { name: "Delete Gmail app" }));
  expect(await screen.findByText("Gmail falls back to the server's Google app, if there is one, and each Gmail account needs reconnecting once. Until each one is, its scheduled email waits.")).toBeTruthy();
});

test("Remove warns about the Gmail account, deletes the own app, and then says Gmail can't connect until an app is set", async () => {
  const { data } = serve({ providers: [{ ...google, app: "own" }], existingProviders: [google], credentials: [gmailApp, gmailAccount("ana")] });
  const del = vi.spyOn(api, "DELETE").mockImplementation(ok as never);
  as("owner");
  await userEvent.click(await screen.findByRole("button", { name: "Remove your own Google app" }));
  expect(within(confirmBox()).getByRole("status").textContent).toBe("Your 1 Gmail account will need reconnecting once. Until it is, its scheduled email waits.");
  expect(del).not.toHaveBeenCalled();
  data.providers = [];
  data.credentials = [gmailAccount("ana")];
  await userEvent.click(within(confirmBox()).getByRole("button", { name: "Remove" }));
  expect(del).toHaveBeenCalledWith("/api/w/{workspaceId}/credentials/{id}", { params: { path: { workspaceId: W, id: "a1" } } });
  expect(await screen.findByText("Gmail can't connect until a Google app is set up.")).toBeTruthy();
  expect(screen.getByText("Use your own Google app")).toBeTruthy();
});

test("Change removes the own app, then saves the new client id and secret", async () => {
  serve({ providers: [{ ...google, app: "own" }], credentials: [gmailApp] });
  const del = vi.spyOn(api, "DELETE").mockImplementation(ok as never);
  const post = vi.spyOn(api, "POST").mockImplementation(ok as never);
  as("owner");
  await fillWizard("Change");
  await waitFor(() => expect(post).toHaveBeenCalledTimes(1));
  expect(del).toHaveBeenCalledWith("/api/w/{workspaceId}/credentials/{id}", { params: { path: { workspaceId: W, id: "a1" } } });
  expect(del.mock.invocationCallOrder[0]!).toBeLessThan(post.mock.invocationCallOrder[0]!);
  expect((post.mock.calls[0] as unknown as [string, { body: unknown }])[1].body).toMatchObject({ key: "oauth_app:google", meta: { username: "new-id.apps.googleusercontent.com" }, value: { password: "new-secret" } });
});
