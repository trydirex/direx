// SPDX-License-Identifier: AGPL-3.0-only
// Smoke test for the Social accounts page: what each role sees, in plain words, with write-only secret fields.
import { postStatus, sayFollowUp } from "./actions";
import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { expect, test } from "vitest";
import { split, type Credential } from "../credentials/actions";
import type { Account, Network, Target } from "./actions";
import { Social } from "./Social";
import { withQueries } from "../testing";

const W = "00000000-0000-4000-8000-0000000000aa";
const ME = "00000000-0000-4000-8000-000000000001";
const ws = (role: "owner" | "marketer" | "viewer") => ({ id: W, name: "Shop", role, organization: { id: "o", name: "Acme" } }) as never;
const net = (over: Partial<Network> = {}): Network => ({ connection: "net", label: "Net", accountTypes: ["page"], connect: "oauth", availability: "awaiting_approval", canConnect: true, publishes: false, app: "system", callbackProblem: null, ...over });
const account: Account = {
  id: "a",
  credentialId: "c",
  connection: "net",
  networkId: "n1",
  network: "Net",
  accountType: "page",
  name: "Acme Page",
  status: "needs_reauth",
  ownerUserId: "someone-else",
  lastCheckedAt: null,
  warning: { level: "soon", endsAt: "2030-01-01T00:00:00.000Z" },
  canDo: [{ feature: "publish", status: "available" }, { feature: "links", status: "needs_own_app" }, { feature: "analytics", status: "reconnect" }, { feature: "comments", status: "coming" }],
  ownAppLimits: [],
  health: { budget: { posts: 2, replies: 4, links: 1 }, used: { posts: 1, links: 0 }, paused: null },
  runBy: null,
  angle: null,
  siblings: 0,
  asksAngle: false,
  establishable: false,
};
const page = (role: "owner" | "marketer" | "viewer", p: { networks?: Network[]; accounts?: Account[]; notice?: string; offered?: Target[]; connected?: string } = {}) => renderToString(withQueries(createElement(Social, { workspace: ws(role), me: ME, ...p })));
const text = (html: string) => html.replace(/<!-- -->/g, "").replace(/<[^>]+>/g, " ");

test("an account shows its state and what it can do, honestly", () => {
  const t = text(page("owner", { accounts: [account] }));
  for (const words of ["Acme Page", "Reconnect needed", "Reconnect by", "Can use: posts.", "Needs your own app (advanced): links.", "Reconnect to turn on: stats.", "Coming later: comments."]) expect(t).toContain(words);
});

test("only a manager or the login's owner sees Disconnect", () => {
  expect(page("owner", { accounts: [account] })).toContain("Disconnect");
  expect(page("marketer", { accounts: [account] })).not.toContain("Disconnect");
  expect(page("marketer", { accounts: [{ ...account, ownerUserId: ME }] })).toContain("Disconnect");
});

test("every status reads plainly, and connecting needs the network to be connectable and a role that may", () => {
  const networks = [net(), net({ connection: "a", label: "Unbuilt", availability: "not_built", canConnect: false, app: null }), net({ connection: "b", label: "Closed", availability: "not_available", canConnect: false, app: null })];
  const owner = text(page("owner", { networks }));
  for (const words of ["Waiting for the network to approve Direx", "Not available", "Connect Net"]) expect(owner).toContain(words);
  expect(owner).toMatch(/Unbuilt\s+Coming later/);
  expect(owner).not.toContain("Connect Unbuilt");
  expect(text(page("viewer", { networks }))).not.toContain("Connect Net");
});

test("a network connected by a form or through the Workspace's own app doesn't read as awaiting approval", () => {
  const t = text(page("owner", { networks: [net({ connection: "f", label: "Formed", connect: "form", app: null }), net({ connection: "o", label: "Owned", app: "own" })] }));
  expect(t).not.toContain("Waiting for the network to approve Direx");
  expect(t).toContain("Through your own app");
  expect(t).toMatch(/Formed\s+Available/);
});

