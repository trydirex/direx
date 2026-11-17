// SPDX-License-Identifier: AGPL-3.0-only
// Connecting a mailbox: start seals the state into a cookie and returns the provider's
// consent URL with PKCE; the callback checks that cookie against the request, exchanges
// the code and stores one oauth2 credential per person and account. A reconnect of the
// same account by the same person keeps the credential's id and makes it active again.
import { openState, sealState, STATE_TTL_MS } from "../adapters/cookie";
import type { RootKey } from "../adapters/crypto";
import {
  exchangeCode,
  exchangeLongToken,
  idTokenEmail,
  pkceChallenge,
  randomToken,
  revokeToken,
  sha256,
  type Provider,
} from "../adapters/provider";
import { can, memberOf } from "../../identity/index";
import {
  claimableLink,
  claimLink as claimLinkRow,
  findLiveUserKey,
  insertCredential,
  insertEvent,
  insertLink,
  isMember,
  linksOf,
  openLinkCount,
  setLinkCredential,
  updateLive,
  useLinkByState,
  withWorkspace,
} from "../adapters/repo";
import { isLinkToken, isWorkspaceId, LINK_TTL_MS, linkState, linkStatus, linkWorkspace, MAX_OPEN_LINKS } from "../domain/connect-link";
import { effectiveExpiry } from "../domain/refresh";
import type { Keyring } from "./keys";
import { extraMeta, parseKind } from "./kinds";
import { metadata, type CredentialMeta, type Done, type Refusal } from "./meta";

export type CallbackRefusal =
  | "bad_cookie"
  | "expired"
  | "state_mismatch"
  | "wrong_user"
  | "denied"
  | "not_member"
  | "exchange_failed"
  | "missing_scope"
  | "bad_id_token"
  | "identity_failed"
  | "no_refresh_token"
  | "link_gone";

/** Who a token belongs to, asked of the network's plugin when no id_token says so. */
export type Identity = { accountId: string; accountLabel: string; scopes?: string[]; grantExpiresAt?: string };
export type Identify = (workspaceId: string, connection: string, accessToken: string) => Promise<Identity>;

