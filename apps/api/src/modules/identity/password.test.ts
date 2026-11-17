// SPDX-License-Identifier: AGPL-3.0-only
// Email and password sign-in. Dev and test skip verification because mail only reaches the log,
// so the takeover and rate limit cases run against the configuration used everywhere else.
import { handleOAuthUserInfo } from "better-auth/oauth2";
import { expect, test, vi } from "vitest";
import { ownerClient } from "../../../../../test/db";
import { authConfigFromEnv } from "./index";
import { testIdentity } from "./test-auth";

const PASSWORD = "correct horse battery";
const dev = testIdentity();
const prod = testIdentity({ devMode: false });
const newEmail = () => `${crypto.randomUUID()}@example.com`;

// With no client address, the rate limit puts everyone in one bucket, so each call gets its own
// address unless a test is about the limit.
const randomIp = () => `198.51.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}`;
const post = (t: typeof dev, path: string, body: unknown, ip = randomIp()) =>
  t.routes.request(`/api/auth${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-forwarded-for": ip },
    body: JSON.stringify(body),
  });
const signUp = (t: typeof dev, email: string, password = PASSWORD) => post(t, "/sign-up/email", { email, password, name: email });
const signIn = (t: typeof dev, email: string, password = PASSWORD, ip?: string) => post(t, "/sign-in/email", { email, password }, ip);
const cookieOf = (res: Response) => res.headers.get("set-cookie")!.split(";")[0]!;
const me = (t: typeof dev, cookie: string) => t.routes.request("/api/me", { headers: { cookie } });
const lastLink = (t: typeof dev, email: string) => [...t.outbox].reverse().find((m) => m.to === email)!.text.match(/https?:\/\/\S+/)![0];

async function resetPassword(t: typeof dev, email: string, newPassword: string) {
  expect((await post(t, "/request-password-reset", { email, redirectTo: "/" })).status).toBe(200);
  const landed = await t.routes.request(lastLink(t, email));
  expect(landed.status).toBe(302);
  const token = new URL(landed.headers.get("location")!, "http://x").searchParams.get("token")!;
  expect((await post(t, "/reset-password", { token, newPassword })).status).toBe(200);
}

test("a new person signs up and signs in with a password, and the cookie works on /api/me", async () => {
  const email = newEmail();
  const created = await signUp(dev, email);
  expect(created.status).toBe(200);
  expect((await me(dev, cookieOf(created))).status).toBe(200);

  const again = await signIn(dev, email);
  expect(again.status).toBe(200);
  expect((await me(dev, cookieOf(again))).status).toBe(200);
});

test("a wrong password and a short password are refused", async () => {
  const email = newEmail();
  await signUp(dev, email);
  expect((await signIn(dev, email, "not the right password")).status).toBe(401);
  expect((await signUp(dev, newEmail(), "elevenchars")).status).toBe(400);
  expect((await signUp(dev, newEmail(), "twelve chars")).status).toBe(200);
});

test("the account row holds a hash and no provider tokens, and no password reaches the log", async () => {
  const spies = (["log", "info", "warn", "error", "debug"] as const).map((m) => vi.spyOn(console, m));
  const email = newEmail();
  const created = await signUp(dev, email);
  await signIn(dev, email, "this one is the wrong one");
  const printed = JSON.stringify(spies.flatMap((s) => s.mock.calls));
  for (const s of spies) s.mockRestore();
  expect(printed).not.toContain(PASSWORD);
  expect(printed).not.toContain("this one is the wrong one");

  const session = await dev.auth().api.getSession({ headers: new Headers({ cookie: cookieOf(created) }) });
  const ctx = await dev.auth().$context;
  const [account] = await ctx.internalAdapter.findAccounts(session!.user.id);
  expect(account).toMatchObject({ providerId: "credential", accessToken: null, refreshToken: null, idToken: null });
  expect(account!.password).toBeTruthy();
  expect(account!.password).not.toContain(PASSWORD);
});

test("a reset changes the password and ends other sessions", async () => {
  const email = newEmail();
  const old = cookieOf(await signUp(dev, email));
  await resetPassword(dev, email, "a completely new password");
  expect((await me(dev, old)).status).toBe(401);
  expect((await signIn(dev, email)).status).toBe(401);
  expect((await signIn(dev, email, "a completely new password")).status).toBe(200);
});

test("someone who has only used a magic link sets a first password by reset", async () => {
  const email = newEmail();
  await dev.signIn(email);
  await resetPassword(dev, email, "a first password here");
  expect((await signIn(dev, email, "a first password here")).status).toBe(200);
});

test("in dev, a password sign-up keeps its password after a magic link", async () => {
  const email = newEmail();
  await signUp(dev, email);
  await dev.signIn(email);
  expect((await signIn(dev, email)).status).toBe(200);
});

test("only dev and test skip verification", () => {
  const stored = { authSecret: "x".repeat(32), smtpUrl: "smtp://h" };
  const mail = { DIREX_MAIL_FROM: "a@b.c" };
  expect(authConfigFromEnv({ NODE_ENV: "development" }).devMode).toBe(true);
  expect(authConfigFromEnv({ NODE_ENV: "test" }).devMode).toBe(true);
  expect(authConfigFromEnv({ NODE_ENV: "production", ...mail }, stored).devMode).toBe(false);
  expect(authConfigFromEnv({ ...mail }, stored).devMode).toBe(false);
});

test("outside dev, a password works only after the email link", async () => {
  const email = newEmail();
  const created = await signUp(prod, email);
  expect(created.status).toBe(200);
  expect(created.headers.get("set-cookie")).toBeNull();
  expect((await signIn(prod, email)).status).toBe(403);

  const verified = await prod.routes.request(lastLink(prod, email));
  expect(verified.status).toBeLessThan(400);
  expect((await signIn(prod, email)).status).toBe(200);
});

test("outside dev, signing up with an address in use looks the same as a new one", async () => {
  const email = newEmail();
  await signUp(prod, email);
  const first = await signUp(prod, newEmail());
  const duplicate = await signUp(prod, email, "a different password");
  expect(duplicate.status).toBe(first.status);
  expect(Object.keys((await duplicate.json()) as object).sort()).toEqual(Object.keys((await first.json()) as object).sort());
  expect(duplicate.headers.get("set-cookie")).toBeNull();
});

test("outside dev, the real owner's magic link removes a password someone else signed up with", async () => {
  const email = newEmail();
  await signUp(prod, email, "the squatter's password");
  await prod.signIn(email);
  expect((await signIn(prod, email, "the squatter's password")).status).toBe(401);
});

test("outside dev, Google can't link to an address whose owner hasn't confirmed it", async () => {
  const email = newEmail();
  await signUp(prod, email, "the squatter's password");
  const result = await handleOAuthUserInfo({ context: await prod.auth().$context } as never, {
    userInfo: { id: "google-1", email, name: email, emailVerified: true },
    account: { providerId: "google", accountId: "google-1" },
  });
  expect(result.error).toBe("account not linked");
  expect(result.data).toBeNull();
});

test("outside dev, repeated sign-in attempts from one address are rate limited", async () => {
  const email = newEmail();
  const ip = `203.0.113.${Math.floor(Math.random() * 250) + 1}`;
  const statuses: number[] = [];
  for (let i = 0; i < 6; i++) statuses.push((await signIn(prod, email, "wrong password here", ip)).status);
  expect(statuses).toContain(429);
});

test("behind a trusted proxy, the limit follows the address the proxy saw, whatever the client put in front of it", async () => {
  const proxied = testIdentity({ devMode: false, trustedProxies: ["10.0.0.0/8"] });
  const email = newEmail();
  const client = `203.0.113.${Math.floor(Math.random() * 250) + 1}`;
  const statuses: number[] = [];
  for (let i = 0; i < 6; i++) statuses.push((await signIn(proxied, email, "wrong password here", `198.51.100.${i}, ${client}, 10.0.0.7`)).status);
  expect(statuses).toContain(429);
});

test("a magic-link account adds a password once, behind step-up, then signs in with it", async () => {
  const email = newEmail();
  const cookie = await dev.signIn(email);
  const hasPassword = async (c: string) => ((await (await me(dev, c)).json()) as { user: { hasPassword: boolean } }).user.hasPassword;
  const add = (c: string, password = PASSWORD) => dev.call("/api/account/password", c, { method: "POST", body: { password } });
  expect(await hasPassword(cookie)).toBe(false);
  expect((await add(cookie, "elevenchars")).status).toBe(400);

  const owner = await ownerClient();
  try {
    await owner.query("update auth.session set created_at = now() - interval '11 minutes' where token = $1", [decodeURIComponent(cookie.split("=")[1]!).split(".")[0]]);
    expect(await (await add(cookie)).json()).toEqual({ error: "step_up_required" });
  } finally {
    await owner.end();
  }

  const fresh = await dev.signIn(email);
  expect((await add(fresh)).status).toBe(200);
  expect(await hasPassword(fresh)).toBe(true);
  expect((await signIn(dev, email)).status).toBe(200);
  expect([(await add(fresh, "another long password")).status, (await signIn(dev, email)).status]).toEqual([409, 200]);
});
