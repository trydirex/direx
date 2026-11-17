// SPDX-License-Identifier: AGPL-3.0-only
// Test-only: an identity module wired to an in-memory outbox, and a magic-link sign-in.
import { expect } from "vitest";
import { createIdentity, logMailer, type Admission, type Mail } from "./index";

/** Set DIREX_AUTH_SECRET to this and the app in main.ts accepts these sessions too. */
export const TEST_SECRET = "test-secret-that-is-at-least-32-characters";

/** `admission` defaults to the one for NODE_ENV, which in tests admits everyone. */
export function testIdentity({
  devMode = true,
  admission,
  trustedProxies,
  onDelete,
  onMemberChange,
}: { devMode?: boolean; admission?: Admission; trustedProxies?: string[]; onDelete?: Parameters<typeof createIdentity>[2]; onMemberChange?: Parameters<typeof createIdentity>[3] } = {}) {
  const outbox: Mail[] = [];
  const { routes, auth, config } = createIdentity(
    () => ({
      baseURL: "http://localhost:3000",
      secret: TEST_SECRET,
      devMode,
      mailer: logMailer(outbox),
      trustedProxies,
      google: { clientId: "google-client", clientSecret: "g" },
      microsoft: { clientId: "ms-client", clientSecret: "m" },
    }),
    admission && (() => admission),
    onDelete,
    onMemberChange,
  );

  /** Signs `email` in by magic link and returns the session cookie. A fresh client IP each time, as outside dev sign-in is rate-limited. */
  async function signIn(email = `${crypto.randomUUID()}@example.com`): Promise<string> {
    const ip = { "x-forwarded-for": `198.51.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}` };
    const res = await routes.request("/api/auth/sign-in/magic-link", {
      method: "POST",
      headers: { "content-type": "application/json", ...ip },
      body: JSON.stringify({ email, callbackURL: "/" }),
    });
    expect(res.status).toBe(200);
    const link = [...outbox].reverse().find((m) => m.to === email)!.text.match(/https?:\/\/\S+/)![0];
    const verified = await routes.request(link, { headers: ip });
    expect(verified.status).toBe(302);
    return verified.headers.get("set-cookie")!.split(";")[0]!;
  }

  const call = (path: string, cookie?: string, init: { method?: string; body?: unknown } = {}) =>
    routes.request(path, {
      method: init.method ?? "GET",
      headers: { ...(cookie && { cookie }), ...(init.body !== undefined && { "content-type": "application/json" }) },
      ...(init.body !== undefined && { body: JSON.stringify(init.body) }),
    });

  async function createOrg(cookie: string, name = "Acme") {
    const res = await call("/api/orgs", cookie, { method: "POST", body: { name, workspaceName: `${name} marketing` } });
    expect(res.status).toBe(201);
    return (await res.json()) as {
      organization: { id: string; name: string };
      workspace: { id: string; name: string; role: string };
    };
  }

  /** The token from the latest invite mailed to `email`. */
  const inviteToken = (email: string) =>
    [...outbox].reverse().find((m) => m.to === email && m.text.includes("/invite/"))!.text.match(/\/invite\/[0-9a-f-]+\/([0-9a-f]{64})/)![1]!;

  /** Invites a new person with `role` through the API, signs them in and accepts. */
  async function addMember(inviterCookie: string, workspaceId: string, role: string) {
    const email = `${crypto.randomUUID()}@example.com`;
    const res = await call(`/api/w/${workspaceId}/invites`, inviterCookie, { method: "POST", body: { email, role } });
    expect(res.status).toBe(201);
    const cookie = await signIn(email);
    const accepted = await call("/api/invites/accept", cookie, { method: "POST", body: { workspaceId, token: inviteToken(email) } });
    expect(accepted.status).toBe(200);
    const me = (await (await call("/api/me", cookie)).json()) as { user: { id: string } };
    return { cookie, email, userId: me.user.id };
  }

  return { routes, auth, config, outbox, signIn, call, createOrg, inviteToken, addMember };
}
