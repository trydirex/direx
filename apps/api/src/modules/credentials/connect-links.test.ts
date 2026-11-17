// SPDX-License-Identifier: AGPL-3.0-only
// Connecting from another device with a link: it works once, briefly, without a session or a cookie,
// and stores the credential as the person who made the link. Most cases here are ways to misuse it.
import { afterAll, expect, test } from "vitest";
import { masterRootKey } from "./adapters/crypto";
import type { AppProvider } from "./adapters/provider";
import { createVault } from "./application/secrets";
import { isLinkToken, linkStatus, linkWorkspace } from "./domain/connect-link";
import { vaultDb } from "./test-helpers";

const { q, newWorkspace, addMember, newUser, close } = vaultDb();

const server = Bun.serve({
  port: 0,
  fetch: (req) => (new URL(req.url).pathname === "/token" ? Response.json({ access_token: "tok", expires_in: 3600 }) : new Response(null, { status: 200 })),
});
afterAll(() => {
  server.stop(true);
  return close();
});
const base = `http://localhost:${server.port}`;

const net: AppProvider = {
  connection: "net",
  authorizeUrl: `${base}/authorize`,
  tokenUrl: `${base}/token`,
  issuers: [],
  scopes: ["a"],
  requiredScopes: ["a"],
  extraParams: {},
  scopeSource: "identity",
  renewal: { kind: "reconnect" },
};

function setup() {
  const clock = { t: Date.now() };
  const ready: string[] = [];
  const vault = createVault({
    rootKey: masterRootKey(Buffer.alloc(32, 7)),
    now: () => new Date(clock.t),
    appProviders: [net],
    systemApp: async () => ({ clientId: "direx-app", clientSecret: "direx-secret" }),
    identify: async () => ({ accountId: "acct-2", accountLabel: "Clip page", scopes: ["a"] }),
    callbackUrl: "http://direx.test/api/connections/callback",
    timeoutMs: 300,
    onReady: async (_ws, id) => void ready.push(id),
  });
  return { clock, vault, ready };
}

const MIN = 60_000;
const tokenOf = (url: string) => url.split("/").pop()!;

async function issued(s: ReturnType<typeof setup>, ws: string, user: string) {
  const r = await s.vault.issueLink({ workspaceId: ws, userId: user, connection: "net" });
  if (!r.ok) throw new Error(r.reason);
  return { ...r, token: tokenOf(r.url) };
}
async function claimed(s: ReturnType<typeof setup>, ws: string, token: string) {
  const r = await s.vault.claimLink(ws, token);
  if (!r) throw new Error("claim refused");
  return new URL(r.url).searchParams.get("state")!;
}
const credentialCount = async (ws: string) => (await q(ws, "select count(*)::int as n from credentials where workspace_id = $1", [ws]))[0]!.n as number;

test("a link connects one account from a browser with no session, as the person who made it", async () => {
  const s = setup();
  const { ws, owner } = await newWorkspace();
  const link = await issued(s, ws, owner);
  expect(link.url).toBe(`http://direx.test/api/connect/${ws}/${link.token}`);
  expect(isLinkToken(link.token)).toBe(true);
  expect(link.expiresAt.getTime() - s.clock.t).toBe(15 * MIN);

  const page = await s.vault.openLink(ws, link.token);
  expect(page).toMatchObject({ connection: "net", workspaceName: "W" });
  expect(page?.issuerEmail).toMatch(/@/);
  // Opening the page twice, as a chat app's preview would, uses nothing up.
  expect(await s.vault.openLink(ws, link.token)).not.toBeNull();

  const state = await claimed(s, ws, link.token);
  expect(linkWorkspace(state)).toBe(ws);
  const r = await s.vault.linkCallback({ state, code: "c" });
  if (!r.ok) throw new Error(r.reason);
  expect(r.credential).toMatchObject({ key: "net:acct-2", name: "Clip page", ownerUserId: owner });
  expect(s.ready).toEqual([r.credential.id]);
  expect(await s.vault.links(ws, owner)).toEqual([expect.objectContaining({ status: "connected", credentialId: r.credential.id, accountName: "Clip page" })]);
});

