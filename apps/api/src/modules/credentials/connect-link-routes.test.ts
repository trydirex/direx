// SPDX-License-Identifier: AGPL-3.0-only
// Connect links over HTTP: making one needs step-up, its page changes nothing, the POST claims it,
// and the network's callback works in a browser with no Direx session or cookie.
import { afterAll, afterEach, expect, test, vi } from "vitest";
import { masterRootKey } from "./adapters/crypto";
import { createVault } from "./application/secrets";
import { startFakeProvider } from "./fake-provider";
import { testApp, vaultDb } from "./test-helpers";

const db = vaultDb();
const fake = startFakeProvider();
const vault = createVault({
  rootKey: masterRootKey(Buffer.alloc(32, 6)),
  now: () => new Date(),
  providers: [fake.provider()],
  callbackUrl: "http://direx.test/api/connections/callback",
  timeoutMs: 500,
});
// The fake provider stands in for a social network here.
const { call, signIn, workspace } = testApp(vault, "http://direx.test", undefined, undefined, (c) => (c === "google" ? "Google" : undefined));
afterEach(() => vi.useRealTimers());
afterAll(() => {
  fake.stop();
  return db.close();
});

const MIN = 60_000;
const issue = (ws: string, cookie: string, connection = "google") => call(`/api/w/${ws}/connections/${connection}/links`, cookie, { method: "POST" });
const pathOf = (url: string) => new URL(url).pathname;

test("making a link needs connect permission, step-up and a network that takes links", async () => {
  const { ws, owner } = await workspace();
  const viewer = await signIn();
  await db.addMember(ws, viewer.userId, "viewer");
  expect((await issue(ws, viewer.cookie)).status).toBe(403);
  expect((await issue(ws, owner.cookie, "imap")).status).toBe(404);
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(Date.now() + 11 * MIN);
  const late = await issue(ws, owner.cookie);
  expect([late.status, ((await late.json()) as { error: string }).error]).toEqual([403, "step_up_required"]);
});

test("a link opened in a browser with no session connects the maker's account, once", async () => {
  const { ws, owner } = await workspace();
  const made = await issue(ws, owner.cookie);
  expect(made.status).toBe(201);
  const { url } = (await made.json()) as { url: string };

  // The page shows who made it and where it connects, and a GET uses nothing up.
  for (let i = 0; i < 2; i++) {
    const page = await call(pathOf(url));
    expect(page.status).toBe(200);
    expect(page.headers.get("referrer-policy")).toBe("no-referrer");
    expect(page.headers.get("cache-control")).toBe("no-store");
    const text = await page.text();
    expect(text).toContain("Connect an account on Google to Acme marketing");
    expect(text).toContain('<form method="post">');
  }

  const claimed = await call(pathOf(url), undefined, { method: "POST" });
  expect(claimed.status).toBe(302);
  const consent = claimed.headers.get("location")!;
  const back = new URL((await fetch(consent, { redirect: "manual" })).headers.get("location")!);

  const done = await call(`/api/connections/callback${back.search}`);
  expect(done.status).toBe(200);
  expect(await done.text()).toContain("Finish on the device you made the link on");

  const again = await call(`/api/connections/callback${back.search}`);
  expect(again.status).toBe(400);
  expect((await call(pathOf(url), undefined, { method: "POST" })).status).toBe(404);
  expect((await call(pathOf(url))).status).toBe(404);

  const listed = (await (await call(`/api/w/${ws}/connect-links`, owner.cookie)).json()) as { links: { status: string; credentialId: string | null }[] };
  expect(listed.links).toEqual([expect.objectContaining({ status: "connected" })]);
  const creds = (await (await call(`/api/w/${ws}/credentials`, owner.cookie)).json()) as { credentials: { id: string; ownerUserId: string }[] };
  expect(creds.credentials).toEqual([expect.objectContaining({ id: listed.links[0]!.credentialId, ownerUserId: owner.userId })]);
});

test("the link page escapes what a person typed, and a made-up link shows nothing about anyone", async () => {
  const owner = await signIn();
  const res = await call("/api/orgs", owner.cookie, { method: "POST", body: { name: "Acme", workspaceName: "<b>Acme</b>" } });
  const ws = ((await res.json()) as { workspace: { id: string } }).workspace.id;
  const { url } = (await (await issue(ws, owner.cookie)).json()) as { url: string };
  const text = await (await call(pathOf(url))).text();
  expect(text).toContain("&lt;b&gt;Acme&lt;/b&gt;");
  expect(text).not.toContain("<b>Acme</b>");

  const madeUp = await call(`/api/connect/${ws}/${"A".repeat(43)}`);
  expect(madeUp.status).toBe(404);
  expect(await madeUp.text()).not.toContain("Acme");
});
