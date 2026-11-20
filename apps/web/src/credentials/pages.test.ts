// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment happy-dom
// Smoke test for the Credentials page (V28): each tab renders for the roles that see it,
// in glossary terms, with write-only value fields, and each action calls its endpoint.
import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { expect, test, vi } from "vitest";
import { api } from "../client";
import { add, checkAgain, checkKey, connectKey, connectWithForm, history, mailboxChecks, PROBE_WORDING_VERSION, keyServices, mailboxProviders, remove, replaceKey, rotate, split, startConnect, type Credential } from "./actions";
import { checkWords, Credentials, MailboxForm, ServiceKey, type Tab } from "./Credentials";
import { withQueries, selectOptions } from "../testing";

const W = "00000000-0000-4000-8000-0000000000aa";
const ME = "00000000-0000-4000-8000-000000000001";
const ws = (role: "owner" | "admin" | "marketer" | "viewer") => ({ id: W, name: "Shop", role, organization: { id: "o", name: "Acme" } });
const page = (role: Parameters<typeof ws>[0], tab: Tab, notice?: string) =>
  renderToString(withQueries(createElement(Credentials, { workspace: ws(role), me: ME, tab, notice, providers: [{ connection: "google", label: "Connect a Gmail account", connect: "oauth" }] }))).replaceAll("<!-- -->", "");

test("each tab renders for the roles that see it, with write-only value fields", () => {
  expect(page("marketer", "mailboxes")).toContain("Connect a Gmail account");
  expect(page("viewer", "mailboxes")).not.toContain("Connect a Gmail account");

  expect(page("admin", "workspace")).toContain("Add a Workspace credential");
  expect(page("marketer", "workspace")).not.toContain("Add a Workspace credential");

  const mine = page("marketer", "mine");
  expect(mine).toContain("Add a credential");
  expect(mine).toMatch(/<input(?=[^>]*type="password")(?=[^>]*autoComplete="new-password")(?=[^>]*required="")(?=[^>]*value="")[^>]*>/);
  expect(page("viewer", "mine")).not.toContain("Add a credential");

  expect(page("owner", "mailboxes", "missing_scope")).toContain("Google didn&#x27;t grant permission to send email");
  for (const role of ["owner", "marketer", "viewer"] as const)
    for (const tab of ["mailboxes", "workspace", "mine"] as const) expect(page(role, tab).replace(/<[^>]+>/g, " ")).not.toMatch(/\b(secret|token|connection|inbox)s?\b/i);
});

test("rows land in their tab: every Mailbox, the Workspace's credentials, and only my own", () => {
  const c = (id: string, scope: "workspace" | "user", kind: Credential["kind"], ownerUserId: string | null, connection: string | null = kind === "oauth2" ? "google" : null) => ({ id, scope, kind, ownerUserId, connection }) as Credential;
  const all = [c("m1", "user", "oauth2", ME), c("m2", "user", "oauth2", "other"), c("m3", "user", "basic", ME, "imap_smtp"), c("w", "workspace", "api_key", null), c("u1", "user", "basic", ME), c("u2", "user", "basic", "other")];
  const r = split(all, ME, [], [], ["google", "imap_smtp"]);
  expect([r.mailboxes, r.workspace, r.mine].map((rows) => rows.map((x) => x.id))).toEqual([["m1", "m2", "m3"], ["w"], ["u1"]]);
});

test("only a Mailbox provider's connection is a Mailbox: Search Console is the connecting person's own", () => {
  const sc = { id: "sc", scope: "user", kind: "oauth2", ownerUserId: ME, connection: "google_search_console" } as Credential;
  const net = { ...sc, id: "li", connection: "linkedin" } as Credential;
  const r = split([sc, net, { ...sc, id: "theirs", ownerUserId: "other" } as Credential], ME, ["linkedin"], [], ["google"]);
  expect([r.mailboxes, r.workspace, r.mine].map((rows) => rows.map((x) => x.id))).toEqual([[], [], ["sc"]]);

  const html = renderToString(withQueries(createElement(Credentials, { workspace: ws("marketer"), me: ME, tab: "mine", credentials: [{ ...sc, name: "Search Console", status: "active" } as Credential] })));
  expect(html).toContain("Search Console");
  expect(html).toContain("Access you granted");
  expect(html).not.toContain("<td>Mailbox</td>");
});