test("a link's status: open, being used, waiting too long, connected, or used without an account", () => {
  const now = new Date(1_000_000);
  const at = (ms: number) => new Date(now.getTime() + ms);
  const link = { expiresAt: at(MIN), claimedAt: null, usedAt: null, credentialId: null };
  expect(linkStatus(link, now, 10 * MIN)).toBe("open");
  expect(linkStatus({ ...link, expiresAt: now }, now, 10 * MIN)).toBe("expired");
  expect(linkStatus({ ...link, claimedAt: at(-MIN) }, now, 10 * MIN)).toBe("claimed");
  expect(linkStatus({ ...link, claimedAt: at(-10 * MIN) }, now, 10 * MIN)).toBe("expired");
  expect(linkStatus({ ...link, claimedAt: at(-MIN), usedAt: now, credentialId: "c" }, now, 10 * MIN)).toBe("connected");
  expect(linkStatus({ ...link, claimedAt: at(-MIN), usedAt: now }, now, 10 * MIN)).toBe("failed");
  expect(linkWorkspace(undefined)).toBeNull();
  expect(linkWorkspace(`${crypto.randomUUID()}.${"a".repeat(43)}.extra`)).toBeNull();
});

test("a second claim, a used link and a replayed callback connect nothing", async () => {
  const s = setup();
  const { ws, owner } = await newWorkspace();
  const { token } = await issued(s, ws, owner);
  const state = await claimed(s, ws, token);
  expect(await s.vault.claimLink(ws, token)).toBeNull();
  expect(await s.vault.openLink(ws, token)).toBeNull();
  expect((await s.vault.linkCallback({ state, code: "c" })).ok).toBe(true);
  expect(await s.vault.linkCallback({ state, code: "c" })).toEqual({ ok: false, reason: "link_gone" });
  expect(await credentialCount(ws)).toBe(1);
});

test("an expired link can't be opened or claimed, and a claim left too long is gone", async () => {
  const s = setup();
  const { ws, owner } = await newWorkspace();
  const old = await issued(s, ws, owner);
  s.clock.t += 15 * MIN;
  expect(await s.vault.openLink(ws, old.token)).toBeNull();
  expect(await s.vault.claimLink(ws, old.token)).toBeNull();
  expect(await s.vault.links(ws, owner)).toEqual([expect.objectContaining({ status: "expired" })]);

  const slow = await issued(s, ws, owner);
  const state = await claimed(s, ws, slow.token);
  s.clock.t += 10 * MIN;
  expect(await s.vault.linkCallback({ state, code: "c" })).toEqual({ ok: false, reason: "link_gone" });
  expect(await credentialCount(ws)).toBe(0);
});

test("a maker who left the Workspace, or can no longer connect, gets nothing from a claimed link", async () => {
  const s = setup();
  const { ws } = await newWorkspace();
  const left = await newUser();
  await addMember(ws, left);
  const a = await issued(s, ws, left);
  const stateA = await claimed(s, ws, a.token);
  await q(ws, "delete from workspace_members where workspace_id = $1 and user_id = $2", [ws, left]);
  expect(await s.vault.linkCallback({ state: stateA, code: "c" })).toEqual({ ok: false, reason: "not_member" });

  const viewer = await newUser();
  await addMember(ws, viewer);
  const b = await issued(s, ws, viewer);
  const stateB = await claimed(s, ws, b.token);
  await q(ws, "update workspace_members set role = 'viewer' where workspace_id = $1 and user_id = $2", [ws, viewer]);
  expect(await s.vault.linkCallback({ state: stateB, code: "c" })).toEqual({ ok: false, reason: "not_member" });
  expect(await credentialCount(ws)).toBe(0);
});

test("a person holds at most five open links for a connection, and nothing for an unknown one", async () => {
  const s = setup();
  const { ws, owner } = await newWorkspace();
  for (let i = 0; i < 5; i++) await issued(s, ws, owner);
  expect(await s.vault.issueLink({ workspaceId: ws, userId: owner, connection: "net" })).toEqual({ ok: false, reason: "too_many_links" });
  s.clock.t += 15 * MIN;
  await issued(s, ws, owner);
  expect(await s.vault.issueLink({ workspaceId: ws, userId: owner, connection: "nope" })).toEqual({ ok: false, reason: "unknown_connection" });
});

test("a link only works in its own Workspace, and other states never reach the link path", async () => {
  const s = setup();
  const a = await newWorkspace();
  const b = await newWorkspace();
  const { token } = await issued(s, a.ws, a.owner);
  expect(await s.vault.openLink(b.ws, token)).toBeNull();
  expect(await s.vault.claimLink(b.ws, token)).toBeNull();
  expect(await s.vault.openLink("not-a-workspace", token)).toBeNull();
  expect(await s.vault.openLink(a.ws, "short")).toBeNull();
  expect(await s.vault.links(b.ws, a.owner)).toEqual([]);
  // A state for Workspace B, built by hand, finds no link there.
  const forged = `${b.ws}.${"x".repeat(43)}`;
  expect(await s.vault.linkCallback({ state: forged, code: "c" })).toEqual({ ok: false, reason: "link_gone" });
  expect(await s.vault.linkCallback({ state: "plain-state", code: "c" })).toEqual({ ok: false, reason: "link_gone" });
});
