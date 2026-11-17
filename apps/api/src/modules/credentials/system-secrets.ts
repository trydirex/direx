// SPDX-License-Identifier: AGPL-3.0-only
// The deployment's own secrets: Direx's provider keys, the auth secret and the SMTP URL. They
// live in one system Workspace with no members, so no route reaches them. Its own entry point
// so dependency-cruiser can limit it to startup, the command and models.
import { createHmac, randomBytes } from "node:crypto";
import { ensureSystemWorkspaceRows, withWorkspace } from "./adapters/repo";
import type { ResolveConsumer, Vault } from "./application/secrets";
import { useSecret } from "./use-secret";

export const SYSTEM_WORKSPACE_ID = "00000000-0000-4000-8000-00000000d1e0";
const SYSTEM_ORG_ID = "00000000-0000-4000-8000-00000000d1e1";

const KINDS = {
  "provider.anthropic": "api_key",
  "provider.openai": "api_key",
  "provider.google": "api_key",
  "provider.openrouter": "api_key",
  "auth.secret": "secret",
  "smtp.url": "secret",
  // The client secret of the OAuth app people sign in with. Its client id is not secret and stays in env.
  "signin.google": "secret",
  "signin.microsoft": "secret",
  // Object storage for uploaded files, as https://<access key>:<secret>@<host>/<bucket>?region=<region>.
  "media.s3": "secret",
  // The key a purged Workspace's opt-outs are hashed under (ADR 0030 Q6). Made by the first purge that
  // needs it and never changed, since a new key would lose every hash made with the old one.
  "suppression.key": "secret",
} as const;

// A network's app on cloud, as "<client id>:<client secret>". Open-ended, so core names no network.
const SOCIAL_APP = /^social_app\.[a-z0-9_-]{1,40}$/;
export type SystemSecretName = keyof typeof KINDS | `social_app.${string}`;
export const SYSTEM_SECRET_NAMES = Object.keys(KINDS) as SystemSecretName[];
export const isSystemSecretName = (s: string): s is SystemSecretName => s in KINDS || SOCIAL_APP.test(s);
const kindOf = (name: SystemSecretName) => (name in KINDS ? KINDS[name as keyof typeof KINDS] : "secret");

/** The deployment's own app for a network, or null. The client id holds no colon. */
export async function readSystemApp(vault: Vault, connection: string): Promise<{ clientId: string; clientSecret: string } | null> {
  const value = await readSystemSecret(vault, `social_app.${connection}`, "query");
  const at = value?.indexOf(":") ?? -1;
  return value && at > 0 ? { clientId: value.slice(0, at), clientSecret: value.slice(at + 1) } : null;
}

export const ensureSystemWorkspace = (now = new Date()) =>
  withWorkspace(SYSTEM_WORKSPACE_ID, (tx) => ensureSystemWorkspaceRows(tx, SYSTEM_WORKSPACE_ID, SYSTEM_ORG_ID, now));

const stored = async (vault: Vault, name: SystemSecretName) => (await vault.list(SYSTEM_WORKSPACE_ID)).find((c) => c.key === name);

/** Which names have a value, and when each last changed. Never a value. */
export async function listSystemSecrets(vault: Vault) {
  const rows = await vault.list(SYSTEM_WORKSPACE_ID);
  return rows.filter((c) => isSystemSecretName(c.key)).map((c) => ({ name: c.key as SystemSecretName, updatedAt: c.updatedAt }));
}

/** The value, recorded as an access event; null when none is set. */
export async function readSystemSecret(vault: Vault, name: SystemSecretName, consumer: ResolveConsumer): Promise<string | null> {
  const row = await stored(vault, name);
  if (!row) return null;
  return useSecret(vault, SYSTEM_WORKSPACE_ID, row.id, consumer, async (v) => {
    if ("key" in v) return v.key;
    return "value" in v ? v.value : null;
  });
}

/** Sets or replaces a value. `ifMissing` keeps whatever another process stored first. */
export async function setSystemSecret(vault: Vault, name: SystemSecretName, value: string, opts: { ifMissing?: boolean } = {}): Promise<void> {
  await ensureSystemWorkspace();
  const kind = kindOf(name);
  const wrapped = kind === "api_key" ? { key: value } : { value };
  const existing = await stored(vault, name);
  if (!existing) {
    const r = await vault.create({ workspaceId: SYSTEM_WORKSPACE_ID, actorUserId: null, scope: "workspace", kind, key: name, name, meta: {}, value: wrapped });
    if (r.ok || (r.reason === "duplicate_key" && opts.ifMissing)) return;
    if (r.reason !== "duplicate_key") throw new Error(`could not store ${name}: ${r.reason}`);
  } else if (opts.ifMissing) return;
  const row = (await stored(vault, name))!;
  const r = await vault.rotate({ workspaceId: SYSTEM_WORKSPACE_ID, id: row.id, version: row.version, value: wrapped, actorUserId: null });
  if (!r.ok) throw new Error(`could not store ${name}: ${r.reason}`);
}

/** HMAC-SHA256 of a trimmed, lower-cased address under suppression.key, as hex. */
export type SuppressionHasher = (create?: boolean) => Promise<((address: string) => string) | null>;

/**
 * The hash a purged Workspace's opt-outs are kept as, or null while no purge has made the key. `create`
 * makes the key first; only the purge asks for that. The key never changes, so once read it is kept.
 */
export function suppressionHasher(vault: Vault): SuppressionHasher {
  let key: string | null = null;
  return async (create = false) => {
    if (!key && create) await setSystemSecret(vault, "suppression.key", randomBytes(32).toString("hex"), { ifMissing: true });
    key ??= await readSystemSecret(vault, "suppression.key", "query");
    const k = key;
    return k ? (address) => createHmac("sha256", k).update(address.trim().toLowerCase()).digest("hex") : null;
  };
}
