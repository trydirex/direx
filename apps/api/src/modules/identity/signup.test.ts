// SPDX-License-Identifier: AGPL-3.0-only
// Who may sign up outside dev (ADR 0024, rules 001 to 004): every route, under each policy, with
// the answer the person gets. `open` is a dev identity, used only to make inviters and invites.
import { createHash, randomBytes } from "node:crypto";
import { handleOAuthUserInfo } from "better-auth/oauth2";
import { afterAll, beforeAll, beforeEach, expect, test, vi } from "vitest";
import { insertAuthUser, ownerClient } from "../../../../../test/db";
import { selfHostAdmission } from "./application/admission";
import { testIdentity } from "./test-auth";

const PASSWORD = "correct horse battery";
const closed = testIdentity({ devMode: false, admission: selfHostAdmission({ devMode: false }) });
const open = testIdentity();
let owner: Awaited<ReturnType<typeof ownerClient>>;

const randomIp = () => `198.51.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}`;
const at = (domain: string) => `${crypto.randomUUID()}@${domain}`;
const newDomain = () => `${crypto.randomUUID().slice(0, 8)}.example.com`;

function post(path: string, body: unknown, token?: string) {
  return closed.routes.request(`/api/auth${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-forwarded-for": randomIp(), ...(token && { cookie: `direx_invite=${token}` }) },
    body: JSON.stringify(body),
  });
}
const signUp = (email: string, token?: string) => post("/sign-up/email", { email, password: PASSWORD, name: email }, token);
const signIn = (email: string) => post("/sign-in/email", { email, password: PASSWORD });
const sendLink = (email: string) => post("/sign-in/magic-link", { email, callbackURL: "/" });
const mailTo = (email: string) => closed.outbox.filter((m) => m.to === email);
const follow = (email: string, cookie?: string) =>
  closed.routes.request(mailTo(email).at(-1)!.text.match(/https?:\/\/\S+/)![0], { headers: { "x-forwarded-for": randomIp(), ...(cookie && { cookie }) } });
const hold = (token: string) =>
  closed.routes.request("/api/admission/token", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ token }) });
const accountExists = async (email: string) => (await owner.query(`select 1 from auth."user" where email = $1`, [email])).rowCount === 1;
const setPolicy = (policy: string, domains: string[] = []) =>
  owner.query("update system.server_settings set signup_policy = $1, allowed_domains = $2", [policy, domains]);
const oauth = async (email: string, emailVerified: boolean) =>
  handleOAuthUserInfo({ context: await closed.auth().$context } as never, {
    userInfo: { id: `ms-${crypto.randomUUID()}`, email, name: email, emailVerified },
    account: { providerId: "microsoft", accountId: `ms-${crypto.randomUUID()}` },
  }) as Promise<unknown>;
const codeOf = async (p: Promise<unknown>) =>
  p.then(
    () => undefined,
    (e: { body?: { code?: string } }) => e.body?.code,
  );

beforeAll(async () => {
  owner = await ownerClient();
});
afterAll(() => owner.end());
beforeEach(async () => {
  await owner.query("delete from system.server_admins; delete from system.bootstrap_invites; delete from system.server_admin_events;");
  await setPolicy("invite_only");
});

test("under Invite only, email sign-up is refused with a readable 400, not a fake success, and makes nothing", async () => {
  const email = at("example.com");
  const res = await signUp(email);
  expect(res.status).toBe(400);
  const body = (await res.json()) as { code: string; message: string };
  expect(body.code).toBe("SIGNUP_REFUSED");
  expect(body.message).toBe("This server takes invited people only. Ask whoever runs it for an invite.");
  expect(await accountExists(email)).toBe(false);
  expect(mailTo(email)).toEqual([]);
});

test("under Invite only, a magic link to a new address answers as sent and mails nothing; an account still gets one", async () => {
  const email = at("example.com");
  const res = await sendLink(email);
  expect(res.status).toBe(200);
  expect(await res.json()).toEqual({ status: true });
  expect(mailTo(email)).toEqual([]);

  const id = crypto.randomUUID();
  await insertAuthUser(id);
  expect((await sendLink(`${id}@example.com`)).status).toBe(200);
  expect(mailTo(`${id}@example.com`)).toHaveLength(1);
});

test("a link sent while sign-up was open is refused at verify once it closes, with the code in the redirect", async () => {
  await setPolicy("anyone");
  const email = at("example.com");
  await sendLink(email);
  await setPolicy("invite_only");
  const res = await follow(email);
  expect(res.status).toBe(302);
  expect(new URL(res.headers.get("location")!, "http://x").searchParams.get("error")).toBe("SIGNUP_REFUSED");
  expect(await accountExists(email)).toBe(false);
});

test("under allowed domains, a password sign-up is told to use the link, and the link signs a match up", async () => {
  const domain = newDomain();
  await setPolicy("domains", [domain]);
  const email = at(domain);
  const res = await signUp(email);
  expect(res.status).toBe(400);
  expect(((await res.json()) as { code: string }).code).toBe("SIGNUP_USE_LINK");

  await sendLink(email);
  const landed = await follow(email);
  expect(landed.status).toBe(302);
  expect(landed.headers.get("set-cookie")).toMatch(/session_token/);
  expect(await accountExists(email)).toBe(true);

  const elsewhere = at(`mail.${domain}`);
  await sendLink(elsewhere);
  expect(mailTo(elsewhere)).toEqual([]);
});

test("a refusal under allowed domains names them", async () => {
  await setPolicy("domains", ["acme.com", "client.io"]);
  const body = (await (await signUp(at("example.com"))).json()) as { message: string };
  expect(body.message).toBe("This server takes invited people only. Ask whoever runs it for an invite. It also takes addresses at acme.com, client.io.");
});

test("a password set by an attacker for a victim's address can't be used after the victim joins (DX-R-0024-004)", async () => {
  const domain = newDomain();
  await setPolicy("domains", [domain]);
  const victim = at(domain);
  expect((await signUp(victim)).status).toBe(400);
  await sendLink(victim);
  expect((await follow(victim)).status).toBe(302);
  expect((await signIn(victim)).status).toBe(401);
});

test("under Anyone, email sign-up works and sends the confirmation", async () => {
  await setPolicy("anyone");
  const email = at("example.com");
  expect((await signUp(email)).status).toBe(200);
  expect(mailTo(email).map((m) => m.subject)).toEqual(["Confirm your email for Direx"]);
});

test("a Workspace invite token lets only its own address sign up by password, already verified", async () => {
  const inviter = await open.signIn();
  const { workspace } = await open.createOrg(inviter);
  const email = at("client.io");
  const sent = await open.call(`/api/w/${workspace.id}/invites`, inviter, { method: "POST", body: { email, role: "marketer" } });
  expect(sent.status).toBe(201);
  const token = open.inviteToken(email);

  expect((await signUp(at("client.io"), token)).status).toBe(400);
  expect((await signUp(email, token)).status).toBe(200);
  expect((await signIn(email)).status).toBe(200);
  expect(mailTo(email).filter((m) => m.subject === "Confirm your email for Direx")).toEqual([]);
});

test("the invite page's token is held in an httpOnly Lax cookie for 30 minutes, and never echoed", async () => {
  const token = randomBytes(32).toString("hex");
  const res = await hold(token);
  expect(res.status).toBe(200);
  expect(await res.text()).not.toContain(token);
  const cookie = res.headers.get("set-cookie")!;
  expect(cookie).toContain(`direx_invite=${token}`);
  expect(cookie).toMatch(/HttpOnly/);
  expect(cookie).toMatch(/SameSite=Lax/);
  expect(cookie).toMatch(/Max-Age=1800/);
  expect(cookie).toMatch(/Path=\/api(;|$)/);
  expect((await hold("not-a-token")).status).toBe(400);
});

test("an invited person signs up by magic link with the held cookie, and then accepts the invite", async () => {
  const inviter = await open.signIn();
  const { workspace } = await open.createOrg(inviter);
  const email = at("client.io");
  await open.call(`/api/w/${workspace.id}/invites`, inviter, { method: "POST", body: { email, role: "marketer" } });
  const token = open.inviteToken(email);
  const cookie = (await hold(token)).headers.get("set-cookie")!.split(";")[0]!;

  await post("/sign-in/magic-link", { email, callbackURL: "/" }, token);
  expect(mailTo(email)).toHaveLength(1);
  const landed = await follow(email, cookie);
  expect(landed.status).toBe(302);
  expect(new URL(landed.headers.get("location")!, "http://x").searchParams.get("error")).toBeNull();
  const session = landed.headers.get("set-cookie")!.split(";")[0]!;

  const accepted = await closed.call("/api/invites/accept", session, { method: "POST", body: { workspaceId: workspace.id, token } });
  expect(accepted.status).toBe(200);
});

test("a bootstrap token on a server that already has accounts doesn't skip the confirmation", async () => {
  await insertAuthUser(crypto.randomUUID());
  const token = randomBytes(32).toString("hex");
  await owner.query("select system.issue_bootstrap_invite($1, now() + interval '1 hour')", [createHash("sha256").update(token).digest("hex")]);
  const email = at("example.com");
  expect((await signUp(email, token)).status).toBe(200);
  expect((await signIn(email)).status).toBe(403);
  expect(mailTo(email).some((m) => m.subject === "Confirm your email for Direx")).toBe(true);
});

test("without a token, a password sign-up still confirms its email first", async () => {
  await setPolicy("anyone");
  const email = at("example.com");
  expect((await signUp(email)).status).toBe(200);
  expect((await signIn(email)).status).toBe(403);
  expect(mailTo(email).some((m) => m.subject === "Confirm your email for Direx")).toBe(true);
});

test("an unverified Microsoft email creates no account, whatever the policy (DX-R-0024-002)", async () => {
  await setPolicy("anyone");
  const email = at("example.com");
  expect(await codeOf(oauth(email, false))).toBe("SIGNUP_UNVERIFIED");
  expect(await accountExists(email)).toBe(false);
});

test("a verified provider email follows the policy", async () => {
  const email = at("example.com");
  expect(await codeOf(oauth(email, true))).toBe("SIGNUP_REFUSED");
  expect(await accountExists(email)).toBe(false);
  await setPolicy("anyone");
  expect(await codeOf(oauth(email, true))).toBeUndefined();
  expect(await accountExists(email)).toBe(true);
});

/** The Microsoft sign-in, through better-auth's real start and callback routes, with only Microsoft's own endpoints faked. */
async function viaMicrosoft(email: string, inviteToken?: string) {
  const b64 = (o: object) => Buffer.from(JSON.stringify(o)).toString("base64url");
  // better-auth decodes Microsoft's ID token without checking its signature, so an unsigned one stands in.
  const idToken = `${b64({ alg: "none", typ: "JWT" })}.${b64({ oid: crypto.randomUUID(), email, email_verified: true, name: email })}.`;
  const real = globalThis.fetch;
  const fake = vi.spyOn(globalThis, "fetch").mockImplementation((async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    if (url.startsWith("https://login.microsoftonline.com/")) return Response.json({ access_token: "fake-access", id_token: idToken, token_type: "Bearer", expires_in: 3600 });
    if (url.startsWith("https://graph.microsoft.com/")) return new Response(null, { status: 404 });
    return real(input, init);
  }) as typeof fetch);
  try {
    const ip = randomIp();
    const started = await closed.routes.request("/api/auth/sign-in/social", {
      method: "POST",
      headers: { "content-type": "application/json", "x-forwarded-for": ip },
      body: JSON.stringify({ provider: "microsoft", callbackURL: "/landed", errorCallbackURL: "/refused" }),
    });
    expect(started.status).toBe(200);
    const state = new URL(((await started.json()) as { url: string }).url).searchParams.get("state")!;
    const cookies = started.headers.getSetCookie().map((c) => c.split(";")[0]!);
    if (inviteToken) cookies.push(`direx_invite=${inviteToken}`);
    const back = await closed.routes.request(`/api/auth/callback/microsoft?code=fake-code&state=${encodeURIComponent(state)}`, {
      headers: { cookie: cookies.join("; "), "x-forwarded-for": ip },
    });
    return new URL(back.headers.get("location") ?? "", "http://localhost:3000");
  } finally {
    fake.mockRestore();
  }
}

test("under Invite only, an invited person signs up through Microsoft with the held invite, and only for their own address", async () => {
  const inviter = await open.signIn();
  const { workspace } = await open.createOrg(inviter);
  const email = at("client.io");
  expect((await open.call(`/api/w/${workspace.id}/invites`, inviter, { method: "POST", body: { email, role: "marketer" } })).status).toBe(201);
  const token = open.inviteToken(email);

  const stranger = await viaMicrosoft(email);
  expect([stranger.pathname, stranger.searchParams.get("error")]).toEqual(["/refused", "SIGNUP_REFUSED"]);
  expect(await accountExists(email)).toBe(false);

  const other = at("client.io");
  expect((await viaMicrosoft(other, token)).searchParams.get("error")).toBe("SIGNUP_REFUSED");
  expect(await accountExists(other)).toBe(false);

  const invited = await viaMicrosoft(email, token);
  expect([invited.pathname, invited.searchParams.get("error")]).toEqual(["/landed", null]);
  expect(await accountExists(email)).toBe(true);
});
