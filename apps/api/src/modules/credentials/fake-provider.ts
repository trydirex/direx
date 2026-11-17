// SPDX-License-Identifier: AGPL-3.0-only
// Test only: an OAuth provider over real HTTP. It serves authorize, token (code with PKCE,
// and refresh in four modes) and revoke, and counts every call.
import { pkceChallenge, type Provider } from "./adapters/provider";

export type RefreshMode = "normal" | "rotating" | "invalid_grant" | "hang";
const MAIL = "https://mail.example/send";

export function startFakeProvider(opts: { email?: string; grant?: string[] } = {}) {
  const clientId = "client-fake";
  const clientSecret = "secret-fake";
  const codes = new Map<string, { challenge: string; redirectUri: string }>();
  const live = new Set<string>();
  const calls = { exchange: 0, refresh: 0, revoked: [] as string[] };
  let n = 0;
  const fake = {
    email: opts.email ?? "Ana@Example.com",
    grant: opts.grant ?? [MAIL, "openid", "https://www.googleapis.com/auth/userinfo.email"],
    mode: "normal" as RefreshMode,
    expiresIn: 3600,
    calls,
    url: "",
    provider: (): Provider => ({
      connection: "google",
      authorizeUrl: `${fake.url}/authorize`,
      tokenUrl: `${fake.url}/token`,
      revokeUrl: `${fake.url}/revoke`,
      issuers: [fake.url],
      scopes: [MAIL, "openid", "email"],
      requiredScopes: [MAIL],
      extraParams: { access_type: "offline", prompt: "consent" },
      clientId,
      clientSecret,
    }),
    stop: () => server.stop(true),
  };

  const json = (body: unknown, status = 200) => Response.json(body, { status });
  const idToken = () =>
    ["e30", Buffer.from(JSON.stringify({ iss: fake.url, aud: clientId, exp: Math.floor(Date.now() / 1000) + 3600, email: fake.email, email_verified: true })).toString("base64url"), "sig"].join(".");

  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      const url = new URL(req.url);
      if (url.pathname === "/authorize") {
        const p = url.searchParams;
        if (p.get("client_id") !== clientId || p.get("code_challenge_method") !== "S256") return json({ error: "invalid_request" }, 400);
        const code = `code-${++n}`;
        codes.set(code, { challenge: p.get("code_challenge")!, redirectUri: p.get("redirect_uri")! });
        const back = new URL(p.get("redirect_uri")!);
        back.searchParams.set("code", code);
        back.searchParams.set("state", p.get("state")!);
        return Response.redirect(back.toString(), 302);
      }
      const form = new URLSearchParams(await req.text());
      if (url.pathname === "/revoke") {
        calls.revoked.push(form.get("token")!);
        live.delete(form.get("token")!);
        return new Response(null, { status: 200 });
      }
      if (form.get("client_id") !== clientId || form.get("client_secret") !== clientSecret) return json({ error: "invalid_client" }, 401);
      if (form.get("grant_type") === "authorization_code") {
        calls.exchange++;
        const c = codes.get(form.get("code")!);
        codes.delete(form.get("code")!);
        if (!c || c.redirectUri !== form.get("redirect_uri") || c.challenge !== pkceChallenge(form.get("code_verifier") ?? ""))
          return json({ error: "invalid_grant" }, 400);
        const refresh = `rt-${++n}`;
        live.add(refresh);
        return json({ access_token: `at-${++n}`, refresh_token: refresh, expires_in: fake.expiresIn, scope: fake.grant.join(" "), id_token: idToken() });
      }
      calls.refresh++;
      if (fake.mode === "hang") return new Promise<Response>(() => {});
      const old = form.get("refresh_token")!;
      if (fake.mode === "invalid_grant" || !live.has(old)) return json({ error: "invalid_grant" }, 400);
      await Bun.sleep(30);
      const body: Record<string, unknown> = { access_token: `at-${++n}`, expires_in: fake.expiresIn };
      if (fake.mode === "rotating") {
        live.delete(old);
        body.refresh_token = `rt-${++n}`;
        live.add(body.refresh_token as string);
      }
      return json(body);
    },
  });
  fake.url = `http://localhost:${server.port}`;
  return fake;
}
