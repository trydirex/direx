// SPDX-License-Identifier: AGPL-3.0-only
// What a person does on the Social accounts page: connect a network by consent page or sign-in
// form, pick the accounts to post to, set up a Workspace app, and look after a connected account.
// Each action makes one call, then the page says how it went and reads the lists again.
import { afterEach, expect, test, vi } from "vitest";
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { api } from "../client";
import { withQueries } from "../testing";
import { Social } from "./Social";
import type { Account, Network } from "./actions";

const W = "00000000-0000-4000-8000-0000000000aa";
const ME = "00000000-0000-4000-8000-000000000001";
const ws = (role: "owner" | "marketer") => ({ id: W, name: "Shop", role, organization: { id: "o", name: "Acme" } });
const reply = (status: number, body: unknown) => Promise.resolve({ ...(status < 400 ? { data: body } : { error: body }), response: new Response(null, { status }) });
const ok = () => reply(200, {});
const refused = (error: string, detail?: string) => reply(400, { error, ...(detail ? { detail } : {}) });

const net = (over: Partial<Network> = {}): Network => ({ connection: "net", label: "Net", accountTypes: ["page"], connect: "oauth", availability: "available", canConnect: true, publishes: true, app: "system", ...over });
const form = net({ connection: "sky", label: "Sky", connect: "form", fields: [{ name: "username", label: "Handle" }, { name: "password", label: "App password" }] } as Partial<Network>);
const wizard = net({ connection: "tube", label: "Tube", canConnect: false, app: null, wizard: { consoleUrl: "https://dev.example", scopes: ["read", "write"], steps: ["Create an app"], callbackUrl: "https://direx.example/cb" } } as Partial<Network>);
const account = (over: Partial<Account> = {}): Account => ({
  id: "a1",
  credentialId: "c1",
  connection: "net",
  networkId: "n1",
  network: "Net",
  accountType: "page",
  name: "Acme Page",
  status: "active",
  ownerUserId: ME,
  lastCheckedAt: null,
  warning: null,
  canDo: [{ feature: "publish", status: "available" }],
  health: { budget: { posts: 3, replies: 4, links: 2 }, used: { posts: 1, links: 0 }, paused: null },
  runBy: null,
  angle: null,
  siblings: 0,
  asksAngle: false,
  establishable: false,
  ...over,
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

/** The networks, accounts and a login's targets, changeable between calls so a test can see the page read them again. */
function serve(data: { networks?: Network[]; accounts?: Account[]; targets?: unknown[]; links?: unknown[] }) {
  vi.spyOn(api, "GET").mockImplementation(((path: string) => {
    if (path === "/api/w/{workspaceId}/social/networks") return reply(200, { networks: data.networks ?? [] });
    if (path === "/api/w/{workspaceId}/social/accounts") return reply(200, { accounts: data.accounts ?? [] });
    if (path === "/api/w/{workspaceId}/social/credentials/{credentialId}/targets") return reply(200, { targets: data.targets ?? [] });
    if (path === "/api/w/{workspaceId}/connect-links") return reply(200, { links: data.links ?? [] });
    return reply(404, { error: "not_found" });
  }) as never);
  return data;
}
const open = (role: "owner" | "marketer" = "owner", p: { connected?: string } = {}) => render(withQueries(<Social workspace={ws(role)} me={ME} {...p} />));

test("Connect first says what Direx will and won't do, then sends the browser to the network's consent page; a refusal is said on the page", async () => {
  serve({ networks: [net()] });
  const assign = vi.spyOn(window.location, "assign").mockImplementation(() => {});
  const post = vi.spyOn(api, "POST").mockImplementationOnce((() => reply(200, { url: "https://net.example/consent" })) as never);
  open();
  const connect = await screen.findByRole("button", { name: "Connect Net" });
  await userEvent.click(connect);
  expect(connect.getAttribute("aria-expanded")).toBe("true");
  expect(post).not.toHaveBeenCalled();
  const before = screen.getByRole("group", { name: "Before you connect Net" });
  expect(before.textContent).toBe("Direx will: post only what you approve.Direx won't: send DMs, follow, or delete posts.Continue to NetCancel");
  await userEvent.click(within(before).getByRole("button", { name: "Cancel" }));
  expect(screen.queryByRole("group", { name: "Before you connect Net" })).toBeNull();
  await userEvent.click(connect);
  await userEvent.click(screen.getByRole("button", { name: "Continue to Net" }));
  expect(post).toHaveBeenLastCalledWith("/api/w/{workspaceId}/connections/{connection}/start", { params: { path: { workspaceId: W, connection: "net" } } });
  expect(assign).toHaveBeenCalledWith("https://net.example/consent");

  post.mockImplementationOnce((() => refused("unknown_connection")) as never);
  await userEvent.click(screen.getByRole("button", { name: "Continue to Net" }));
  expect((await screen.findByRole("alert")).textContent).toBe("Direx isn't set up to connect that network yet.");
  expect(assign).toHaveBeenCalledTimes(1);
});

test("the sign-in form says a refusal beside the button, then a login offers its accounts to pick from", async () => {
  const data = serve({ networks: [form] });
  const post = vi.spyOn(api, "POST").mockImplementationOnce((() => refused("identity_failed")) as never);
  open();
  const toggle = await screen.findByRole("button", { name: "Connect Sky" });
  expect(toggle.getAttribute("aria-expanded")).toBe("false");
  await userEvent.click(toggle);
  expect(toggle.getAttribute("aria-expanded")).toBe("true");

  await userEvent.type(screen.getByLabelText("Handle"), "acme.sky");
  await userEvent.type(screen.getByLabelText("App password"), "pw-1");
  await userEvent.click(screen.getByRole("button", { name: "Connect" }));
  expect(post).toHaveBeenLastCalledWith("/api/w/{workspaceId}/social/{connection}/form", { params: { path: { workspaceId: W, connection: "sky" } }, body: { username: "acme.sky", password: "pw-1" } });
  expect((await screen.findByRole("alert")).textContent).toBe("The network didn't say which account this is. Nothing was saved. Try again.");
  expect((screen.getByLabelText("App password") as HTMLInputElement).value).toBe("");

  post.mockImplementationOnce((() => refused("sign_in_failed", "Wrong app password")) as never);
  await userEvent.type(screen.getByLabelText("App password"), "pw-2");
  await userEvent.click(screen.getByRole("button", { name: "Connect" }));
  expect(await screen.findByText("Wrong app password")).toBeTruthy();

  data.targets = [
    { id: "t1", name: "Acme Main", type: "page", added: false, needsAngle: false },
    { id: "t2", name: "Acme Old", type: "page", added: true, needsAngle: false },
  ];
  post.mockImplementationOnce((() => reply(200, { credentialId: "c9" })) as never);
  await userEvent.type(screen.getByLabelText("App password"), "pw-3");
  await userEvent.click(screen.getByRole("button", { name: "Connect" }));
  const picker = within(await screen.findByRole("form", { name: "Which accounts should Direx post to?" }));
  expect(vi.mocked(api.GET)).toHaveBeenCalledWith("/api/w/{workspaceId}/social/credentials/{credentialId}/targets", { params: { path: { workspaceId: W, credentialId: "c9" } } });
  expect(screen.queryByLabelText("Handle")).toBeNull();
  // An account already added isn't offered again.
  expect(picker.queryByText("Acme Old")).toBeNull();
  const add = picker.getByRole("button", { name: "Add" }) as HTMLButtonElement;
  expect(add.disabled).toBe(true);
  await userEvent.click(picker.getByLabelText("Acme Main"));
  await userEvent.click(picker.getByLabelText("Acme Main"));
  expect(add.disabled).toBe(true);
  await userEvent.click(picker.getByLabelText("Acme Main"));

  data.accounts = [account({ name: "Acme Main" })];
  post.mockImplementationOnce(ok as never);
  await userEvent.click(add);
  expect(post).toHaveBeenLastCalledWith("/api/w/{workspaceId}/social/credentials/{credentialId}/targets", { params: { path: { workspaceId: W, credentialId: "c9" } }, body: { ids: ["t1"] } });
  await waitFor(() => expect(screen.queryByRole("form", { name: "Which accounts should Direx post to?" })).toBeNull());
  expect(await screen.findByText("Acme Main", { selector: "h3" })).toBeTruthy();
});

test("a refused pick keeps the picker open and says why", async () => {
  serve({ targets: [{ id: "t1", name: "Acme Main", type: "page", added: false, needsAngle: false }] });
  const post = vi.spyOn(api, "POST").mockImplementationOnce((() => refused("unknown_target")) as never);
  open("owner", { connected: "c9" });
  const picker = within(await screen.findByRole("form", { name: "Which accounts should Direx post to?" }));
  await userEvent.click(picker.getByLabelText("Acme Main"));
  await userEvent.click(picker.getByRole("button", { name: "Add" }));
  expect(post).toHaveBeenLastCalledWith("/api/w/{workspaceId}/social/credentials/{credentialId}/targets", { params: { path: { workspaceId: W, credentialId: "c9" } }, body: { ids: ["t1"] } });
  expect((await screen.findByRole("alert")).textContent).toBe("The network doesn't offer that account to this login. Reload and try again.");
  expect(screen.getByRole("form", { name: "Which accounts should Direx post to?" })).toBeTruthy();
});

test("an Owner saves the Workspace's own app for a network; a second app is refused", async () => {
  serve({ networks: [wizard] });
  const post = vi.spyOn(api, "POST").mockImplementationOnce((() => refused("duplicate_key")) as never);
  open();
  await userEvent.click(await screen.findByText("Advanced: use your own app (self-hosted)"));
  await userEvent.click(screen.getByText("Set up Tube"));
  await userEvent.type(screen.getByLabelText("Client ID"), "client-1");
  await userEvent.type(screen.getByLabelText("Client secret"), "secret-1");
  await userEvent.click(screen.getByRole("button", { name: "Save" }));
  const body = { scope: "workspace", kind: "basic", key: "oauth_app:tube", name: "Tube app", meta: { username: "client-1" }, value: { password: "secret-1" } };
  expect(post).toHaveBeenLastCalledWith("/api/w/{workspaceId}/credentials", { params: { path: { workspaceId: W } }, body });
  expect((await screen.findByRole("alert")).textContent).toBe("This Workspace already has an app for that network.");
  expect((screen.getByLabelText("Client secret") as HTMLInputElement).value).toBe("");
  expect((screen.getByLabelText("Client ID") as HTMLInputElement).value).toBe("client-1");

  post.mockImplementationOnce(ok as never);
  await userEvent.type(screen.getByLabelText("Client secret"), "secret-2");
  await userEvent.click(screen.getByRole("button", { name: "Save" }));
  expect(post).toHaveBeenLastCalledWith("/api/w/{workspaceId}/credentials", { params: { path: { workspaceId: W } }, body: { ...body, value: { password: "secret-2" } } });
  await waitFor(() => expect(screen.queryByRole("alert")).toBeNull());
});

test("a connected account is reported removed, has its limits lowered, and is disconnected", async () => {
  const data = serve({ accounts: [account()] });
  const post = vi.spyOn(api, "POST").mockImplementation(ok as never);
  const put = vi.spyOn(api, "PUT").mockImplementation(ok as never);
  const del = vi.spyOn(api, "DELETE").mockImplementation(ok as never);
  open("marketer");
  expect(await screen.findByText("Working")).toBeTruthy();
  // Today's use sits on the card; the budget and its controls wait behind Limits and settings.
  expect(screen.getByText(/Today: 1 of 3 posts, 0 of 2 links\./).closest("details")).toBeNull();
  const limits = screen.getByText("Limits and settings").closest("details")!;
  expect(limits.open).toBe(false);
  await userEvent.click(screen.getByText("Limits and settings"));
  expect(limits.open).toBe(true);
  expect(within(limits).getByText(/daily budget, here 3 posts and 2 links/)).toBeTruthy();

  data.accounts = [account({ health: { budget: { posts: 3, replies: 4, links: 2 }, used: { posts: 1, links: 0 }, paused: { reason: "removed", detail: null, at: "2026-11-09T00:00:00.000Z" } } as Account["health"] })];
  await userEvent.click(screen.getByRole("button", { name: "A post was removed or the account restricted: Acme Page" }));
  await userEvent.click(await screen.findByRole("button", { name: "Report and pause" }));
  expect(post).toHaveBeenLastCalledWith("/api/w/{workspaceId}/social/accounts/{accountId}/removed", { params: { path: { workspaceId: W, accountId: "a1" } }, body: { note: null } });
  expect(await screen.findByText(/Paused: removed\./)).toBeTruthy();

  data.accounts = [account()];
  await userEvent.click(screen.getByRole("button", { name: "Lift the pause on Acme Page" }));
  expect(post).toHaveBeenLastCalledWith("/api/w/{workspaceId}/social/accounts/{accountId}/unpause", { params: { path: { workspaceId: W, accountId: "a1" } } });
  expect(await screen.findByRole("button", { name: "A post was removed or the account restricted: Acme Page" })).toBeTruthy();

  await userEvent.clear(screen.getByLabelText("Posts a day"));
  await userEvent.type(screen.getByLabelText("Posts a day"), "1");
  await userEvent.clear(screen.getByLabelText("Links a day"));
  await userEvent.type(screen.getByLabelText("Links a day"), "0");
  put.mockImplementationOnce((() => refused("forbidden")) as never);
  await userEvent.click(screen.getByRole("button", { name: "Lower the limit for Acme Page" }));
  expect(put).toHaveBeenLastCalledWith("/api/w/{workspaceId}/social/accounts/{accountId}/limits", { params: { path: { workspaceId: W, accountId: "a1" } }, body: { posts: 1, links: 0 } });
  expect((await screen.findByRole("alert")).textContent).toBe("Your role doesn't allow that.");

  data.accounts = [];
  await userEvent.click(screen.getByRole("button", { name: "Disconnect Acme Page" }));
  await userEvent.click(await screen.findByRole("button", { name: "Disconnect" }));
  expect(del).toHaveBeenLastCalledWith("/api/w/{workspaceId}/social/credentials/{credentialId}", { params: { path: { workspaceId: W, credentialId: "c1" } } });
  expect(await screen.findByText("No account is connected yet.")).toBeTruthy();
  expect(screen.queryByRole("alert")).toBeNull();
});

test("a change that needs a recent sign-in asks to sign in again", async () => {
  serve({ accounts: [account()] });
  vi.spyOn(api, "DELETE").mockImplementation((() => refused("step_up_required")) as never);
  open();
  await userEvent.click(await screen.findByRole("button", { name: "Disconnect Acme Page" }));
  await userEvent.click(await screen.findByRole("button", { name: "Disconnect" }));
  expect(await screen.findByText("Confirm it's you")).toBeTruthy();
  expect(screen.getByText(/This change needs a recent sign-in/)).toBeTruthy();
});

test("each account's Disconnect names the account, so two rows can be told apart", async () => {
  serve({ accounts: [account(), account({ id: "a2", credentialId: "c2", name: "Beta Page" })] });
  open();
  expect(await screen.findByRole("button", { name: "Disconnect Acme Page" })).toBeTruthy();
  expect(screen.getByRole("button", { name: "Disconnect Beta Page" })).toBeTruthy();
});

test("each account is one card: its network, name and one health chip, then one line of what it can do today", async () => {
  serve({ accounts: [account({ canDo: [{ feature: "publish", status: "available" }, { feature: "links", status: "available" }, { feature: "video", status: "coming" }], warning: { level: "soon", endsAt: "2030-01-01T00:00:00.000Z" } } as Partial<Account>)] });
  open();
  const card = within((await screen.findByRole("heading", { name: "Acme Page" })).closest("li")!);
  expect(card.getByRole("img", { name: "Social posts" })).toBeTruthy();
  expect(card.getByText("Net")).toBeTruthy();
  expect(card.getByText("Working")).toBeTruthy();
  const line = card.getByText(/^Can use: posts, links\. Coming later: video\. Today: 1 of 3 posts, 0 of 2 links\./);
  expect(line.textContent).toMatch(/Reconnect by .+\.$/);
  // Limits, About and Disconnect sit behind one closed disclosure, and no pause shows while posting runs.
  const settings = card.getByText("Limits and settings").closest("details")!;
  expect(settings.open).toBe(false);
  expect(card.getByRole("button", { name: "Disconnect Acme Page" }).closest("details")).toBe(settings);
  expect(card.queryByRole("button", { name: /Lift the pause/ })).toBeNull();
});

test("a working account that is paused shows Posting paused as its chip, and Lift the pause outside the disclosure", async () => {
  serve({ accounts: [account({ health: { budget: { posts: 3, replies: 4, links: 2 }, used: { posts: 0, links: 0 }, paused: { reason: "removed", detail: null, at: "2026-11-09T00:00:00.000Z" } } as Account["health"] })] });
  open("marketer");
  expect(await screen.findByText("Posting paused")).toBeTruthy();
  expect(screen.queryByText("Working")).toBeNull();
  expect(screen.getByRole("button", { name: "Lift the pause on Acme Page" }).closest("details")).toBeNull();
});

// Several accounts on one network. One account per network looks as it did, apart from "Add another".
test("a network with an account offers Add another instead of Connect, and a lone account asks nothing more", async () => {
  serve({ networks: [net()], accounts: [account()] });
  open();
  expect(await screen.findByRole("button", { name: "Add another Net account" })).toBeTruthy();
  expect(screen.queryByRole("button", { name: "Connect Net" })).toBeNull();
  expect(screen.queryByLabelText(/^Run by/)).toBeNull();
  expect(screen.queryByLabelText(/^Angle/)).toBeNull();
});

test("Add another makes a connect link to open elsewhere, and a connected link is finished here by picking", async () => {
  const link = { id: "l1", connection: "net", status: "connected", expiresAt: "2030-01-01T00:00:00.000Z", credentialId: "c7", accountName: "Acme Clips" };
  serve({ networks: [net()], accounts: [account()], links: [link], targets: [{ id: "t7", name: "Acme Clips", type: "page", added: false, needsAngle: false }] });
  const post = vi.spyOn(api, "POST").mockImplementationOnce((() => reply(201, { url: "https://direx.example/api/connect/w/tok", expiresAt: "2030-01-01T10:15:00.000Z" })) as never);
  open();
  await userEvent.click(await screen.findByRole("button", { name: "Add another Net account" }));
  expect(screen.getByText(/Log out of Net or use a private window/)).toBeTruthy();
  await userEvent.click(screen.getByRole("button", { name: "Make a link for whoever is signed in to that account" }));
  expect(post).toHaveBeenLastCalledWith("/api/w/{workspaceId}/connections/{connection}/links", { params: { path: { workspaceId: W, connection: "net" } } });
  expect(((await screen.findByLabelText("Connect link")) as HTMLInputElement).value).toBe("https://direx.example/api/connect/w/tok");

  await userEvent.click(screen.getByRole("button", { name: "Finish adding Acme Clips" }));
  const picker = within(await screen.findByRole("form", { name: "Which accounts should Direx post to?" }));
  expect(picker.getByLabelText("Acme Clips")).toBeTruthy();
});

test("making a link without a recent sign-in asks to sign in again", async () => {
  serve({ networks: [net()], accounts: [account()] });
  vi.spyOn(api, "POST").mockImplementationOnce((() => reply(403, { error: "step_up_required" })) as never);
  open();
  await userEvent.click(await screen.findByRole("button", { name: "Add another Net account" }));
  await userEvent.click(screen.getByRole("button", { name: "Make a link for whoever is signed in to that account" }));
  expect(await screen.findByText("Confirm it's you")).toBeTruthy();
});

test("the picker asks whether an account is established, and for an angle where the network needs one", async () => {
  serve({ targets: [{ id: "t2", name: "Acme Clips", type: "page", added: false, needsAngle: true }] });
  const post = vi.spyOn(api, "POST").mockImplementationOnce((() => ok()) as never);
  open("owner", { connected: "c9" });
  const picker = within(await screen.findByRole("form", { name: "Which accounts should Direx post to?" }));
  await userEvent.click(picker.getByLabelText("Acme Clips"));
  const add = picker.getByRole("button", { name: "Add" }) as HTMLButtonElement;
  expect(add.disabled).toBe(true);
  await userEvent.type(picker.getByLabelText(/What is Acme Clips for\?/), "Pricing tips");
  await userEvent.click(picker.getByLabelText(/Acme Clips is established/));
  expect(add.disabled).toBe(false);
  await userEvent.click(add);
  expect(post).toHaveBeenLastCalledWith("/api/w/{workspaceId}/social/credentials/{credentialId}/targets", {
    params: { path: { workspaceId: W, credentialId: "c9" } },
    body: { ids: ["t2"], established: ["t2"], angles: { t2: "Pricing tips" } },
  });
});

test("an account beside others on its network says who runs it, and an older account can start higher", async () => {
  serve({ networks: [net()], accounts: [account({ siblings: 1, asksAngle: true, angle: "Main", establishable: true }), account({ id: "a2", credentialId: "c2", name: "Acme Clips", siblings: 1, asksAngle: true })] });
  const post = vi.spyOn(api, "POST").mockImplementation((() => ok()) as never);
  const put = vi.spyOn(api, "PUT").mockImplementation((() => ok()) as never);
  open();
  await screen.findByText("Acme Clips", { selector: "h3" });
  expect(screen.getAllByLabelText(/^Run by/)).toHaveLength(2);
  expect((screen.getAllByLabelText(/^Angle/)[0] as HTMLInputElement).value).toBe("Main");
  await userEvent.type(screen.getAllByLabelText(/^Run by/)[0]!, "Bio: by Acme");
  await userEvent.click(screen.getByRole("button", { name: "Save who runs Acme Page" }));
  expect(put).toHaveBeenLastCalledWith("/api/w/{workspaceId}/social/accounts/{accountId}/about", { params: { path: { workspaceId: W, accountId: "a1" } }, body: { runBy: "Bio: by Acme", angle: "Main" } });
  await userEvent.click(screen.getByRole("button", { name: "Acme Page is an established account" }));
  expect(post).toHaveBeenLastCalledWith("/api/w/{workspaceId}/social/accounts/{accountId}/established", { params: { path: { workspaceId: W, accountId: "a1" } } });
  expect(screen.queryByRole("button", { name: "Acme Clips is an established account" })).toBeNull();
});

test("networks split into Ready to connect and a closed Coming later; your own app waits under a closed Advanced", async () => {
  serve({ networks: [net(), net({ connection: "soon", label: "Soon", availability: "awaiting_approval", canConnect: false, app: null }), net({ connection: "todo", label: "Todo", availability: "not_built", canConnect: false, app: null }), wizard] });
  open();
  const networks = within(await screen.findByRole("region", { name: "Networks" }));
  await networks.findByRole("button", { name: "Connect Net" });
  const later = networks.getByText("Coming later (3)").closest("details")!;
  expect(later.open).toBe(false);
  expect(within(later).getAllByRole("row").map((r) => r.firstElementChild!.textContent)).toEqual(["Soon", "Todo", "Tube"]);
  expect(within(later).queryByRole("button")).toBeNull();
  const advanced = networks.getByText("Advanced: use your own app (self-hosted)").closest("details")!;
  expect(advanced.open).toBe(false);
  expect(within(advanced).getByText("Set up Tube")).toBeTruthy();
  expect(networks.getByText("Ready to connect").nextElementSibling!.textContent).toContain("Net");
  expect(networks.getByText("Ready to connect").nextElementSibling!.textContent).not.toContain("Soon");
});

test("a connected account's status shows as a chip outside its posting limits", async () => {
  serve({ accounts: [account({ status: "needs_reauth", establishable: true })] });
  open();
  const chip = await screen.findByText("Reconnect needed");
  expect(chip.closest("details")).toBeNull();
  expect(screen.getByRole("button", { name: "Acme Page is an established account" }).closest("details")!.querySelector("summary")!.textContent).toBe("Limits and settings");
});