test("the connect form asks for what the provider says, with a write-only password", () => {
  const provider = { connection: "any", label: "Connect", connect: "form" as const, fields: [{ name: "host", label: "Mail server" }, { name: "nick", label: "Nickname", optional: true }], presets: [{ label: "Some service", values: { host: "mail.example.com" } }] };
  const form = createElement(MailboxForm, { workspaceId: W, provider, done: async () => {} });
  const html = renderToString(form);
  expect(html).toContain("Mail server");
  expect(html).toContain("Nickname");
  expect(selectOptions(form)["Mail service"]?.options).toContain("Some service");
  expect(html).toMatch(/<input(?=[^>]*type="password")(?=[^>]*required="")(?=[^>]*autoComplete="new-password")(?=[^>]*value="")[^>]*>/);
  expect(html).not.toMatch(/\b(secret|token|connection|inbox)s?\b/i);
});

test("connecting by form posts once, and hands back the mail server's reason", async () => {
  const post = vi.spyOn(api, "POST").mockResolvedValue({ data: { hasSent: false } } as never);
  const form = { username: "a@example.com", password: "pw", settings: { host: "h" } };
  expect(await connectWithForm(W, "any", form)).toEqual({ hasSent: false });
  expect(post).toHaveBeenLastCalledWith("/api/w/{workspaceId}/mailboxes/{connection}", { params: { path: { workspaceId: W, connection: "any" } }, body: { ...form, probeWording: PROBE_WORDING_VERSION } });
  post.mockResolvedValueOnce({ error: { error: "sign_in_failed", detail: "SMTP 535" } } as never);
  expect(await connectWithForm(W, "any", form)).toEqual({ error: "sign_in_failed", detail: "SMTP 535" });
  const get = vi.spyOn(api, "GET").mockResolvedValue({ data: { providers: [{ connection: "any" }] } } as never);
  expect(await mailboxProviders(W)).toEqual([{ connection: "any" }]);
  expect(get).toHaveBeenLastCalledWith("/api/w/{workspaceId}/mailbox-providers", { params: { path: { workspaceId: W } } });
});

test("each action calls its endpoint, with the value in the body only", async () => {
  const ok = { data: {}, error: undefined } as never;
  const post = vi.spyOn(api, "POST").mockResolvedValue(ok);
  const put = vi.spyOn(api, "PUT").mockResolvedValue(ok);
  const del = vi.spyOn(api, "DELETE").mockResolvedValue({ error: { error: "step_up_required" } } as never);
  const get = vi.spyOn(api, "GET").mockResolvedValue({ data: { events: [] } } as never);

  expect(await add(W, { scope: "user", kind: "basic", key: "crm", name: "CRM", meta: "ana", value: "pw" })).toBeNull();
  expect(post).toHaveBeenLastCalledWith("/api/w/{workspaceId}/credentials", {
    params: { path: { workspaceId: W } },
    body: { scope: "user", kind: "basic", key: "crm", name: "CRM", meta: { username: "ana" }, value: { password: "pw" } },
  });

  expect(await rotate(W, { id: "c1", kind: "header", version: 3 } as Credential, "v2")).toBeNull();
  expect(put).toHaveBeenLastCalledWith("/api/w/{workspaceId}/credentials/{id}/value", { params: { path: { workspaceId: W, id: "c1" } }, body: { version: 3, value: { value: "v2" } } });

  expect(await remove(W, "c1")).toBe("step_up_required");
  expect(del).toHaveBeenLastCalledWith("/api/w/{workspaceId}/credentials/{id}", { params: { path: { workspaceId: W, id: "c1" } } });

  expect(await history(W, "c1")).toEqual([]);
  expect(get).toHaveBeenLastCalledWith("/api/w/{workspaceId}/credentials/{id}/events", { params: { path: { workspaceId: W, id: "c1" } } });

  post.mockResolvedValueOnce({ data: { url: "https://accounts.example/consent" } } as never);
  expect(await startConnect(W, "google")).toEqual({ url: "https://accounts.example/consent" });
  expect(post).toHaveBeenLastCalledWith("/api/w/{workspaceId}/connections/{connection}/start", { params: { path: { workspaceId: W, connection: "google" } } });
});

