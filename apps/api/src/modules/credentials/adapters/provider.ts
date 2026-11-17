// SPDX-License-Identifier: AGPL-3.0-only
// HTTP to an OAuth provider: code exchange, refresh and revoke, plus PKCE and the id_token
// claims. A provider is data (no per-provider branches); the client pair comes from env.
import { createHash, randomBytes } from "node:crypto";

export type Provider = {
  connection: string;
  authorizeUrl: string;
  tokenUrl: string;
  /** May hold {accountId}, for a provider that revokes per account. */
  revokeUrl?: string;
  /** Accepted `iss` values of the id_token. */
  issuers: readonly string[];
  /** Asked for at consent. */
  scopes: readonly string[];
  /** Must all be granted, or the connection is refused. */
  requiredScopes: readonly string[];
  extraParams: Readonly<Record<string, string>>;
  clientId: string;
  clientSecret: string;
  /** Where the client pair goes on token and revoke calls. Default: the form body. */
  tokenAuth?: "body" | "basic";
  /** How a POST to the token and revoke endpoints is encoded. Default: a form. */
  tokenBody?: "form" | "json";
  /** Sent on every token and revoke call, such as an API version header. */
  tokenHeaders?: Readonly<Record<string, string>>;
  /** Seconds a token is taken to last when the token response states no expiry; it is refreshed after. */
  defaultExpiresIn?: number;
  /**
   * The token response fields naming the account, for a provider that says who it is there rather than
   * through an id_token or the plugin. The label falls back to the id when its field is empty.
   */
  tokenIdentity?: { accountId: string; accountLabel: string };
  /** How the code is exchanged. Default: POST. */
  codeMethod?: "POST" | "GET";
  /** Default: true. */
  pkce?: boolean;
  /** Joins scopes at consent and splits granted ones. Default: a space. */
  scopeSeparator?: string;
  /** The token response field listing granted scopes. Default: scope. */
  scopeField?: string;
  /**
   * Where granted scopes come from. Default: token. `token_or_asked` is for a provider whose response
   * may not list them and whose consent is all or nothing, so what was asked for was granted.
   * `fixed` is for a provider with no OAuth scopes: nothing is asked at consent, and `scopes` names
   * what every grant holds, such as the capabilities set on the app itself.
   */
  scopeSource?: "token" | "identity" | "token_or_asked" | "fixed";
  /** Token endpoint errors meaning the token is dead and a person must reconnect. Default: invalid_grant. */
  deadTokenErrors?: readonly string[];
  /** Swaps the short token from the code exchange for a long one, which then gives the expiry. */
  longToken?: { url: string; grantType: string; tokenParam: string; sendClientId?: boolean };
  /** How the token stays alive. Default: refresh_token. */
  renewal?: { kind: "refresh_token" } | { kind: "reconnect" } | { kind: "self_renew"; url: string; grantType: string };
  /** Default: POST with the token in a form. */
  revokeMethod?: "POST" | "DELETE";
};

/** A provider whose client pair is looked up per Workspace rather than given once for the deployment. */
export type AppProvider = Omit<Provider, "clientId" | "clientSecret">;
export type ClientPair = { clientId: string; clientSecret: string };

export type Tokens = { accessToken: string; refreshToken?: string; expiresIn: number; scope?: string; idToken?: string; account?: { id: string; label: string } };
export type TokenResult = { ok: true; tokens: Tokens } | { ok: false; error: "invalid_grant" | "failed" };
/** A code exchange may omit the expiry when a long-token exchange follows and supplies it. */
export type CodeTokens = Omit<Tokens, "expiresIn"> & { expiresIn?: number };
export type CodeResult = { ok: true; tokens: CodeTokens } | { ok: false; error: "invalid_grant" | "failed" };

export const randomToken = () => randomBytes(32).toString("base64url");
export const pkceChallenge = (verifier: string) => createHash("sha256").update(verifier).digest("base64url");
/** How a connect link's token and state are kept: never as themselves. */
export const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");

const basicAuth = (p: Provider) => `Basic ${Buffer.from(`${p.clientId}:${p.clientSecret}`).toString("base64")}`;
const scopeText = (v: unknown, sep: string) => (typeof v === "string" ? v : Array.isArray(v) ? v.join(sep) : undefined);

async function tokenCall(p: Provider, method: "POST" | "GET", url: string, params: Record<string, string>, timeoutMs: number): Promise<CodeResult> {
  const basic = p.tokenAuth === "basic";
  let res: Response;
  try {
    const headers: Record<string, string> = { ...p.tokenHeaders, accept: "application/json" };
    if (basic) headers.authorization = basicAuth(p);
    if (method === "GET") {
      const target = new URL(url);
      for (const [k, v] of Object.entries(params)) target.searchParams.set(k, v);
      res = await fetch(target, { headers, signal: AbortSignal.timeout(timeoutMs) });
    } else {
      res = await fetch(url, { method, ...encoded(p, headers, params), signal: AbortSignal.timeout(timeoutMs) });
    }
  } catch {
    return { ok: false, error: "failed" };
  }
  const raw = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok) {
    const dead = p.deadTokenErrors ?? ["invalid_grant"];
    // RFC 6749 names the error `error`; some providers' error bodies name it `code`.
    const said = typeof raw.error === "string" ? raw.error : raw.code;
    return { ok: false, error: typeof said === "string" && dead.includes(said) ? "invalid_grant" : "failed" };
  }
  // One provider's docs show the token fields wrapped in a one-item data array.
  const body = typeof raw.access_token !== "string" && Array.isArray(raw.data) ? ((raw.data[0] ?? {}) as Record<string, unknown>) : raw;
  if (typeof body.access_token !== "string") return { ok: false, error: "failed" };
  return {
    ok: true,
    tokens: {
      accessToken: body.access_token,
      refreshToken: typeof body.refresh_token === "string" ? body.refresh_token : undefined,
      expiresIn: typeof body.expires_in === "number" ? body.expires_in : p.defaultExpiresIn,
      scope: scopeText(body[p.scopeField ?? "scope"], p.scopeSeparator ?? " "),
      idToken: typeof body.id_token === "string" ? body.id_token : undefined,
      account: accountOf(p, body),
    },
  };
}

