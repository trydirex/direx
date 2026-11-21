// SPDX-License-Identifier: AGPL-3.0-only
import { afterEach, expect, test, vi } from "vitest";
import { QueryClientProvider } from "@tanstack/react-query";
import { createMemoryHistory, createRouter, RouterProvider } from "@tanstack/react-router";
import { act, cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { makeQueryClient } from "@/api/query";
import { api } from "@/client";
import { routeTree, routerOptions } from "./router";

const W = "11111111-1111-1111-1111-111111111111";
const W2 = "22222222-2222-2222-2222-222222222222";
const workspaces = [
  { id: W, name: "Contoso", role: "owner", organization: { id: "o1", name: "Contoso" } },
  { id: W2, name: "Direx", role: "member", organization: { id: "o1", name: "Contoso" } },
];

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

/** The API as a signed-in (or signed-out) person sees it; every other call answers 404. */
function serve(signedIn: boolean) {
  vi.spyOn(api, "GET").mockImplementation(((path: string, init?: { params?: { path?: { id?: string } } }) => {
    const reply = (status: number, body: unknown) => Promise.resolve({ ...(status < 400 ? { data: body } : { error: body }), response: new Response(null, { status }) });
    // Plan p1 belongs to Campaign c9; any other plan has none.
    if (path === "/api/w/{workspaceId}/plans/{id}/campaign") return init?.params?.path?.id === "p1" ? reply(200, { campaignId: "c9" }) : reply(404, { error: "not_found" });
    if (path === "/api/me") return signedIn ? reply(200, { user: { id: "u1", email: "sam@example.com" } }) : reply(401, { error: "unauthorized" });
    if (path === "/api/me/workspaces") return reply(200, { workspaces });
    if (path === "/api/server/status") return reply(200, { claimed: true, canCreateOrganization: true });
    return reply(404, { error: "not_found" });
  }) as never);
  vi.spyOn(api, "POST").mockResolvedValue({ error: { error: "not_found" }, response: new Response(null, { status: 404 }) } as never);
}

function open(url: string, client = makeQueryClient()) {
  client.setDefaultOptions({ queries: { retry: false } });
  const router = createRouter({ routeTree, ...routerOptions, history: createMemoryHistory({ initialEntries: [url] }), context: { queryClient: client } });
  render(
    <QueryClientProvider client={client}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
  return router;
}

test("signed out, any page asks for sign-in", async () => {
  serve(false);
  open(`/w/${W}/calendar`);
  expect(await screen.findByRole("heading", { name: "Sign in to Direx" })).toBeTruthy();
});

test.each(["in time", "after timeout"])("sign-in options arriving %s keep their provider settings", async (arrival) => {
  serve(false);
  const real = vi.mocked(api.GET).getMockImplementation()!;
  const options = Promise.withResolvers<Awaited<ReturnType<typeof api.GET>>>();
  vi.mocked(api.GET).mockImplementation(((...args: Parameters<typeof api.GET>) =>
    args[0] === "/api/sign-in-options" ? options.promise : real(...args)) as typeof api.GET);
  const client = makeQueryClient();
  const timers = vi.spyOn(globalThis, "setTimeout");
  open("/", client);
  await waitFor(() => expect(client.getQueryData(["me"])).toBeNull());
  expect(screen.getByRole("status").textContent).toContain("Loading");
  expect(screen.queryByRole("heading", { name: "Sign in to Direx" })).toBeNull();
  if (arrival === "after timeout") {
    const timeout = timers.mock.calls.find(([, delay]) => delay === 3_000)![0];
    await act(async () => { (timeout as () => void)(); });
    expect(await screen.findByRole("heading", { name: "Sign in to Direx" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Continue with Google" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Continue with Microsoft" })).toBeTruthy();
  }
  options.resolve({ data: { google: false, microsoft: true }, response: new Response(null, { status: 200 }) } as never);
  expect(await screen.findByRole("heading", { name: "Sign in to Direx" })).toBeTruthy();
  await waitFor(() => expect(screen.queryByRole("button", { name: "Continue with Google" })).toBeNull());
  expect(screen.getByRole("button", { name: "Continue with Microsoft" })).toBeTruthy();
});

/** Signed out, with sign-in options that say `firstRun`. */
function serveNewServer(firstRun: "sign_up" | "needs_link" | null) {
  serve(false);
  const real = vi.mocked(api.GET).getMockImplementation()!;
  vi.mocked(api.GET).mockImplementation(((...args: Parameters<typeof api.GET>) =>
    args[0] === "/api/sign-in-options"
      ? Promise.resolve({ data: { google: false, microsoft: false, firstRun }, response: new Response(null, { status: 200 }) })
      : real(...args)) as typeof api.GET);
}
const CLAIM = `/claim/${"a".repeat(64)}`;

test("a server with no accounts that admits anyone opens on sign-up", async () => {
  serveNewServer("sign_up");
  open("/");
  expect(await screen.findByRole("heading", { name: "Sign up for Direx" })).toBeTruthy();
  expect(screen.getByRole("button", { name: "Back to sign in" })).toBeTruthy();
});

test("a production server with no accounts explains the setup link on its bare address, with no form", async () => {
  serveNewServer("needs_link");
  open(`/w/${W}/calendar`);
  expect(await screen.findByRole("heading", { name: "This Direx isn't set up yet" })).toBeTruthy();
  expect(screen.getByText("docker compose -f deploy/compose/compose.yml exec direx bun run server-admin --invite")).toBeTruthy();
  expect(screen.queryByRole("textbox")).toBeNull();
  expect(screen.queryByRole("button")).toBeNull();
});

test("the setup link on a server with no accounts opens on sign-up and holds its token", async () => {
  serveNewServer("needs_link");
  const held = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("{}"));
  open(CLAIM);
  expect(await screen.findByRole("heading", { name: "Set up Direx" })).toBeTruthy();
  expect(screen.getByText("Sign up to become this server's first Server admin.")).toBeTruthy();
  await waitFor(() => expect(held).toHaveBeenCalledWith("/api/admission/token", expect.objectContaining({ body: JSON.stringify({ token: "a".repeat(64) }) })));
});

test("signing up from the setup link mails a return path without its token (DX-R-0024-005)", async () => {
  serveNewServer("needs_link");
  const sent = vi.spyOn(globalThis, "fetch").mockResolvedValue(Response.json({ token: null }));
  open(CLAIM);
  await userEvent.type(await screen.findByLabelText("Email"), "sam@example.com");
  await userEvent.type(screen.getByLabelText(/^Password/), "a long enough password");
  await userEvent.click(screen.getByRole("button", { name: "Sign up" }));
  await waitFor(() => expect(sent).toHaveBeenCalledWith("/api/auth/sign-up/email", expect.anything()));
  const body = JSON.parse(String(sent.mock.calls.find(([path]) => path === "/api/auth/sign-up/email")![1]!.body));
  expect(body.callbackURL).toBe("/claim");
});

test("a dev server holds the setup token and leaves it out of the first-run magic link", async () => {
  serveNewServer("sign_up");
  const sent = vi.spyOn(globalThis, "fetch").mockImplementation(async () => Response.json({}));
  const oldURL = location.href;
  // The router uses memory history here, but the return path also reads the browser URL.
  window.history.replaceState(null, "", CLAIM);
  try {
    open(CLAIM);
    expect(await screen.findByRole("heading", { name: "Sign up for Direx" })).toBeTruthy();
    await userEvent.type(screen.getByLabelText("Email"), "sam@example.com");
    await userEvent.click(screen.getByRole("button", { name: "Email me a sign-in link" }));
    expect(sent).toHaveBeenCalledWith("/api/auth/sign-in/magic-link", expect.objectContaining({
      body: JSON.stringify({ email: "sam@example.com", callbackURL: "/claim", errorCallbackURL: "/claim" }),
    }));
    expect(sent).toHaveBeenCalledWith("/api/admission/token", expect.objectContaining({
      body: JSON.stringify({ token: "a".repeat(64) }),
    }));
  } finally {
    window.history.replaceState(null, "", oldURL);
  }
});

test("signed in, /claim opens the claim page for the held token", async () => {
  serve(true);
  open("/claim");
  expect(await screen.findByRole("heading", { level: 1, name: "Claim this server" })).toBeTruthy();
});

const SIGNUP = `/signup/${"b".repeat(64)}`;

test("a sign-up link opens on sign-up, holds its code first, and mails a return path without it", async () => {
  serveNewServer(null);
  const hold = Promise.withResolvers<Response>();
  const sent = vi.spyOn(globalThis, "fetch").mockImplementation(async (path) => (path === "/api/admission/token" ? hold.promise : Response.json({ token: null })));
  open(SIGNUP);
  expect(await screen.findByRole("heading", { name: "Sign up for Direx" })).toBeTruthy();
  await userEvent.type(screen.getByLabelText("Email"), "sam@example.com");
  await userEvent.type(screen.getByLabelText(/^Password/), "a long enough password");
  await userEvent.click(screen.getByRole("button", { name: "Sign up" }));
  expect(sent).toHaveBeenCalledWith("/api/admission/token", expect.objectContaining({ body: JSON.stringify({ token: "b".repeat(64) }) }));
  // Sign-up waits for the cookie, so the server's Admission sees the code.
  expect(sent.mock.calls.some(([path]) => path === "/api/auth/sign-up/email")).toBe(false);
  hold.resolve(Response.json({ ok: true }));
  await waitFor(() => expect(sent).toHaveBeenCalledWith("/api/auth/sign-up/email", expect.anything()));
  const body = JSON.parse(String(sent.mock.calls.find(([path]) => path === "/api/auth/sign-up/email")![1]!.body));
  expect(body.callbackURL).toBe("/");
});

test.each(["HTTP error", "network error"])("a sign-up link retries a hold after a %s", async (failure) => {
  serveNewServer(null);
  const hold = Promise.withResolvers<Response>();
  const sent = vi.spyOn(globalThis, "fetch").mockImplementationOnce(() => hold.promise)
    .mockImplementation(async () => Response.json({ ok: true }));
  open(SIGNUP);
  await userEvent.type(await screen.findByLabelText("Email"), "sam@example.com");
  const sendLink = screen.getByRole("button", { name: "Email me a sign-in link" });
  await userEvent.click(sendLink);
  if (failure === "HTTP error") hold.resolve(new Response(null, { status: 503 }));
  else hold.reject(new Error("Offline"));
  expect((await screen.findByRole("alert")).textContent).toContain("We couldn't save the code from your link. Try again.");
  expect(sent.mock.calls.map(([path]) => path)).toEqual(["/api/admission/token"]);

  await userEvent.click(sendLink);
  expect(await screen.findByText(/Check sam@example.com for a sign-in link/)).toBeTruthy();
  expect(sent.mock.calls.map(([path]) => path)).toEqual(["/api/admission/token", "/api/admission/token", "/api/auth/sign-in/magic-link"]);
  expect(sent.mock.calls[1]![1]!.body).toBe(sent.mock.calls[0]![1]!.body);
});

test("a sign-up link's email link also returns to / and not to the code", async () => {
  serveNewServer(null);
  const sent = vi.spyOn(globalThis, "fetch").mockImplementation(async () => Response.json({}));
  open(SIGNUP);
  await userEvent.type(await screen.findByLabelText("Email"), "sam@example.com");
  await userEvent.click(screen.getByRole("button", { name: "Email me a sign-in link" }));
  expect(sent.mock.calls.map(([path]) => path)).toEqual(["/api/admission/token", "/api/auth/sign-in/magic-link"]);
  expect(sent.mock.calls[1]![1]!.body).toBe(JSON.stringify({ email: "sam@example.com", callbackURL: "/", errorCallbackURL: "/" }));
});

test("a sign-up link on a self-hosted server nobody has set up explains the setup link instead", async () => {
  serveNewServer("needs_link");
  open(SIGNUP);
  expect(await screen.findByRole("heading", { name: "This Direx isn't set up yet" })).toBeTruthy();
});

test("signed in, a sign-up link goes on to the app", async () => {
  serve(true);
  const router = open(SIGNUP);
  await waitFor(() => expect(router.state.location.pathname).toBe(`/w/${W}`));
});

test("a server with accounts keeps today's sign-in, on the setup link too", async () => {
  serveNewServer(null);
  open(CLAIM);
  expect(await screen.findByRole("heading", { name: "Sign in to claim this server" })).toBeTruthy();
  cleanup();
  serveNewServer(null);
  open("/");
  expect(await screen.findByRole("heading", { name: "Sign in to Direx" })).toBeTruthy();
});

test("signed in, / opens the first Workspace's Home", async () => {
  serve(true);
  const router = open("/");
  await waitFor(() => expect(router.state.location.pathname).toBe(`/w/${W}`));
  const main = await screen.findByRole("navigation", { name: "Main" });
  expect(within(main).getByRole("link", { name: "Home" }).getAttribute("aria-current")).toBe("page");
  expect(screen.getByRole("link", { name: "Skip to content" }).getAttribute("href")).toBe("#content");
});

test("a page that doesn't exist says so inside the shell and links Home; a trailing slash still opens the page", async () => {
  serve(true);
  open(`/w/${W}/no-such-page`);
  expect(await screen.findByText("This page doesn't exist")).toBeTruthy();
  expect(screen.getByRole("link", { name: "Go to Home" }).getAttribute("href")).toBe("/");
  expect(screen.getByRole("navigation", { name: "Main" })).toBeTruthy();
  cleanup();
  open(`/w/${W}/calendar/`);
  expect(await screen.findByRole("heading", { name: "Calendar" })).toBeTruthy();
  expect(screen.queryByText("This page doesn't exist")).toBeNull();
});

test("the Calendar's filters live in the link: they open as set, a change replaces the entry, and paging keeps them", async () => {
  serve(true);
  const router = open(`/w/${W}/calendar?view=week&date=2026-11-02&hide=outreach&needs=1`);
  const emails = (await screen.findByRole("checkbox", { name: "Emails" })) as HTMLInputElement;
  expect(emails.checked).toBe(false);
  expect(screen.getByRole("button", { name: "Only what needs you" }).getAttribute("aria-pressed")).toBe("true");
  const entries = router.history.length;
  await userEvent.click(screen.getByRole("checkbox", { name: "Posts" }));
  await waitFor(() => expect(router.state.location.search).toMatchObject({ hide: "outreach,social", needs: true }));
  expect(router.history.length).toBe(entries);
  await userEvent.click(screen.getByRole("button", { name: "Next week" }));
  await waitFor(() => expect(router.state.location.search).toMatchObject({ date: "2026-11-09", view: "week", hide: "outreach,social", needs: true }));
  expect(router.history.length).toBe(entries + 1);
});

test("Everything's filters live in the link: they open as set, and a change replaces the entry", async () => {
  serve(true);
  const router = open(`/w/${W}/everything?state=held&q=dana`);
  expect(await screen.findByRole("heading", { name: "Everything" })).toBeTruthy();
  const search = screen.getByLabelText("Search titles and campaigns") as HTMLInputElement;
  expect(search.value).toBe("dana");
  expect(router.state.location.search).toEqual({ state: "held", q: "dana" });
  const entries = router.history.length;
  await userEvent.type(search, " reyes");
  await waitFor(() => expect(router.state.location.search).toEqual({ state: "held", q: "dana reyes" }));
  await userEvent.click(screen.getAllByRole("button", { name: "Clear filters" })[0]!);
  await waitFor(() => expect(router.state.location.search).toEqual({}));
  expect(router.history.length).toBe(entries);
});

test("the nav moves between screens without loading the page again, and marks where you are", async () => {
  serve(true);
  const assign = vi.spyOn(window.location, "assign").mockImplementation(() => {});
  const router = open(`/w/${W}`);
  const main = await screen.findByRole("navigation", { name: "Main" });
  await userEvent.click(within(main).getByRole("link", { name: "Calendar" }));
  await waitFor(() => expect(router.state.location.pathname).toBe(`/w/${W}/calendar`));
  expect(within(main).getByRole("link", { name: "Calendar" }).getAttribute("aria-current")).toBe("page");
  expect(within(main).getByRole("link", { name: "Home" }).getAttribute("aria-current")).toBeNull();
  expect(assign).not.toHaveBeenCalled();
});

test("Newsletter and SEO count as Campaign work in the nav", async () => {
  serve(true);
  open(`/w/${W}/seo`);
  const main = await screen.findByRole("navigation", { name: "Main" });
  expect(within(main).getByRole("link", { name: "Campaigns" }).getAttribute("aria-current")).toBe("page");
  const work = await screen.findByRole("navigation", { name: "Campaign work" });
  expect(within(work).getByRole("link", { name: "SEO" }).getAttribute("aria-current")).toBe("page");
});

// ADR 0023 rule 004: a plan shows only inside its Campaign, so every way to a plan leads there.
test.each([
  ["/plans", "/campaigns"],
  ["/plans/p1", "/campaigns/c9?tab=plan"],
  ["/plans/p1?run=r1&notice=busy", "/campaigns/c9?tab=plan&run=r1&notice=busy"],
  ["/plans/gone?run=r1", "/campaigns"],
])("a plan's old link %s leads to %s", async (from, to) => {
  serve(true);
  const router = open(`/w/${W}${from}`);
  await waitFor(() => expect(router.state.location.href).toBe(`/w/${W}${to}`));
  const main = await screen.findByRole("navigation", { name: "Main" });
  expect(within(main).getByRole("link", { name: "Campaigns" }).getAttribute("aria-current")).toBe("page");
});

test("an old query-string link to a plan leads to its Campaign's Plan tab, keeping the drafting run", async () => {
  serve(true);
  const router = open(`/?workspace=${W}&page=campaigns&plan=p1&run=r1&notice=busy`);
  await waitFor(() => expect(router.state.location.href).toBe(`/w/${W}/campaigns/c9?tab=plan&run=r1&notice=busy`));
});

test("the nav has no Plan item, and names the people section Audience", async () => {
  serve(true);
  open(`/w/${W}`);
  const main = await screen.findByRole("navigation", { name: "Main" });
  expect(within(main).getAllByRole("link").map((l) => l.textContent)).toEqual(["Home", "Calendar", "Everything", "Campaigns", "Audience"]);
  expect(within(main).queryByRole("link", { name: "Plan" })).toBeNull();
});

test("an old query-string link redirects to its new path", async () => {
  serve(true);
  const router = open(`/?workspace=${W2}&page=campaigns&campaign=c9&tab=drafts`);
  await waitFor(() => expect(router.state.location.href).toBe(`/w/${W2}/campaigns/c9?tab=drafts`));
});

test("a Workspace you aren't in says so, drops its data, and leads to your first one", async () => {
  serve(true);
  const gone = "33333333-3333-3333-3333-333333333333";
  const client = makeQueryClient();
  client.setQueryData(["w", gone, "items"], ["stale"]);
  const router = open(`/w/${gone}/calendar`, client);
  expect(await screen.findByText("You don't have access to this Workspace")).toBeTruthy();
  expect(client.getQueryData(["w", gone, "items"])).toBeUndefined();
  await userEvent.click(screen.getByRole("link", { name: "Open Contoso" }));
  await waitFor(() => expect(router.state.location.pathname).toBe(`/w/${W}`));
});

test("with no Workspace left, the way out is a new Organization", async () => {
  serve(true);
  vi.mocked(api.GET).mockImplementation(((path: string) =>
    Promise.resolve(
      path === "/api/me"
        ? { data: { user: { id: "u1", email: "sam@example.com" } }, response: new Response(null, { status: 200 }) }
        : path === "/api/me/workspaces"
          ? { data: { workspaces: [] }, response: new Response(null, { status: 200 }) }
          : { error: { error: "not_found" }, response: new Response(null, { status: 404 }) },
    )) as never);
  open(`/w/${W}`);
  expect((await screen.findByRole("link", { name: "Create an Organization" })).getAttribute("href")).toBe("/new-org");
});

test("an Owner who deletes the Workspace lands on the deleted Workspaces, with its export; with none live, / goes there too", async () => {
  const gone = { id: W, name: "Contoso", organization: { id: "o1", name: "Contoso" }, deletedAt: "2026-11-16T10:00:00.000Z", purgeFrom: "2026-12-16T10:00:00.000Z" };
  let deleted = false;
  const reply = (status: number, body: unknown) => Promise.resolve({ ...(status < 400 ? { data: body } : { error: body }), response: new Response(null, { status }) });
  vi.spyOn(api, "GET").mockImplementation(((path: string) => {
    if (path === "/api/me") return reply(200, { user: { id: "u1", email: "sam@example.com" } });
    if (path === "/api/me/workspaces") return reply(200, { workspaces: deleted ? [] : [workspaces[0]] });
    if (path === "/api/me/deleted-workspaces") return reply(200, { workspaces: deleted ? [gone] : [] });
    if (path === "/api/exports/{workspaceId}") return reply(200, { exports: [] });
    return reply(404, { error: "not_found" });
  }) as never);
  const del = vi.spyOn(api, "DELETE").mockImplementation((() => {
    deleted = true;
    return reply(200, { ok: true });
  }) as never);
  const router = open(`/w/${W}/settings`);
  await userEvent.click(await screen.findByRole("button", { name: "Delete Workspace" }));
  const dialog = within(await screen.findByRole("dialog", { name: "Delete Contoso?" }));
  await userEvent.type(dialog.getByLabelText("Type Contoso to confirm"), "Contoso");
  await userEvent.click(dialog.getByRole("button", { name: "Delete Workspace" }));
  expect(del).toHaveBeenCalledOnce();
  await waitFor(() => expect(router.state.location.pathname).toBe("/deleted-workspaces"));
  expect(await screen.findByRole("region", { name: "Contoso (Contoso)" })).toBeTruthy();
  expect((await screen.findByRole("link", { name: "Create an Organization" })).getAttribute("href")).toBe("/new-org");
  cleanup();

  const again = open("/");
  await waitFor(() => expect(again.state.location.pathname).toBe("/deleted-workspaces"));
  expect(await screen.findByRole("heading", { level: 1, name: "Deleted Workspaces" })).toBeTruthy();
});

test("Settings opens on its Overview, with the Settings screens linked and Overview marked", async () => {
  serve(true);
  const router = open(`/w/${W}/settings`);
  await waitFor(() => expect(router.state.location.pathname).toBe(`/w/${W}/settings`));
  const settings = await screen.findByRole("navigation", { name: "Settings" });
  expect(within(settings).getAllByRole("link").map((l) => l.textContent)).toEqual(["Overview", "Email and keys", "Who is sending", "Social accounts", "AI models", "Auto-approve", "Review time", "Members", "External tokens", "Tracking domains"]);
  expect(within(settings).getByRole("link", { name: "Overview" }).getAttribute("aria-current")).toBe("page");
  expect(await screen.findByRole("heading", { level: 1, name: "Settings" })).toBeTruthy();
});

test("the Settings nav marks a screen where something needs someone", async () => {
  serve(true);
  const real = vi.mocked(api.GET).getMockImplementation() as unknown as (path: string, init?: unknown) => unknown;
  vi.mocked(api.GET).mockImplementation(((path: string, init?: unknown) =>
    path === "/api/w/{workspaceId}/standing-rules"
      ? Promise.resolve({ data: { rules: [{ id: "r1", status: "suspended", suspendedReason: null, total: 0, expiresAt: "2027-01-01T00:00:00.000Z" }] }, response: new Response(null, { status: 200 }) })
      : real(path, init)) as never);
  open(`/w/${W}/settings`);
  const nav = () => within(screen.getByRole("navigation", { name: "Settings" }));
  await waitFor(() => expect(nav().getByRole("link", { name: /^Auto-approve\W+needs you$/ }).getAttribute("href")).toBe(`/w/${W}/settings/rules`), { timeout: 3000 });
  expect(nav().getByRole("link", { name: "AI models" })).toBeTruthy();
});

test.each([
  "",
  "/calendar",
  "/review/i1",
  "/campaigns",
  "/campaigns/c9?tab=drafts",
  "/newsletter",
  "/newsletter/i1",
  "/seo?connect_error=denied",
  "/people",
  "/people/find",
  "/people/find/r2",
  "/people/cohorts",
  "/people/cohorts/h1",
  "/people/handovers/x1",
  "/brand",
  "/brand/lessons",
  "/settings/sending",
  "/settings/members",
  "/settings/tokens",
  "/settings/credentials?connect_error=expired",
  "/settings/social?connected=k1",
  "/settings/models",
  "/settings/rules?campaign=c&step=first&mode=agent_written",
])("every screen opens inside the shell: /w/W%s", async (path) => {
  serve(true);
  const router = open(`/w/${W}${path}`);
  expect(await screen.findByRole("navigation", { name: "Main" })).toBeTruthy();
  expect(router.state.location.href).toBe(`/w/${W}${path}`);
  expect(document.getElementById("content")).toBeTruthy();
});

test("the pages outside a Workspace open: reset password, an invite, the bootstrap claim, a new organization", async () => {
  serve(true);
  open("/reset-password?token=t1");
  expect(await screen.findByRole("heading", { level: 1 })).toBeTruthy();
  cleanup();
  open(`/invite/${W}/${"a".repeat(64)}`);
  expect(await screen.findByRole("heading", { level: 1 })).toBeTruthy();
  cleanup();
  open(`/claim/${"a".repeat(64)}`);
  expect(await screen.findByRole("heading", { level: 1, name: "Claim this server" })).toBeTruthy();
  cleanup();
  open("/new-org");
  expect(await screen.findByRole("heading", { level: 1 })).toBeTruthy();
});

test.each([
  ["/people/find/r1", "Find companies"],
  ["/people/cohorts/c1", "Segments"],
  ["/people", "People"],
])("%s keeps the Audience section nav, with %s marked", async (path, current) => {
  serve(true);
  open(`/w/${W}${path}`);
  const nav = await screen.findByRole("navigation", { name: "Audience" });
  expect(within(nav).getByRole("link", { name: current }).getAttribute("aria-current")).toBe("page");
  // In the order the work runs.
  expect(within(nav).getAllByRole("link").map((l) => l.textContent)).toEqual(["Find companies", "Segments", "People"]);
});

test.each([
  ["/people", "People"],
  ["/settings/sending", "Who is sending"],
  ["/settings/rules", "Auto-approve"],
  ["/settings/review-time", "Review time"],
])("%s is titled as its tab: %s", async (path, title) => {
  serve(true);
  open(`/w/${W}${path}`);
  expect(await screen.findByRole("heading", { level: 1, name: title })).toBeTruthy();
});

test("Review is the whole queue, and an old link naming an Item lands on that Item", async () => {
  serve(true);
  const queue = open(`/w/${W}/review`);
  await waitFor(() => expect(queue.state.location.pathname).toBe(`/w/${W}/review`));
  cleanup();
  const one = open(`/w/${W}/review?item=i9`);
  await waitFor(() => expect(one.state.location.pathname).toBe(`/w/${W}/review/i9`));
});