test("a key check says what the service found: credits, or a newsletter list and whether it can send", () => {
  expect(checkWords("Reoon", { remainingCredits: 40 })).toBe("The key works. Reoon says 40 checks are left.");
  expect(checkWords("Kit", { listName: "Founder notes", subscriberCount: 1, canSend: true })).toBe("The key works. Founder notes has 1 subscriber.");
  expect(checkWords("beehiiv", { listName: "Weekly", subscriberCount: 2400, canSend: false })).toBe(
    "The key works. Weekly has 2400 subscribers. Direx can read your subscribers. To send issues from Direx, beehiiv needs its Pro plan.",
  );
});

test("a service's key: connected or not, with save, replace, check and disconnect for an Owner or Admin, and never the key", () => {
  const service = { connection: "checker", name: "Checker", canCheck: true };
  const key = (c: Credential | undefined, manage: boolean) =>
    renderToString(createElement(ServiceKey, { workspaceId: W, service, c, manage, settle: async () => true })).replaceAll("<!-- -->", "");
  const none = key(undefined, true);
  expect(none).toContain("Not connected");
  expect(none).toMatch(/<input(?=[^>]*type="password")(?=[^>]*autoComplete="new-password")(?=[^>]*required="")(?=[^>]*value="")[^>]*>/);
  expect(none).toContain(">Connect<");
  expect(none).not.toContain("Disconnect");

  const saved = { id: "c1", kind: "api_key", connection: "checker", scope: "workspace", status: "active", version: 1 } as Credential;
  const html = key(saved, true);
  for (const words of ["Connected", "New API key", "Replace", "Check the key", "Disconnect"]) expect(html).toContain(words);
  expect(key(saved, false)).not.toMatch(/<input|<button/);
  expect(key({ ...saved, status: "needs_reauth" }, false)).toContain("Reconnect needed");
  expect(html.replace(/<[^>]+>/g, " ")).not.toMatch(/\b(secret|token|connection|inbox)s?\b/i);

  const page = renderToString(withQueries(createElement(Credentials, { workspace: ws("admin"), me: ME, tab: "workspace", services: [service] })));
  expect(page).toContain("Checker");
  // Its credential is that service's row, not a Mailbox or a second Workspace credential.
  expect(split([saved], ME, [], ["checker"])).toEqual({ mailboxes: [], workspace: [], mine: [] });
});

test("the key goes in the body once, and a check hands back what the service said or the error code", async () => {
  const post = vi.spyOn(api, "POST").mockResolvedValue({ data: {}, error: undefined } as never);
  expect(await connectKey(W, "checker", "not-a-real-key")).toBeNull();
  expect(post).toHaveBeenLastCalledWith("/api/w/{workspaceId}/key-services/{connection}", { params: { path: { workspaceId: W, connection: "checker" } }, body: { key: "not-a-real-key" } });
  post.mockResolvedValueOnce({ error: { error: "check_failed" } } as never);
  expect(await connectKey(W, "checker", "refused-fake-key")).toBe("check_failed");
  const put = vi.spyOn(api, "PUT").mockResolvedValue({ data: {}, error: undefined } as never);
  expect(await replaceKey(W, "checker", "not-a-real-key")).toBeNull();
  expect(put).toHaveBeenLastCalledWith("/api/w/{workspaceId}/key-services/{connection}", { params: { path: { workspaceId: W, connection: "checker" } }, body: { key: "not-a-real-key" } });
  put.mockResolvedValueOnce({ error: { error: "check_failed" } } as never);
  expect(await replaceKey(W, "checker", "refused-fake-key")).toBe("check_failed");
  post.mockResolvedValueOnce({ data: { remainingCredits: 5 } } as never);
  expect(await checkKey(W, "checker")).toEqual({ remainingCredits: 5 });
  expect(post).toHaveBeenLastCalledWith("/api/w/{workspaceId}/key-services/{connection}/check", { params: { path: { workspaceId: W, connection: "checker" } } });
  post.mockResolvedValueOnce({ error: { error: "check_failed" } } as never);
  expect(await checkKey(W, "checker")).toEqual({ error: "check_failed" });
  const get = vi.spyOn(api, "GET").mockResolvedValue({ data: { services: [{ connection: "checker" }] } } as never);
  expect(await keyServices(W)).toEqual([{ connection: "checker" }]);
  expect(get).toHaveBeenLastCalledWith("/api/w/{workspaceId}/key-services", { params: { path: { workspaceId: W } } });
});

