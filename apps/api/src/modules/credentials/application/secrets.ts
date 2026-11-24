// SPDX-License-Identifier: AGPL-3.0-only
// The secret store: create, rotate, delete and resolve. A value goes in through parseKind,
// is sealed with the Workspace's data key, and comes out only through resolve, which writes
// one access event per call and refreshes an expiring access token. Nothing here returns a
// refresh token.
import { createHmac, timingSafeEqual } from "node:crypto";
import type { RootKey } from "../adapters/crypto";
import { refreshTokens, revokeWithoutClient, renewToken, revokeToken, type AppProvider, type ClientPair, type Provider } from "../adapters/provider";
import { firstApp, type AppOwner, type AppSource, type OAuthApp } from "./apps";
import {
  findCredential,
  insertCredential,
  insertAudit,
  insertEvent,
  isUniqueViolation,
  listEvents,
  listLive,
  lockWorkspaceApp,
  markConnectionNeedsReauth,
  touchUsed,
  updateLive,
  withWorkspace,
  type WorkspaceTx,
} from "../adapters/repo";
import { dueForRenewal, effectiveExpiry } from "../domain/refresh";
import type { Scope } from "../domain/status";
import { notReady } from "./check";
import { connector, type ConnectProvider, type Identify } from "./connect";
import { approvalKeyStore } from "./approval-keys";
import { memberKeyStore } from "./member-keys";
import { keyring } from "./keys";
import { parseKind, parseMeta, type Kind, type KindRefusal, type Meta, type SecretValue } from "./kinds";
import { metadata, type CredentialMeta, type Done, type Refusal } from "./meta";

export type { CredentialMeta };

/** The connection a Workspace's own OAuth app serves, or null for any other credential. */
const appConnection = (row: { scope: string; kind: string; key: string | null }) =>
  row.scope === "workspace" && row.kind === "basic" && row.key?.startsWith("oauth_app:") ? row.key.slice("oauth_app:".length) : null;

export type ResolveConsumer = "execute" | "reconcile" | "query" | "poll" | "model_call" | "mcp_call" | "startup" | "webhook";

/** What a consumer may hold: the value, or for oauth2 only the access token. */
export type UsableValue = Exclude<SecretValue, SecretValue<"oauth2">> | Omit<SecretValue<"oauth2">, "refreshToken">;
export type Resolved = { kind: Kind; value: UsableValue; meta: Meta };

/** What a plugin receives for one call, in the SDK's Credential shape. */
export type PluginCredential =
  | { accessToken: string; expiresAt: string }
  | { key: string }
  | { headerName: string; value: string }
  | { username: string; password: string }
  | { value: string };
export type CredentialUse = {
  consumer: "execute" | "reconcile" | "query" | "poll";
  actionId?: string;
  /** When set, the credential must have been connected for one of these connections (ADR 0026 rule 008). */
  connections?: readonly string[];
};


export type CreateInput = {
  workspaceId: string;
  /** Null only for an operator setting the system Workspace's values. */
  actorUserId: string | null;
  scope: Scope;
  kind: Kind;
  key: string;
  name: string;
  description?: string | null;
  meta: unknown;
  value: unknown;
  /** Set for a credential that is an account with a provider, such as a Mailbox. */
  connection?: string;
};

export type VaultDeps = {
  rootKey: RootKey;
  now: () => Date;
  /** Fixed client pairs take precedence over the app lookup. Their default owner is the deployment. */
  providers?: (Provider & { appOwner?: Exclude<AppOwner, "workspace"> })[];
  /** Providers whose client pair comes from the Workspace's own app, then `appSources`. */
  appProviders?: AppProvider[];
  /** Where an app comes from when the Workspace has none of its own, in order. */
  appSources?: readonly AppSource[];
  identify?: Identify;
  /** The fixed OAuth redirect, `<base URL>/api/connections/callback`. */
  callbackUrl?: string;
  /** For every call to a provider. */
  timeoutMs?: number;
  /** After a reconnect or rotation commits; the composition root passes ledger.resumeHeld. */
  onReady?: (workspaceId: string, credentialId: string) => Promise<unknown>;
};

type Resolve = (workspaceId: string, id: string, consumer: ResolveConsumer, actionId?: string) => Promise<Resolved | null>;
const resolvers = new WeakMap<object, Resolve>();