function accountOf(p: Provider, body: Record<string, unknown>) {
  const f = p.tokenIdentity;
  const id = f && body[f.accountId];
  if (typeof id !== "string" || !id) return undefined;
  const label = body[f.accountLabel];
  return { id, label: typeof label === "string" && label ? label : id };
}

/** A POST body as a form, or as JSON for a provider that takes it. */
function encoded(p: Provider, headers: Record<string, string>, params: Record<string, string>) {
  const json = p.tokenBody === "json";
  return { headers: { ...headers, "content-type": json ? "application/json" : "application/x-www-form-urlencoded" }, body: json ? JSON.stringify(params) : new URLSearchParams(params) };
}

const client = (p: Provider): Record<string, string> => (p.tokenAuth === "basic" ? {} : { client_id: p.clientId, client_secret: p.clientSecret });

/** Everything but a code exchange must state how long the token lasts. */
function withExpiry(r: CodeResult): TokenResult {
  if (!r.ok) return r;
  const { expiresIn } = r.tokens;
  return expiresIn === undefined ? { ok: false, error: "failed" } : { ok: true, tokens: { ...r.tokens, expiresIn } };
}

export async function exchangeCode(p: Provider, a: { code: string; verifier: string; redirectUri: string }, timeoutMs: number): Promise<CodeResult> {
  const r = await tokenCall(
    p,
    p.codeMethod ?? "POST",
    p.tokenUrl,
    { ...client(p), grant_type: "authorization_code", code: a.code, redirect_uri: a.redirectUri, ...(p.pkce === false ? {} : { code_verifier: a.verifier }) } as Record<string, string>,
    timeoutMs,
  );
  return p.longToken ? r : withExpiry(r);
}

export const refreshTokens = async (p: Provider, refreshToken: string, timeoutMs: number): Promise<TokenResult> =>
  withExpiry(await tokenCall(p, "POST", p.tokenUrl, { ...client(p), grant_type: "refresh_token", refresh_token: refreshToken }, timeoutMs));

/** The short token from the code exchange for a long one. The provider must have `longToken`. */
export async function exchangeLongToken(p: Provider, shortToken: string, timeoutMs: number): Promise<TokenResult> {
  const l = p.longToken;
  if (!l) return { ok: false, error: "failed" };
  const params = { grant_type: l.grantType, client_secret: p.clientSecret, [l.tokenParam]: shortToken, ...(l.sendClientId ? { client_id: p.clientId } : {}) };
  return withExpiry(await tokenCall(p, "GET", l.url, params, timeoutMs));
}

/** A self-renewing token for a new one, using only itself. */
export async function renewToken(p: Provider, token: string, timeoutMs: number): Promise<TokenResult> {
  if (p.renewal?.kind !== "self_renew") return { ok: false, error: "failed" };
  return withExpiry(await tokenCall(p, "GET", p.renewal.url, { grant_type: p.renewal.grantType, access_token: token }, timeoutMs));
}

/** True when the provider accepted the revoke, or has no revoke endpoint. */
export async function revokeToken(p: Provider, token: string, timeoutMs: number, accountId?: string): Promise<boolean> {
  if (!p.revokeUrl) return true;
  const url = accountId ? p.revokeUrl.replace("{accountId}", encodeURIComponent(accountId)) : p.revokeUrl;
  if (url.includes("{accountId}")) return false;
  try {
    const signal = AbortSignal.timeout(timeoutMs);
    if (p.revokeMethod === "DELETE") {
      const target = new URL(url);
      target.searchParams.set("access_token", token);
      return (await fetch(target, { method: "DELETE", signal })).ok;
    }
    const headers: Record<string, string> = { ...p.tokenHeaders };
    if (p.tokenAuth === "basic") headers.authorization = basicAuth(p);
    return (await fetch(url, { method: "POST", ...encoded(p, headers, { token }), signal })).ok;
  } catch {
    return false;
  }
}

/**
 * The verified email of an id_token received straight from the token endpoint over TLS,
 * where OIDC Core 3.1.3.7 lets the client skip the signature; iss, aud and exp are checked.
 */
export function idTokenEmail(p: Provider, idToken: string, now: Date): string | null {
  let c: Record<string, unknown>;
  try {
    c = JSON.parse(Buffer.from(idToken.split(".")[1] ?? "", "base64url").toString("utf8"));
  } catch {
    return null;
  }
  const aud = Array.isArray(c.aud) ? c.aud : [c.aud];
  if (typeof c.iss !== "string" || !p.issuers.includes(c.iss)) return null;
  if (!aud.includes(p.clientId)) return null;
  if (typeof c.exp !== "number" || c.exp * 1000 <= now.getTime()) return null;
  if (c.email_verified === false || typeof c.email !== "string") return null;
  return c.email.toLowerCase();
}
