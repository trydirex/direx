// SPDX-License-Identifier: AGPL-3.0-only
// The door's OAuth rules in pure code (door-oauth spec): the discovery documents, every refusal of
// an authorize request and where it is shown, PKCE S256 with RFC 7636's own example, and the
// redirect back carrying `iss`.
import { expect, test } from "vitest";
import { checkAuthorize, clientOf, oauthUrls, pkceMatches, readClientDocument, redirectBack, resourceMetadata, serverMetadata } from "./domain/oauth";

const W = "00000000-0000-4000-8000-0000000000aa";
const u = oauthUrls("https://direx.test/", W);
const CLIENT = "https://chatgpt.test/oauth/client.json";
const REDIRECT = "https://chatgpt.test/connector_platform_oauth_redirect";
const client = readClientDocument(CLIENT, { client_id: CLIENT, client_name: "ChatGPT", redirect_uris: [REDIRECT] });
const VERIFIER = "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk";
const CHALLENGE = "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM";
const good = { response_type: "code", client_id: CLIENT, redirect_uri: REDIRECT, code_challenge: CHALLENGE, code_challenge_method: "S256", state: "s1", resource: u.resource };

test("the discovery documents name one issuer per Workspace, S256 only, CIMD and iss", () => {
  expect(u).toEqual({
    issuer: `https://direx.test/api/door/oauth/w/${W}`,
    authorize: `https://direx.test/api/door/oauth/w/${W}/authorize`,
    token: `https://direx.test/api/door/oauth/w/${W}/token`,
    resource: `https://direx.test/api/door/v1/w/${W}/mcp`,
    serverMetadata: `https://direx.test/.well-known/oauth-authorization-server/api/door/oauth/w/${W}`,
    resourceMetadata: `https://direx.test/.well-known/oauth-protected-resource/api/door/v1/w/${W}/mcp`,
  });
  expect(serverMetadata(u)).toMatchObject({ issuer: u.issuer, code_challenge_methods_supported: ["S256"], token_endpoint_auth_methods_supported: ["none"], client_id_metadata_document_supported: true, authorization_response_iss_parameter_supported: true, grant_types_supported: ["authorization_code"] });
  expect(resourceMetadata(u)).toEqual({ resource: u.resource, authorization_servers: [u.issuer], bearer_methods_supported: ["header"] });
});

test("a client id must be an https document address with a path", () => {
  for (const bad of [undefined, "chatgpt", "http://chatgpt.test/c.json", "https://chatgpt.test/", "https://u:p@chatgpt.test/c.json", "https://chatgpt.test/c.json#x"]) expect(clientOf({ ...good, client_id: bad })).toEqual({ ok: false, error: "invalid_client" });
  expect(clientOf({ ...good, redirect_uri: undefined })).toEqual({ ok: false, error: "invalid_request" });
  expect(clientOf(good)).toEqual({ ok: true, clientId: CLIENT, redirectUri: REDIRECT });
});

test("a client document must be for the same id and list its redirect URIs; its name falls back to the host", () => {
  expect(client).toEqual({ clientId: CLIENT, name: "ChatGPT", host: "chatgpt.test", redirectUris: [REDIRECT] });
  expect(readClientDocument(CLIENT, { client_id: "https://evil.test/c.json", redirect_uris: [REDIRECT] })).toBeNull();
  expect(readClientDocument(CLIENT, { client_id: CLIENT, redirect_uris: "nope" })).toBeNull();
  expect(readClientDocument(CLIENT, "nope")).toBeNull();
  expect(readClientDocument(CLIENT, { client_id: CLIENT, redirect_uris: [] })?.name).toBe("chatgpt.test");
});

test("until the redirect URI is the client's own, every refusal is shown by Direx, not redirected", () => {
  expect(checkAuthorize({ ...good, client_id: "http://x.test/c.json" }, u, client)).toEqual({ ok: false, refusal: { error: "invalid_client", redirect: false } });
  expect(checkAuthorize(good, u, null)).toEqual({ ok: false, refusal: { error: "invalid_client", redirect: false } });
  expect(checkAuthorize({ ...good, redirect_uri: "https://evil.test/cb" }, u, client)).toEqual({ ok: false, refusal: { error: "invalid_request", redirect: false } });
});

test("after it is, a bad response type, PKCE or resource goes back to the client", () => {
  expect(checkAuthorize({ ...good, response_type: "token" }, u, client)).toEqual({ ok: false, refusal: { error: "unsupported_response_type", redirect: true } });
  expect(checkAuthorize({ ...good, code_challenge_method: "plain" }, u, client)).toEqual({ ok: false, refusal: { error: "invalid_request", redirect: true } });
  expect(checkAuthorize({ ...good, code_challenge: "short" }, u, client)).toEqual({ ok: false, refusal: { error: "invalid_request", redirect: true } });
  expect(checkAuthorize({ ...good, resource: oauthUrls("https://direx.test", "00000000-0000-4000-8000-0000000000bb").resource }, u, client)).toEqual({ ok: false, refusal: { error: "invalid_target", redirect: true } });
  expect(checkAuthorize(good, u, client)).toEqual({ ok: true, request: { clientId: CLIENT, clientName: "ChatGPT", clientHost: "chatgpt.test", redirectUri: REDIRECT, codeChallenge: CHALLENGE, state: "s1", resource: u.resource } });
});

test("PKCE S256 matches RFC 7636's example and nothing else", async () => {
  expect(await pkceMatches(VERIFIER, CHALLENGE)).toBe(true);
  expect(await pkceMatches(VERIFIER.slice(0, -1) + "l", CHALLENGE)).toBe(false);
  expect(await pkceMatches("too-short", CHALLENGE)).toBe(false);
  expect(await pkceMatches(CHALLENGE, CHALLENGE)).toBe(false);
});

test("the redirect back carries the code or the error, the state and iss", () => {
  const ok = new URL(redirectBack(REDIRECT, u, { code: "c1" }, "s1"));
  expect(Object.fromEntries(ok.searchParams)).toEqual({ code: "c1", state: "s1", iss: u.issuer });
  const no = new URL(redirectBack(`${REDIRECT}?keep=1`, u, { error: "access_denied" }, null));
  expect(Object.fromEntries(no.searchParams)).toEqual({ keep: "1", error: "access_denied", iss: u.issuer });
});