/** The resolve function behind a vault, for use-secret.ts and the plugin seam only. */
export function resolverOf(vault: Vault): Resolve {
  return resolvers.get(vault)!;
}

export type Vault = ReturnType<typeof createVault>;

export function createVault(deps: VaultDeps) {
  const { now } = deps;
  const providers = deps.providers ?? [];
  const timeoutMs = deps.timeoutMs ?? 10_000;
  const keys = keyring(deps.rootKey, now);
  const appProviders = deps.appProviders ?? [];
  const appSources = deps.appSources ?? [];
  const fixedProviderFor = (connection: string | null) => providers.find((p) => p.connection === connection);
  const templateFor = (connection: string | null) => fixedProviderFor(connection) ?? appProviders.find((p) => p.connection === connection);

  type WorkspaceApp = ClientPair & { ownAppVersion: string };

  /** A Workspace's own app is a workspace-scoped basic credential: the client id as username, the secret as password. */
  async function workspaceApp(tx: WorkspaceTx, workspaceId: string, connection: string): Promise<WorkspaceApp | null> {
    const row = (await listLive(tx, workspaceId)).find((c) => c.scope === "workspace" && c.kind === "basic" && c.key === `oauth_app:${connection}`);
    if (!row) return null;
    const value = (await keys.open(tx, row)) as SecretValue<"basic"> | null;
    const clientId = (row.meta as { username?: string }).username;
    return value && clientId ? { clientId, clientSecret: value.password, ownAppVersion: `${row.id}:${row.version}` } : null;
  }

  /** The app a new connect would use: the Workspace's own, else the first source's. */
  type SourcedApp = ClientPair & { owner: AppOwner; ownAppVersion?: string };
  const readOwnApp = (workspaceId: string, connection: string) =>
    withWorkspace(workspaceId, (tx) => workspaceApp(tx, workspaceId, connection));
  const sourcedApp = async (ownApp: WorkspaceApp | null, outside: () => Promise<OAuthApp | null>): Promise<SourcedApp | null> =>
    ownApp ? { ...ownApp, owner: "workspace" } : outside();
  const currentApp = async (workspaceId: string, connection: string) =>
    sourcedApp(await readOwnApp(workspaceId, connection), () => firstApp(appSources, { workspaceId, connection }));

  type ProviderFor = (connection: string | null) => Promise<ConnectProvider | undefined>;
  async function resolveProvider(connection: string | null, app: (connection: string) => Promise<SourcedApp | null>): Promise<ConnectProvider | undefined> {
    const fixed = fixedProviderFor(connection);
    if (fixed || !connection) return fixed;
    const template = appProviders.find((p) => p.connection === connection);
    if (!template) return undefined;
    const found = await app(connection);
    if (!found) return undefined;
    const { clientId, clientSecret, ownAppVersion } = found;
    return { ...template, clientId, clientSecret, ...(ownAppVersion === undefined ? {} : { ownAppVersion }) };
  }

  const providerFor = (workspaceId: string, connection: string | null) =>
    resolveProvider(connection, (name) => currentApp(workspaceId, name));

  class NeedSourcedApp extends Error {
    constructor(readonly connection: string) { super("Read the app sources outside the Workspace transaction"); }
  }

  // A source may itself need a vault checkout, as the deployment app does in the system
  // Workspace. Release this connection before reading the sources, then retry from the start
  // (including readiness, lock and own-app precedence). The lookup must be requested before
  // any provider call or write.
  async function withProviderWorkspace<T>(workspaceId: string, run: (tx: WorkspaceTx, provider: ProviderFor) => Promise<T>): Promise<T> {
    const fallback = new Map<string, OAuthApp | null>();
    for (;;) {
      try {
        return await withWorkspace(workspaceId, (tx) =>
          run(tx, (connection) => resolveProvider(connection, async (name) =>
            sourcedApp(await workspaceApp(tx, workspaceId, name), async () => {
              if (!appSources.length) return null;
              if (!fallback.has(name)) throw new NeedSourcedApp(name);
              return fallback.get(name) ?? null;
            }))));
      } catch (e) {
        if (!(e instanceof NeedSourcedApp)) throw e;
        fallback.set(e.connection, await firstApp(appSources, { workspaceId, connection: e.connection }));
      }
    }
  }

  // Take the app lock before its row lock, in the same order as callback completion.
  async function findForWrite(tx: WorkspaceTx, workspaceId: string, id: string) {
    const row = await findCredential(tx, workspaceId, id);
    if (!row || row.deletedAt) return null;
    const app = appConnection(row);
    if (app) await lockWorkspaceApp(tx, workspaceId, app);
    return findCredential(tx, workspaceId, id, true);
  }

  async function persistGrant<T>(workspaceId: string, selected: ConnectProvider, save: (tx: WorkspaceTx) => Promise<T>): Promise<T | null> {
    if (!appProviders.some((p) => p.connection === selected.connection) || providers.some((p) => p.connection === selected.connection)) {
      return withWorkspace(workspaceId, save);
    }
    return withProviderWorkspace(workspaceId, async (tx, provider) => {
      await lockWorkspaceApp(tx, workspaceId, selected.connection);
      const current = await provider(selected.connection);
      if (!current || current.ownAppVersion !== selected.ownAppVersion
        || current.clientId !== selected.clientId || current.clientSecret !== selected.clientSecret) return null;
      return save(tx);
    });
  }

  async function create(
    input: CreateInput,
  ): Promise<Done<{ credential: CredentialMeta }> | Refusal<KindRefusal | "oauth2_needs_connect" | "duplicate_key">> {
    // An oauth2 credential only comes from the connect flow, which knows its connection.
    if (input.kind === "oauth2") return { ok: false, reason: "oauth2_needs_connect" };
    const parsed = parseKind(input.kind, input.value, input.meta);
    if (!parsed.ok) return parsed;
    const { workspaceId, actorUserId } = input;
    const id = crypto.randomUUID();
    try {
      return await withWorkspace(workspaceId, async (tx) => {
        const app = appConnection(input);
        if (app) await lockWorkspaceApp(tx, workspaceId, app);
        const sealed = await keys.seal(tx, workspaceId, id, parsed.value);
        const at = now();
        const row = await insertCredential(tx, {
          id,
          workspaceId,
          scope: input.scope,
          ownerUserId: input.scope === "user" ? actorUserId : null,
          kind: input.kind,
          connection: input.connection ?? null,
          key: input.key,
          name: input.name,
          description: input.description ?? null,
          meta: parsed.meta,
          ...sealed,
          createdBy: actorUserId,
          createdAt: at,
          updatedAt: at,
        });
        await insertEvent(tx, { workspaceId, credentialId: id, consumer: "create", actorUserId, outcome: "ok", at });
        // A refresh token works only for the client it was issued to, so a new app means reconnecting.
        if (app) await markConnectionNeedsReauth(tx, workspaceId, app, at);
        return { ok: true as const, credential: metadata(row) };
      });
    } catch (e) {
      if (isUniqueViolation(e)) return { ok: false, reason: "duplicate_key" };
      throw e;
    }
  }

  async function rotate(input: {
    workspaceId: string;
    id: string;
    version: number;
    value: unknown;
    actorUserId: string | null;
  }): Promise<Done<{ credential: CredentialMeta }> | Refusal<"missing" | "oauth2_needs_connect" | "stale_version" | KindRefusal>> {
    const { workspaceId, id, actorUserId } = input;
    const r = await withWorkspace(workspaceId, async (tx): Promise<
      Done<{ credential: CredentialMeta }> | Refusal<"missing" | "oauth2_needs_connect" | "stale_version" | KindRefusal>
    > => {
      const row = await findForWrite(tx, workspaceId, id);
      if (!row || row.deletedAt) return { ok: false, reason: "missing" };
      // A mailbox gets a new token by reconnecting, not by pasting one.
      if (row.kind === "oauth2") return { ok: false, reason: "oauth2_needs_connect" };
      const parsed = parseKind(row.kind as Kind, input.value, row.meta);
      if (!parsed.ok) return parsed;
      const at = now();
      const updated = await updateLive(tx, workspaceId, id, input.version, {
        ...(await keys.seal(tx, workspaceId, id, parsed.value)),
        // A new secret answers "reconnect needed". A revoked credential stays revoked.
        ...(row.status === "needs_reauth" ? { status: "active" } : {}),
        updatedAt: at,
        lastRotatedAt: at,
      });
      if (!updated) return { ok: false, reason: "stale_version" };
      await insertEvent(tx, { workspaceId, credentialId: id, consumer: "rotate", actorUserId, outcome: "ok", at });
      return { ok: true, credential: metadata(updated) };
    });
    if (r.ok) await deps.onReady?.(workspaceId, id);
    return r;
  }

  /**
   * Soft delete: the ciphertext is nulled and the row kept, so its access history stays.
   * A mailbox is revoked at its provider first; a failed revoke is recorded, not blocking.
   */
  async function remove(input: {
    workspaceId: string;
    id: string;
    actorUserId: string | null;
    stepUp?: boolean;
  }): Promise<Done<object> | Refusal<"missing">> {
    const { workspaceId, id, actorUserId } = input;
    return withProviderWorkspace(workspaceId, async (tx, provider) => {
      const row = await findForWrite(tx, workspaceId, id);
      if (!row || row.deletedAt) return { ok: false, reason: "missing" };
      let revoked = true;
      if (row.kind === "oauth2") {
        const value = (await keys.open(tx, row)) as SecretValue<"oauth2"> | null;
        const template = templateFor(row.connection);
        const p = template && revokeWithoutClient(template) ? template : await provider(row.connection);
        const accountId = (row.meta as { accountId?: string }).accountId;
        revoked = value && p ? await revokeToken(p, value.refreshToken ?? value.accessToken, timeoutMs, accountId) : false;
      }
      const at = now();
      await updateLive(tx, workspaceId, id, row.version, { ciphertext: null, nonce: null, deletedAt: at, updatedAt: at });
      // Tokens issued to the removed app don't work with the one that replaces it.
      const app = appConnection(row);
      if (app) await markConnectionNeedsReauth(tx, workspaceId, app, at);
      await insertEvent(tx, {
        workspaceId,
        credentialId: id,
        consumer: row.kind === "oauth2" ? "disconnect" : "delete",
        actorUserId,
        outcome: revoked ? "ok" : "error",
        errorCode: revoked ? null : "revoke_failed",
        at,
      });
      // Removing someone else's credential is a membership-level act, so it is audited too.
      if (row.scope === "user" && row.ownerUserId !== actorUserId) {
        await insertAudit(tx, {
          workspaceId,
          event: "credential.deleted",
          subjectUserId: row.ownerUserId,
          stepUp: input.stepUp ?? false,
          actorUserId,
          at,
        });
      }
      return { ok: true };
    });
  }

  /** Metadata of every live credential. */
  const list = (workspaceId: string) => withWorkspace(workspaceId, async (tx) => (await listLive(tx, workspaceId)).map(metadata));

  /** Metadata of one live credential, or null. */
  const find = (workspaceId: string, id: string) =>
    withWorkspace(workspaceId, async (tx) => {
      const row = await findCredential(tx, workspaceId, id);
      return row && !row.deletedAt ? metadata(row) : null;
    });

  /** Access history, newest first. */
  const events = (workspaceId: string, id: string, limit = 100) =>
    withWorkspace(workspaceId, async (tx) =>
      (await listEvents(tx, workspaceId, id, limit)).map((e) => ({
        consumer: e.consumer,
        outcome: e.outcome,
        errorCode: e.errorCode,
        actionId: e.actionId,
        actorUserId: e.actorUserId,
        at: e.at,
      })),
    );

  type Outcome = { outcome: "ok" | "refreshed"; value: SecretValue } | { outcome: "needs_reauth" | "error"; code: string };

  /** Under the row lock: another worker may have refreshed while this one waited. */
  async function refreshLocked(tx: WorkspaceTx, workspaceId: string, id: string, provider: ProviderFor): Promise<Outcome> {
    const row = (await findCredential(tx, workspaceId, id, true))!;
    const current = (await keys.open(tx, row)) as SecretValue<"oauth2"> | null;
    if (!current) return { outcome: "error", code: "decrypt_failed" };
    const expiry = new Date(current.expiresAt);
    const template = templateFor(row.connection);
    const kind = template?.renewal?.kind ?? "refresh_token";
    if (!dueForRenewal(kind === "self_renew", expiry, now())) return { outcome: "ok", value: current };
    const expired = expiry <= now();
    const needsReauth = async (code: string): Promise<Outcome> => {
      await updateLive(tx, workspaceId, id, row.version, { status: "needs_reauth", updatedAt: now() });
      return { outcome: "needs_reauth", code };
    };
    // Nothing can renew this token, so it works until it expires and then a person reconnects.
    if (template && (kind === "reconnect" || (kind === "refresh_token" && !current.refreshToken))) {
      return expired ? needsReauth("token_expired") : { outcome: "ok", value: current };
    }
    const p = await provider(row.connection);
    if (!p) return { outcome: "error", code: "no_provider" };
    const r = kind === "self_renew" ? await renewToken(p, current.accessToken, timeoutMs) : await refreshTokens(p, current.refreshToken!, timeoutMs);
    const at = now();
    if (!r.ok) {
      if (r.error === "invalid_grant") return needsReauth("invalid_grant");
      if (kind !== "self_renew") return { outcome: "error", code: "refresh_failed" };
      // A self-renewing token is renewed early, so it still works until it really expires.
      return expired ? needsReauth("token_expired") : { outcome: "ok", value: current };
    }
    const tokenExpiry = new Date(at.getTime() + r.tokens.expiresIn * 1000);
    // A provider that rotates refresh tokens sends a new one; keep the old one otherwise.
    const refreshToken = r.tokens.refreshToken ?? current.refreshToken;
    const next = { ...(refreshToken ? { refreshToken } : {}), accessToken: r.tokens.accessToken, expiresAt: tokenExpiry.toISOString() };
    const expiresAt = effectiveExpiry(tokenExpiry, (row.meta as { grantExpiresAt?: string }).grantExpiresAt);
    await updateLive(tx, workspaceId, id, row.version, { ...(await keys.seal(tx, workspaceId, id, next)), expiresAt, updatedAt: at });
    return { outcome: "refreshed", value: next };
  }

  /**
   * The value for one host-made call, or null. Writes exactly one access event for any
   * credential this Workspace holds; an id it does not hold has no row to name and
   * returns null without one.
   */
  async function resolve(workspaceId: string, id: string, consumer: ResolveConsumer, actionId?: string, connections?: readonly string[]): Promise<Resolved | null> {
    return withProviderWorkspace(workspaceId, async (tx, provider) => {
      const row = await findCredential(tx, workspaceId, id);
      if (!row) return null;
      const event = (outcome: "ok" | "refreshed" | "needs_reauth" | "refused" | "error", errorCode: string | null = null) =>
        insertEvent(tx, { workspaceId, credentialId: id, consumer, actionId: actionId ?? null, outcome, errorCode, at: now() });
      // A plugin gets only a credential connected for its own connection, never another plugin's.
      if (connections && !connections.includes(row.connection ?? "")) {
        await event("refused", "wrong_connection");
        return null;
      }

      const why = await notReady(tx, row);
      if (why) {
        await event(why === "needs_reauth" ? "needs_reauth" : "refused", why);
        return null;
      }

      let r: Outcome;
      const value = await keys.open(tx, row);
      if (!value) r = { outcome: "error", code: "decrypt_failed" };
      else if (row.kind === "oauth2" && dueForRenewal(templateFor(row.connection)?.renewal?.kind === "self_renew", new Date((value as SecretValue<"oauth2">).expiresAt), now()))
        r = await refreshLocked(tx, workspaceId, id, provider);
      else r = { outcome: "ok", value };

      if (!("value" in r)) {
        await event(r.outcome, r.code);
        return null;
      }
      await touchUsed(tx, workspaceId, id, now());
      await event(r.outcome);
      // Form connections already store the verified DID in their credential key, including older email logins.
      // Carry it to the Bluesky query as a public identifier without changing the stored sign-in name.
      const did = consumer === "query" && row.kind === "basic" && row.connection === "bluesky" && row.key.startsWith("bluesky:did:") ? row.key.slice("bluesky:".length) : undefined;
      const meta = row.meta as Meta;
      return { kind: row.kind as Kind, value: usable(row.kind as Kind, r.value), meta: did ? { ...(meta as Meta<"basic">), accountId: did } : meta };
    });
  }

  /** The plugin seam: one credential for one host-started call, or null. */
  async function credentials(workspaceId: string, credentialId: string | null, use: CredentialUse): Promise<PluginCredential | null> {
    if (!credentialId) return null;
    const r = await resolve(workspaceId, credentialId, use.consumer, use.actionId, use.connections);
    return r && toPlugin(r);
  }

  const connect = connector({ ...deps, timeoutMs, keys, providerFor, persistGrant });

  // resolve is not a property: only use-secret.ts and the plugin seam reach it.
  // A reconnect resumes the mailbox's held work.
  const callback: typeof connect.callback = async (a) => {
    const r = await connect.callback(a);
    if (r.ok) await deps.onReady?.(r.workspaceId, r.credential.id);
    return r;
  };
  const linkCallback: typeof connect.linkCallback = async (a) => {
    const r = await connect.linkCallback(a);
    if (r.ok) await deps.onReady?.(r.workspaceId, r.credential.id);
    return r;
  };
  const { issueLink, openLink, claimLink, links } = connect;

  /** Who owns the app a new connect would use here, without using it. */
  const appOwner = async (workspaceId: string, connection: string): Promise<AppOwner | null> => {
    const fixed = fixedProviderFor(connection);
    if (fixed) return fixed.appOwner ?? "deployment";
    return (await currentApp(workspaceId, connection))?.owner ?? null;
  };

  /** Whose app a connection would use here: the Workspace's own, or any other owner's. */
  async function appSource(workspaceId: string, connection: string): Promise<"own" | "system" | null> {
    const owner = await appOwner(workspaceId, connection);
    return owner === null ? null : owner === "workspace" ? "own" : "system";
  }

  /** A network said this token no longer works. A reconnect makes it active again and resumes held work. */
  const markNeedsReauth = (workspaceId: string, id: string) =>
    withWorkspace(workspaceId, async (tx) => {
      const row = await findCredential(tx, workspaceId, id, true);
      if (row && !row.deletedAt && row.status === "active") await updateLive(tx, workspaceId, id, row.version, { status: "needs_reauth", updatedAt: now() });
    });

  /**
   * Sets one plain field in a live credential's meta and keeps the rest; setting it again
   * replaces it. The kind's meta rules apply, so a secret-looking name, or a kind that takes no
   * extra fields, is refused.
   */
  const setMeta = (workspaceId: string, id: string, name: string, value: string): Promise<Done<{ credential: CredentialMeta }> | Refusal<"missing" | KindRefusal>> =>
    withWorkspace(workspaceId, async (tx) => {
      const row = await findForWrite(tx, workspaceId, id);
      if (!row || row.deletedAt) return { ok: false, reason: "missing" };
      const parsed = parseMeta(row.kind as Kind, { ...(row.meta as object), [name]: value });
      if (!parsed.ok) return parsed;
      const updated = await updateLive(tx, workspaceId, id, row.version, { meta: parsed.meta, updatedAt: now() });
      return updated ? { ok: true, credential: metadata(updated) } : { ok: false, reason: "missing" };
    });

  /**
   * Whether `signature` (64 lowercase hex) is the HMAC-SHA256 of `body` under a secret
   * credential's value. For inbound webhooks: the value is used here and never handed out.
   */
  async function verifyHmac(workspaceId: string, id: string, body: Uint8Array, signature: string): Promise<boolean> {
    if (!/^[0-9a-f]{64}$/.test(signature)) return false;
    const r = await resolve(workspaceId, id, "webhook");
    if (r?.kind !== "secret" || !("value" in r.value)) return false;
    return timingSafeEqual(Buffer.from(signature, "hex"), createHmac("sha256", r.value.value).update(body).digest());
  }

  const vault = { appOwner, appSource, markNeedsReauth, setMeta, approvalKeys: approvalKeyStore(keys, now), memberKeys: memberKeyStore(keys, now), create, rotate, remove, list, find, events, start: connect.start, callback, connectionOf: connect.connectionOf, issueLink, openLink, claimLink, links, linkCallback, credentials, verifyHmac };
  resolvers.set(vault, resolve);
  return vault;
}

function toPlugin(r: Resolved): PluginCredential {
  const v = r.value as Record<string, string>;
  const m = r.meta as Record<string, string>;
  switch (r.kind) {
    case "oauth2":
      return { accessToken: v.accessToken!, expiresAt: v.expiresAt! };
    case "api_key":
      return { key: v.key! };
    case "header":
      return { headerName: m.headerName!, value: v.value! };
    case "basic": {
      const { username, ...settings } = m;
      return { username: username!, password: v.password!, ...(Object.keys(settings).length ? { settings } : {}) };
    }
    case "secret":
      return { value: v.value! };
  }
}

function usable(kind: Kind, value: SecretValue): UsableValue {
  if (kind !== "oauth2") return value as UsableValue;
  const { accessToken, expiresAt } = value as SecretValue<"oauth2">;
  return { accessToken, expiresAt };
}