export function connector(d: {
  rootKey: RootKey;
  now: () => Date;
  keys: Keyring;
  providerFor: (workspaceId: string, connection: string | null) => Promise<Provider | undefined>;
  identify?: Identify;
  callbackUrl?: string;
  timeoutMs: number;
}) {
  const { rootKey, now, keys } = d;
  const callbackUrl = () => {
    if (!d.callbackUrl) throw new Error("credentials: callbackUrl is not set");
    return d.callbackUrl;
  };

  function consentUrl(p: Provider, state: string, verifier: string) {
    const url = new URL(p.authorizeUrl);
    for (const [k, v] of Object.entries({
      client_id: p.clientId,
      redirect_uri: callbackUrl(),
      response_type: "code",
      ...(p.scopeSource === "fixed" ? {} : { scope: p.scopes.join(p.scopeSeparator ?? " ") }),
      state,
      ...(p.pkce === false ? {} : { code_challenge: pkceChallenge(verifier), code_challenge_method: "S256" }),
      ...p.extraParams,
    }))
      url.searchParams.set(k, v);
    return url.toString();
  }

  async function start(a: { workspaceId: string; userId: string; connection: string }): Promise<
    Done<{ url: string; cookie: string }> | Refusal<"unknown_connection">
  > {
    const p = await d.providerFor(a.workspaceId, a.connection);
    if (!p) return { ok: false, reason: "unknown_connection" };
    const state = randomToken();
    const verifier = randomToken();
    const cookie = sealState(rootKey, { ...a, state, verifier, expiresAt: now().getTime() + STATE_TTL_MS });
    return { ok: true, url: consentUrl(p, state, verifier), cookie };
  }

  /** A link for connecting from another device. The caller has checked step-up and that the connection may take links. */
  async function issueLink(a: { workspaceId: string; userId: string; connection: string }): Promise<
    Done<{ url: string; expiresAt: Date }> | Refusal<"unknown_connection" | "too_many_links">
  > {
    if (!(await d.providerFor(a.workspaceId, a.connection))) return { ok: false, reason: "unknown_connection" };
    const at = now();
    const token = randomToken();
    const expiresAt = new Date(at.getTime() + LINK_TTL_MS);
    return withWorkspace(a.workspaceId, async (tx) => {
      // ponytail: two issues at once can pass the count together; the cap is against piles of links, not one more.
      if ((await openLinkCount(tx, a.workspaceId, a.userId, a.connection, at)) >= MAX_OPEN_LINKS) return { ok: false as const, reason: "too_many_links" as const };
      await insertLink(tx, { workspaceId: a.workspaceId, issuedBy: a.userId, connection: a.connection, tokenHash: sha256(token), expiresAt, createdAt: at });
      return { ok: true as const, url: `${new URL(callbackUrl()).origin}/api/connect/${a.workspaceId}/${token}`, expiresAt };
    });
  }

  /** What an unclaimed link's page shows, or null for a link that no longer works. Writes nothing. */
  async function openLink(workspaceId: string, token: string) {
    if (!isWorkspaceId(workspaceId) || !isLinkToken(token)) return null;
    const row = await withWorkspace(workspaceId, (tx) => claimableLink(tx, workspaceId, sha256(token), now()));
    const issuer = row && (await memberOf(workspaceId, row.issuedBy));
    return row && issuer ? { id: row.id, connection: row.connection, workspaceName: row.workspaceName, issuerEmail: issuer.email, issuedBy: row.issuedBy } : null;
  }

  /** Claims a link and returns the network's consent URL, or null when it no longer works or another device was first. */
  async function claimLink(workspaceId: string, token: string): Promise<{ url: string } | null> {
    const link = await openLink(workspaceId, token);
    const p = link && (await d.providerFor(workspaceId, link.connection));
    if (!link || !p) return null;
    const state = linkState(workspaceId, randomToken());
    const verifier = randomToken();
    // The same sealed state a signed-in connect puts in its cookie, kept on the link instead, so the
    // callback works in whatever browser the network sends the person back to.
    const sealedState = sealState(rootKey, { state, verifier, workspaceId, userId: link.issuedBy, connection: link.connection, expiresAt: now().getTime() + STATE_TTL_MS });
    const claimed = await withWorkspace(workspaceId, (tx) => claimLinkRow(tx, workspaceId, link.id, now(), { stateHash: sha256(state), sealedState }));
    return claimed ? { url: consentUrl(p, state, verifier) } : null;
  }

  /** A person's links from the last day, for finishing on the device they made them on. */
  async function links(workspaceId: string, userId: string) {
    const at = now();
    const rows = await withWorkspace(workspaceId, (tx) => linksOf(tx, workspaceId, userId, new Date(at.getTime() - 24 * 60 * 60_000)));
    return rows.map((r) => ({ id: r.id, connection: r.connection, status: linkStatus(r, at, STATE_TTL_MS), expiresAt: r.expiresAt, credentialId: r.credentialId, accountName: r.accountName }));
  }

  /** Every refusal stores nothing; a token already granted is revoked. */
  async function callback(a: {
    cookie: string | undefined;
    sessionUserId: string;
    state?: string;
    code?: string;
    error?: string;
  }): Promise<Done<{ workspaceId: string; credential: CredentialMeta }> | Refusal<CallbackRefusal>> {
    const s = a.cookie ? openState(rootKey, a.cookie) : null;
    if (!s) return { ok: false, reason: "bad_cookie" };
    if (s.expiresAt <= now().getTime()) return { ok: false, reason: "expired" };
    if (a.state !== s.state) return { ok: false, reason: "state_mismatch" };
    if (a.sessionUserId !== s.userId) return { ok: false, reason: "wrong_user" };
    if (a.error || !a.code) return { ok: false, reason: "denied" };
    const { workspaceId, userId } = s;
    const p = await d.providerFor(workspaceId, s.connection);
    if (!p) return { ok: false, reason: "denied" };
    if (!(await withWorkspace(workspaceId, (tx) => isMember(tx, workspaceId, userId)))) return { ok: false, reason: "not_member" };

    const r = await exchangeCode(p, { code: a.code, verifier: s.verifier, redirectUri: callbackUrl() }, d.timeoutMs);
    if (!r.ok) return { ok: false, reason: "exchange_failed" };
    let t = r.tokens;
    const refuse = async (reason: CallbackRefusal, accountId?: string) => {
      await revokeToken(p, t.refreshToken ?? t.accessToken, d.timeoutMs, accountId);
      return { ok: false as const, reason };
    };
    if (p.longToken) {
      const long = await exchangeLongToken(p, t.accessToken, d.timeoutMs);
      if (!long.ok) return refuse("exchange_failed");
      t = { ...t, accessToken: long.tokens.accessToken, expiresIn: long.tokens.expiresIn, refreshToken: long.tokens.refreshToken ?? t.refreshToken, scope: long.tokens.scope ?? t.scope };
    }
    const expiresIn = t.expiresIn;
    if (expiresIn === undefined) return refuse("exchange_failed");

    // A provider with issuers states the account in its id_token, one with token identity in the token
    // response; any other is asked through its plugin.
    let email: string | null = null;
    let identity: Identity | null = null;
    if (p.issuers.length) {
      email = t.idToken ? idTokenEmail(p, t.idToken, now()) : null;
    } else if (p.tokenIdentity) {
      if (!t.account) return refuse("identity_failed");
      identity = { accountId: t.account.id, accountLabel: t.account.label };
    } else {
      identity = await (d.identify?.(workspaceId, p.connection, t.accessToken) ?? Promise.resolve(null)).catch(() => null);
      if (!identity) return refuse("identity_failed");
    }
    const accountId = identity?.accountId;
    const listed = p.scopeSource === "identity" ? (identity?.scopes ?? []) : (t.scope ?? "").split(p.scopeSeparator ?? " ").filter(Boolean);
    const granted = p.scopeSource === "fixed" || (!listed.length && p.scopeSource === "token_or_asked") ? [...p.scopes] : listed;
    if (!p.requiredScopes.every((sc) => granted.includes(sc))) return refuse("missing_scope", accountId);
    if (p.issuers.length && !email) return refuse("bad_id_token");
    if (!t.refreshToken && (p.renewal?.kind ?? "refresh_token") === "refresh_token") return refuse("no_refresh_token", accountId);

    const at = now();
    const tokenExpiry = new Date(at.getTime() + expiresIn * 1000);
    const parsed = parseKind(
      "oauth2",
      { ...(t.refreshToken ? { refreshToken: t.refreshToken } : {}), accessToken: t.accessToken, expiresAt: tokenExpiry.toISOString() },
      email
        ? { accountEmail: email, scopes: granted }
        : { accountId, accountLabel: identity!.accountLabel, ...(identity!.grantExpiresAt ? { grantExpiresAt: identity!.grantExpiresAt } : {}), scopes: granted },
    );
    if (!parsed.ok) return refuse("exchange_failed", accountId);
    const expiresAt = effectiveExpiry(tokenExpiry, identity?.grantExpiresAt);
    const name = email ?? identity!.accountLabel;

    const key = `${p.connection}:${email ?? accountId}`;
    return withWorkspace(workspaceId, async (tx) => {
      const existing = await findLiveUserKey(tx, workspaceId, userId, key);
      const id = existing?.id ?? crypto.randomUUID();
      const sealed = await keys.seal(tx, workspaceId, id, parsed.value);
      const row = existing
        ? (await updateLive(tx, workspaceId, id, existing.version, {
            ...sealed,
            // The account's own fields are fresh; anything saved beside them, such as a chosen property, stays.
            meta: { ...extraMeta("oauth2", existing.meta), ...parsed.meta },
            status: "active",
            expiresAt,
            updatedAt: at,
          }))!
        : await insertCredential(tx, {
            id,
            workspaceId,
            scope: "user",
            ownerUserId: userId,
            kind: "oauth2",
            key,
            name,
            connection: p.connection,
            meta: parsed.meta,
            ...sealed,
            expiresAt,
            createdBy: userId,
            createdAt: at,
            updatedAt: at,
          });
      await insertEvent(tx, { workspaceId, credentialId: id, consumer: "connect", actorUserId: userId, outcome: "ok", at });
      return { ok: true as const, workspaceId, credential: metadata(row) };
    });
  }

  /**
   * The callback of a connect started from a link, where there is no session and no cookie. The link
   * is used up first, so a replayed callback finds nothing; then the usual callback runs on the
   * link's sealed state, as the person who made the link.
   */
  async function linkCallback(a: { state?: string; code?: string; error?: string }): Promise<
    Done<{ workspaceId: string; credential: CredentialMeta }> | Refusal<CallbackRefusal>
  > {
    const workspaceId = linkWorkspace(a.state);
    if (!workspaceId) return { ok: false, reason: "link_gone" };
    const at = now();
    const link = await withWorkspace(workspaceId, (tx) => useLinkByState(tx, workspaceId, sha256(a.state!), at, new Date(at.getTime() - STATE_TTL_MS)));
    if (!link) return { ok: false, reason: "link_gone" };
    const issuer = await memberOf(workspaceId, link.issuedBy);
    if (!issuer || !can(issuer.role, "credential.connect")) return { ok: false, reason: "not_member" };
    const r = await callback({ ...a, cookie: link.sealedState, sessionUserId: link.issuedBy });
    if (r.ok) await withWorkspace(workspaceId, (tx) => setLinkCredential(tx, workspaceId, link.id, r.credential.id));
    return r;
  }

  /** Which connection a connect attempt was for, so its outcome can land on the right page. */
  const connectionOf = (cookie: string | undefined) => (cookie ? (openState(rootKey, cookie)?.connection ?? null) : null);

  return { start, callback, connectionOf, issueLink, openLink, claimLink, links, linkCallback };
}