const wizard = { consoleUrl: "https://dev.example", scopes: ["read"], steps: ["Make an app"], callbackUrl: "https://direx.example/api/connections/callback" };
test("the wizard shows the callback URL and scopes, and takes the secret in a password field, for a manager only", () => {
  const networks = [net({ canConnect: false, app: null, wizard })];
  const owner = page("owner", { networks });
  expect(owner).toContain("https://direx.example/api/connections/callback");
  expect(owner).toContain("Make an app");
  expect(owner).toMatch(/<input(?=[^>]*type="password")(?=[^>]*autoComplete="new-password")(?=[^>]*required="")(?=[^>]*value="")[^>]*>/);
  const marketer = page("marketer", { networks });
  expect(marketer).not.toContain("Client secret");
  expect(marketer).toContain("An Owner or Admin can set these up");
});

test("a network waiting on the person's own app says so, and its wizard names the console and warns about the callback URL", () => {
  const plain = text(page("owner", { networks: [net({ canConnect: false, app: null, wizard })] }));
  expect(plain).toMatch(/Set up with your own app\s+This server connects these networks/);
  expect(plain).not.toContain("Waiting for the network to approve Direx");
  expect(plain).toMatch(/Open the\s+Net developer console/);
  expect(plain).not.toContain("https callback URL");
  const https = text(page("owner", { networks: [net({ canConnect: false, app: null, wizard: { ...wizard, consoleName: "Big Co" }, callbackProblem: "needs_https" })] }));
  expect(https).toMatch(/Open the\s+Big Co developer console/);
  expect(https).toContain("This network accepts only an https callback URL");
  expect(https).toContain("Give Direx an https address and set DIREX_BASE_URL to it before you connect.");
  expect(text(page("owner", { networks: [net({ canConnect: false, app: null, wizard, callbackProblem: "no_localhost" })] }))).toContain("This network refuses localhost in a callback URL. Open Direx at 127.0.0.1 instead");
});

test("a login with several accounts offers a choice", () => {
  expect(text(page("owner", { connected: "c", offered: [{ id: "1", name: "Page one", type: "page", added: false, needsAngle: false }] }))).toContain("Which accounts should Direx post to?");
});

test("a failed connect says so in plain words, naming no provider", () => {
  const t = text(page("owner", { notice: "missing_scope" }));
  expect(t).toContain("The network didn&#x27;t grant everything");
  expect(t).not.toContain("Google");
});

test("a connected network account isn't listed as a Mailbox", () => {
  const c = (id: string, connection: string): Credential => ({ id, scope: "user", kind: "oauth2", key: id, name: id, connection, ownerUserId: ME } as Credential);
  const r = split([c("gmail", "google"), c("page", "net")], ME, ["net"], [], ["google"]);
  expect(r.mailboxes.map((x) => x.id)).toEqual(["gmail"]);
  expect(r.mine).toEqual([]);
});

test("no copy-and-paste state ever says published, and only a Network's post does", () => {
  for (const state of ["needs_approval", "scheduled", "applied", "cancelled"]) {
    expect(postStatus({ mode: "manual", state, reason: null }).toLowerCase()).not.toContain("published");
  }
  expect(postStatus({ mode: "manual", state: "applied", reason: null })).toBe("Posted by you");
  expect(postStatus({ mode: "publish", state: "sent", reason: null })).toBe("Published");
  expect(postStatus({ mode: "publish", state: "held", reason: "not sure it sent" })).toBe("Not published: not sure it sent");
  expect(sayFollowUp("uncertain", 1)).toContain("may have posted");
});

test("each account shows today's use against its budget, and a pause in the network's words", () => {
  const t = text(page("marketer", { accounts: [account] }));
  expect(t).toContain("Today: 1 of 2 posts, 0 of 1 links.");
  expect(t).toContain("lower the risk of a restriction");
  expect(t).toContain("A post was removed or the account restricted");
  const paused = text(page("marketer", { accounts: [{ ...account, health: { ...account.health, paused: { at: "2026-11-06T10:00:00.000Z", reason: "sending_limit", detail: "Rate limit from X" } } }] }));
  expect(paused).toContain("Paused: Rate limit from X.");
  expect(paused).toContain("Lift the pause");
  for (const promise of ["prevent", "never banned", "won't be banned"]) expect((t + paused).toLowerCase()).not.toContain(promise);
});

test("a viewer sees the health line but no pause, removal or limit controls", () => {
  const t = text(page("viewer", { accounts: [account] }));
  expect(t).toContain("Today: 1 of 2 posts");
  for (const control of ["Lift the pause", "A post was removed", "Lower the limit"]) expect(t).not.toContain(control);
});
