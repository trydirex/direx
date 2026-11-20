// SPDX-License-Identifier: AGPL-3.0-only
// Sign-in (I1 to I3), the SMTP adapter and the startup refusal.
import { expect, test } from "vitest";
import { authConfigFromEnv, createIdentity, logMailer, selfHostAdmission, smtpMailer, type Admission } from "./index";
import { sessionDaysFromEnv, STEP_UP_WINDOWS, trustedProxiesFromEnv } from "./adapters/auth";
import { TEST_SECRET, testIdentity } from "./test-auth";

const { routes, auth, signIn } = testIdentity();

test("I1: a magic link signs a new email in, and the cookie works on /api/me", async () => {
  const email = `${crypto.randomUUID()}@example.com`;
  const cookie = await signIn(email);
  const me = await routes.request("/api/me", { headers: { cookie } });
  expect(me.status).toBe(200);
  const body = (await me.json()) as { user: { id: string; email: string } };
  expect(body.user.email).toBe(email);
  expect(body.user.id).toMatch(/^[0-9a-f-]{36}$/);
});

test("I1: without a cookie, /api/me is 401", async () => {
  expect((await routes.request("/api/me")).status).toBe(401);
});

test("I2: the sign-in page learns which providers this server is set up for, without signing in", async () => {
  const res = await routes.request("/api/sign-in-options");
  expect(res.status).toBe(200);
  // The shared test database has accounts, so firstRun is null.
  expect(await res.json()).toEqual({ google: true, microsoft: true, firstRun: null });
  const bare = createIdentity(() => ({ baseURL: "http://localhost:3000", secret: TEST_SECRET, devMode: true, mailer: logMailer([]) }));
  expect(await (await bare.routes.request("/api/sign-in-options")).json()).toEqual({ google: false, microsoft: false, firstRun: null });
});

test("I2: a new server's sign-in options say so, and an Admission without firstRun says nothing", async () => {
  const config = () => ({ baseURL: "http://localhost:3000", secret: TEST_SECRET, devMode: false, mailer: logMailer([]) });
  const fresh = createIdentity(config, () => selfHostAdmission({ devMode: false, hasAccounts: async () => false }));
  expect(await (await fresh.routes.request("/api/sign-in-options")).json()).toEqual({ google: false, microsoft: false, firstRun: "needs_link" });
  const cloudLike: Admission = {
    admit: async () => ({ ok: true, via: "open" }),
    canCreateOrganization: async () => false,
    status: async () => ({ claimed: false, policy: "invite_only", domains: [] }),
  };
  const cloud = createIdentity(config, () => cloudLike);
  expect(await (await cloud.routes.request("/api/sign-in-options")).json()).toEqual({ google: false, microsoft: false, firstRun: null });
});

test.each([
  ["google", "accounts.google.com", "google-client"],
  ["microsoft", "login.microsoftonline.com", "ms-client"],
])("I2: %s sign-in builds an authorization URL with PKCE", async (provider, host, clientId) => {
  const res = await routes.request("/api/auth/sign-in/social", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ provider, callbackURL: "/" }),
  });
  expect(res.status).toBe(200);
  const url = new URL(((await res.json()) as { url: string }).url);
  expect(url.host).toBe(host);
  expect(url.searchParams.get("client_id")).toBe(clientId);
  expect(url.searchParams.get("redirect_uri")).toBe(`http://localhost:3000/api/auth/callback/${provider}`);
  for (const p of ["scope", "state", "code_challenge"]) expect(url.searchParams.get(p), p).toBeTruthy();
  expect(url.searchParams.get("code_challenge_method")).toBe("S256");
});

// The OAuth callback creates and updates accounts through the internal adapter, which runs
// the same hooks. The full provider round trip is checked by hand (plan T12).
test("I3: provider tokens are never stored, on create or update", async () => {
  const ctx = await auth().$context;
  const cookie = await signIn(`${crypto.randomUUID()}@example.com`);
  const user = await auth().api.getSession({ headers: new Headers({ cookie }) }).then((s) => s!.user);
  const tokens = { accessToken: "at", refreshToken: "rt", idToken: "it" };
  const account = await ctx.internalAdapter.createAccount({ userId: user.id, providerId: "google", accountId: "g1", ...tokens });
  await ctx.internalAdapter.updateAccount(account.id, tokens);
  const [stored] = await ctx.internalAdapter.findAccounts(user.id);
  expect(stored).toMatchObject({ accessToken: null, refreshToken: null, idToken: null, providerId: "google" });
});