test("Mailboxes show whether cold email may go from them, why not, and Check again where it helps", () => {
  const mb = (id: string, name: string) => ({ id, name, scope: "user", kind: "basic", ownerUserId: ME, connection: "imap_smtp", status: "active", lastUsedAt: null }) as unknown as Credential;
  const at = "2026-11-05T09:00:00.000Z";
  const html = renderToString(
    withQueries(createElement(Credentials, {
      workspace: ws("owner"),
      me: ME,
      tab: "mailboxes",
      providers: [{ connection: "imap_smtp", label: "Connect an email account with a password", connect: "form" }],
      credentials: [mb("a", "ok@acme.test"), mb("b", "relay@acme.test"), mb("c", "new@acme.test"), mb("d", "odd")],
      checks: [
        { credentialId: "a", state: "passed", reason: null, failures: [], warnings: ["text_added"], checkedAt: at },
        { credentialId: "b", state: "replies_only", reason: null, failures: ["unsubscribe_link_replaced"], warnings: [], checkedAt: at },
        { credentialId: "d", state: "unchecked", reason: "sign_in_not_email", failures: [], warnings: [], checkedAt: at },
      ],
    })),
  )
    .replaceAll("<!-- -->", "")
    .replaceAll("&#x27;", "'");
  expect(html).toContain("3 email accounts haven't passed the unsubscribe check, so no cold email goes from them yet.");
  // The check leads the row's one line; its warnings wait under Details.
  expect(html).toMatch(/Unsubscribe check passed<\/span>.*Details.*Your provider adds its own text to every email\./s);
  expect(html).toContain("Replies only. Your provider changes unsubscribe links");
  expect(html).toContain("Not checked yet. Cold email from it waits.");
  expect(html).toContain("Not checked yet. Cold email from it waits. Its sign-in isn't an email address");
  // A passed Mailbox has nothing to check again; the other three do.
  expect(html.match(/>Check again</g)).toHaveLength(3);
});

test("the connect form says what the test email is before anyone connects", () => {
  const provider = { connection: "imap_smtp", label: "Connect", connect: "form" as const, fields: [] };
  const html = renderToString(createElement(MailboxForm, { workspaceId: W, provider, done: async () => {} })).replaceAll("<!-- -->", "").replaceAll("&#x27;", "'");
  expect(html).toContain("Direx sends one test email to this email account to check that your email provider leaves unsubscribe links unchanged");
  expect(html).toContain("can't catch a provider that changes only email sent to other people");
});

test("checks are read, and Check again posts the wording version the page shows", async () => {
  const get = vi.spyOn(api, "GET").mockResolvedValue({ data: { checks: [{ credentialId: "a", state: "passed" }] } } as never);
  expect(await mailboxChecks(W)).toEqual([{ credentialId: "a", state: "passed" }]);
  expect(get).toHaveBeenLastCalledWith("/api/w/{workspaceId}/outreach/mailbox-checks", { params: { path: { workspaceId: W } } });
  const post = vi.spyOn(api, "POST").mockResolvedValue({ data: { check: { state: "pending", reason: null } } } as never);
  expect(await checkAgain(W, "a")).toBeNull();
  expect(post).toHaveBeenLastCalledWith("/api/w/{workspaceId}/mailboxes/{credentialId}/check", { params: { path: { workspaceId: W, credentialId: "a" } }, body: { probeWording: PROBE_WORDING_VERSION } });
  post.mockResolvedValueOnce({ error: { error: "daily_limit" } } as never);
  expect(await checkAgain(W, "a")).toBe("daily_limit");
});
