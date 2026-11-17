// SPDX-License-Identifier: AGPL-3.0-only
// OAuth sign-in for the door, in pure code (door-oauth spec): the discovery documents, the checks on
// an authorize request, PKCE and the redirect back. One authorization server per Workspace. A client
// is identified by its metadata document's https address (CIMD); only PKCE S256 is accepted. A
// request whose redirect URI isn't yet known to be the client's own is refused on a page of Direx's,
// never by redirecting, so a bad link can't send the person anywhere.

export type OAuthUrls = { issuer: string; authorize: string; token: string; resource: string; serverMetadata: string; resourceMetadata: string };

export function oauthUrls(base: string, workspaceId: string): OAuthUrls {
  const root = base.replace(/\/+$/, "");
  const issuerPath = `/api/door/oauth/w/${workspaceId}`;
  const resourcePath = `/api/door/v1/w/${workspaceId}/mcp`;
  return {
    issuer: root + issuerPath,
    authorize: `${root}${issuerPath}/authorize`,
    token: `${root}${issuerPath}/token`,
    resource: root + resourcePath,
    serverMetadata: `${root}/.well-known/oauth-authorization-server${issuerPath}`,
    resourceMetadata: `${root}/.well-known/oauth-protected-resource${resourcePath}`,
  };
}

/** RFC 8414: what the Workspace's authorization server supports. */
export const serverMetadata = (u: OAuthUrls) => ({
  issuer: u.issuer,
  authorization_endpoint: u.authorize,
  token_endpoint: u.token,
  response_types_supported: ["code"],
  grant_types_supported: ["authorization_code"],
  code_challenge_methods_supported: ["S256"],
  token_endpoint_auth_methods_supported: ["none"],
  client_id_metadata_document_supported: true,
  authorization_response_iss_parameter_supported: true,
  scopes_supported: [],
});

/** RFC 9728: who issues tokens for the Workspace's MCP endpoint. */
export const resourceMetadata = (u: OAuthUrls) => ({ resource: u.resource, authorization_servers: [u.issuer], bearer_methods_supported: ["header"] });

const PKCE = /^[A-Za-z0-9\-._~]{43,128}$/;

/** Step one, before the client's document is read: an https client id and a redirect URI to check against it. */
export function clientOf(q: Record<string, string | undefined>): { ok: true; clientId: string; redirectUri: string } | { ok: false; error: string } {
  const clientId = q.client_id;
  if (!clientId || !URL.canParse(clientId)) return { ok: false, error: "invalid_client" };
  const id = new URL(clientId);
  if (id.protocol !== "https:" || id.hash || id.username || id.password || id.pathname === "/") return { ok: false, error: "invalid_client" };
  if (!q.redirect_uri) return { ok: false, error: "invalid_request" };
  return { ok: true, clientId, redirectUri: q.redirect_uri };
}

export type ClientDocument = { clientId: string; name: string; host: string; redirectUris: readonly string[] };

/** The parts of a client's metadata document that matter, or null when it isn't one for this id. */
export function readClientDocument(clientId: string, raw: unknown): ClientDocument | null {
  if (typeof raw !== "object" || raw === null) return null;
  const d = raw as { client_id?: unknown; client_name?: unknown; redirect_uris?: unknown };
  if (d.client_id !== clientId || !Array.isArray(d.redirect_uris) || !d.redirect_uris.every((r) => typeof r === "string")) return null;
  const host = new URL(clientId).host;
  const name = typeof d.client_name === "string" && d.client_name.trim() ? d.client_name.trim().slice(0, 80) : host;
  return { clientId, name, host, redirectUris: d.redirect_uris as string[] };
}

export type Authorize = { clientId: string; clientName: string; clientHost: string; redirectUri: string; codeChallenge: string; state: string | null; resource: string };
/** `redirect`: the error may go back to the client; otherwise Direx shows it. */
export type AuthorizeRefusal = { error: string; redirect: boolean };

/** Step two, with the client's document read: everything else the request must say. */
export function checkAuthorize(q: Record<string, string | undefined>, u: OAuthUrls, client: ClientDocument | null): { ok: true; request: Authorize } | { ok: false; refusal: AuthorizeRefusal } {
  const first = clientOf(q);
  if (!first.ok) return { ok: false, refusal: { error: first.error, redirect: false } };
  if (!client || client.clientId !== first.clientId) return { ok: false, refusal: { error: "invalid_client", redirect: false } };
  if (!client.redirectUris.includes(first.redirectUri)) return { ok: false, refusal: { error: "invalid_request", redirect: false } };
  // From here the redirect URI is the client's own, so an error can go back to it.
  const back = (error: string) => ({ ok: false as const, refusal: { error, redirect: true } });
  if (q.response_type !== "code") return back("unsupported_response_type");
  if (q.code_challenge_method !== "S256" || !q.code_challenge || !PKCE.test(q.code_challenge)) return back("invalid_request");
  if (q.resource !== u.resource) return back("invalid_target");
  return { ok: true, request: { clientId: first.clientId, clientName: client.name, clientHost: client.host, redirectUri: first.redirectUri, codeChallenge: q.code_challenge, state: q.state ?? null, resource: u.resource } };
}

/** PKCE S256 (RFC 7636): the verifier's SHA-256, base64url without padding, is the challenge. */
export async function pkceMatches(verifier: string, challenge: string): Promise<boolean> {
  if (!PKCE.test(verifier)) return false;
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier)));
  const encoded = btoa(String.fromCharCode(...digest)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  return encoded === challenge;
}

/** Back to the client, with `iss` on every answer (RFC 9207). */
export function redirectBack(redirectUri: string, u: OAuthUrls, answer: { code: string } | { error: string }, state: string | null): string {
  const to = new URL(redirectUri);
  if ("code" in answer) to.searchParams.set("code", answer.code);
  else to.searchParams.set("error", answer.error);
  if (state !== null) to.searchParams.set("state", state);
  to.searchParams.set("iss", u.issuer);
  return to.toString();
}