test("startup refuses without SMTP or a secret outside dev and test", () => {
  const prod = { NODE_ENV: "production", DIREX_MAIL_FROM: "a@b.c" };
  const authSecret = "x".repeat(32);
  expect(() => authConfigFromEnv(prod, { authSecret })).toThrow(/set smtp\.url/);
  expect(() => authConfigFromEnv(prod, { smtpUrl: "smtp://h" })).toThrow(/set auth\.secret/);
  // Outside dev and test, env never supplies either one.
  expect(() => authConfigFromEnv({ ...prod, DIREX_AUTH_SECRET: authSecret, DIREX_SMTP_URL: "smtp://h" })).toThrow(/set auth\.secret/);
  expect(() => authConfigFromEnv({ ...prod, DIREX_SMTP_URL: "smtp://h" }, { authSecret })).toThrow(/set smtp\.url/);
  expect(() => authConfigFromEnv({})).toThrow(/set auth\.secret/);
  expect(authConfigFromEnv(prod, { authSecret, smtpUrl: "smtp://h" }).secret).toHaveLength(32);
  expect(authConfigFromEnv({ NODE_ENV: "test" }).secret.length).toBeGreaterThanOrEqual(32);
});

test("the SMTP adapter delivers a message", async () => {
  let data = "";
  const server = Bun.listen<{ inData: boolean }>({
    hostname: "127.0.0.1",
    port: 0,
    socket: {
      open: (s) => {
        s.data = { inData: false };
        s.write("220 stub\r\n");
      },
      data: (s, buf) => {
        const text = buf.toString();
        if (s.data.inData) {
          data += text;
          if (data.includes("\r\n.\r\n")) {
            s.data.inData = false;
            s.write("250 queued\r\n");
          }
          return;
        }
        for (const line of text.split("\r\n").filter(Boolean)) {
          const cmd = line.slice(0, 4).toUpperCase();
          if (cmd === "EHLO" || cmd === "HELO") s.write("250 stub\r\n");
          else if (cmd === "DATA") {
            s.data.inData = true;
            s.write("354 go\r\n");
          } else if (cmd === "QUIT") s.end("221 bye\r\n");
          else s.write("250 ok\r\n");
        }
      },
    },
  });
  const send = smtpMailer(`smtp://127.0.0.1:${server.port}?ignoreTLS=true`, "Direx <signin@example.com>");
  try {
    await send({ to: "dana@example.com", subject: "Sign in to Direx", text: "link" });
    expect(data).toContain("Subject: Sign in to Direx");
    expect(data).toContain("dana@example.com");
    // The mail check connects and sends nothing (ADR 0024).
    expect(await send.verify!()).toBe(true);
  } finally {
    server.stop(true);
  }
  expect(await send.verify!()).toBe(false);
});

test("trusted proxies are read as addresses and ranges, and a bad entry stops the start", () => {
  expect(trustedProxiesFromEnv({})).toEqual([]);
  expect(trustedProxiesFromEnv({ DIREX_TRUSTED_PROXIES: " 10.0.0.0/8, 127.0.0.1 ,fd00::/8," })).toEqual(["10.0.0.0/8", "127.0.0.1", "fd00::/8"]);
  expect(authConfigFromEnv({ NODE_ENV: "test", DIREX_TRUSTED_PROXIES: "10.0.0.0/8" }).trustedProxies).toEqual(["10.0.0.0/8"]);
  for (const bad of ["nginx", "10.0.0.0/33", "fd00::/129", "10.0.0.0/8/8", "10.0.0.0/x"]) {
    expect(() => trustedProxiesFromEnv({ DIREX_TRUSTED_PROXIES: bad })).toThrow(/DIREX_TRUSTED_PROXIES/);
  }
});

test("DIREX_SESSION_DAYS is 30 unless set, a whole number from 2 to 90, and refused on cloud (ADR 0037 rule 001)", () => {
  expect(sessionDaysFromEnv({})).toBe(30);
  expect(sessionDaysFromEnv({ DIREX_SESSION_DAYS: "" })).toBe(30);
  expect(sessionDaysFromEnv({ DIREX_DEPLOYMENT: "cloud" })).toBe(30);
  expect(sessionDaysFromEnv({ DIREX_SESSION_DAYS: "2" })).toBe(2);
  expect(sessionDaysFromEnv({ DIREX_SESSION_DAYS: "90" })).toBe(90);
  expect(authConfigFromEnv({ NODE_ENV: "test", DIREX_SESSION_DAYS: "14" }).sessionDays).toBe(14);
  for (const bad of ["1", "91", "30.5", "-5", "a week", " 30"]) {
    expect(() => sessionDaysFromEnv({ DIREX_SESSION_DAYS: bad })).toThrow(`DIREX_SESSION_DAYS must be a whole number of days from 2 to 90, not ${bad}`);
  }
  expect(() => sessionDaysFromEnv({ DIREX_SESSION_DAYS: "30", DIREX_DEPLOYMENT: "cloud" })).toThrow(/self-hosted Direx only/);
});

test("Better Auth's own fresh-session routes ask for the short step-up window (ADR 0037 rule 004)", () => {
  expect(auth().options.session?.freshAge! * 1000).toBe(STEP_UP_WINDOWS.short);
});
