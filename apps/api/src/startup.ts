// SPDX-License-Identifier: AGPL-3.0-only
// What the API and the worker do before anything else: find the root key, then read the
// deployment's secrets from the vault. A value left in env stops the start, so nobody believes
// it is in use.
import { randomBytes } from "node:crypto";
import { join } from "node:path";
import { createVault, dataDir, ensureRootKey, migrationsPending, rootKeyFromEnv, type MigrationState } from "./modules/credentials/index";
import { ensureSystemWorkspace, readSystemSecret, setSystemSecret, suppressionHasher } from "./modules/credentials/system-secrets";
import { authConfigFromEnv, isDevOrTest, type AuthConfig } from "./modules/identity/index";
import { diskStore, parseS3Url, s3Store } from "./modules/media/index";
import { deploymentFromEnv } from "./modules/models/index";
import { assertRoleAllowed, assertSharedMedia, roleFromEnv } from "./roles";

type Env = Record<string, string | undefined>;

export const SECRETS_COMMAND = "bun apps/api/src/secrets.ts set";

const RETIRED: Record<string, string> = {
  ANTHROPIC_API_KEY: "provider.anthropic",
  OPENAI_API_KEY: "provider.openai",
  GOOGLE_GENERATIVE_AI_API_KEY: "provider.google",
  OPENROUTER_API_KEY: "provider.openrouter",
  DIREX_AUTH_SECRET: "auth.secret",
  DIREX_SMTP_URL: "smtp.url",
  DIREX_GOOGLE_CLIENT_SECRET: "signin.google",
  DIREX_MICROSOFT_CLIENT_SECRET: "signin.microsoft",
};

/** In dev and test these are ignored instead, since a developer's shell often exports them. */
export function refuseRetiredEnv(env: Env): void {
  if (isDevOrTest(env)) return;
  for (const [variable, name] of Object.entries(RETIRED)) {
    if (env[variable]) throw new Error(`${variable} is no longer read from the environment. Unset it and run: ${SECRETS_COMMAND} ${name}`);
  }
}

/** Dev uses a public auth secret and unverified sign-ups, so it must not be reachable from the network. */
export const listenHost = (env: Env = process.env): string | undefined => (isDevOrTest(env) ? "127.0.0.1" : undefined);

/** Direx never starts against a database between two versions (ADR 0029 rule 008). */
export function refusePendingMigrations({ pending, unknown }: MigrationState): void {
  if (unknown.length) throw new Error(`the database has ${unknown.length} migration(s) this version does not know; it is newer than this code. Start the matching version of Direx`);
  if (pending.length) throw new Error(`migrations are not applied (${pending.length} pending). Stop Direx, run: bun run db:migrate, then start it`);
}

type Fetch = (req: Request) => Response | Promise<Response>;

/**
 * Sign-in is rate limited by X-Forwarded-For, which a client can set to anything. So the socket's
 * address replaces it. With trusted proxies named, it is added to the end instead, and Better Auth
 * walks back past the proxies to the first address it has no reason to believe was forged.
 */
export const withClientIp =
  (fetch: Fetch, proxies: string[]) =>
  (req: Request, server: { requestIP(req: Request): { address: string } | null }) => {
    const forwarded = proxies.length ? req.headers.get("x-forwarded-for") : null;
    const chain = [forwarded, server.requestIP(req)?.address].filter(Boolean).join(", ");
    if (chain) req.headers.set("x-forwarded-for", chain);
    else req.headers.delete("x-forwarded-for");
    return fetch(req);
  };

export async function loadDeployment(env: Env = process.env, log: (line: string) => void = console.log): Promise<AuthConfig> {
  // First, so a refused split start never generates a root key file (ADR 0027 rule 005).
  assertRoleAllowed(roleFromEnv(env), deploymentFromEnv(env), env);
  refuseRetiredEnv(env);
  refusePendingMigrations(await migrationsPending());
  const rootKey = await ensureRootKey(env, log);
  const vault = createVault({ rootKey, now: () => new Date() });
  await ensureSystemWorkspace();

  let authSecret = await readSystemSecret(vault, "auth.secret", "startup");
  if (!authSecret && !isDevOrTest(env)) {
    await setSystemSecret(vault, "auth.secret", randomBytes(32).toString("hex"), { ifMissing: true });
    authSecret = await readSystemSecret(vault, "auth.secret", "startup");
  }
  const smtpUrl = await readSystemSecret(vault, "smtp.url", "startup");
  const googleSecret = await readSystemSecret(vault, "signin.google", "startup");
  const microsoftSecret = await readSystemSecret(vault, "signin.microsoft", "startup");
  return authConfigFromEnv(env, { authSecret: authSecret ?? undefined, smtpUrl: smtpUrl ?? undefined, googleSecret: googleSecret ?? undefined, microsoftSecret: microsoftSecret ?? undefined });
}

/**
 * The stored SMTP URL, for `bun run doctor`. Unlike `loadDeployment` it makes no key or secret: it
 * needs the root key the deployment already has. The read is recorded as an access, as every vault read is.
 */
export async function storedSmtpUrl(env: Env = process.env): Promise<string | null> {
  const vault = createVault({ rootKey: rootKeyFromEnv(env), now: () => new Date() });
  return readSystemSecret(vault, "smtp.url", "startup");
}

/** Where uploaded files go on object storage, or null to keep them on disk. Read once, at start. */
export async function mediaS3Url(env: Env = process.env): Promise<string | null> {
  const vault = createVault({ rootKey: await ensureRootKey(env, () => undefined), now: () => new Date() });
  const url = await readSystemSecret(vault, "media.s3", "startup");
  assertSharedMedia(roleFromEnv(env), url);
  return url;
}

/**
 * What `bun run server-admin purge` needs beside the owner's connection: the store the Workspace's files
 * are in, as the server finds it, and the hash its opt-outs are kept as. Needs the root key already in
 * place; makes none.
 */
export async function purgeDeps(env: Env = process.env) {
  const vault = createVault({ rootKey: rootKeyFromEnv(env), now: () => new Date() });
  const s3 = await readSystemSecret(vault, "media.s3", "startup");
  const dir = dataDir(env);
  if (!s3 && !dir) throw new Error("media: set DIREX_DATA_DIR, or HOME for ~/.direx, as the server has it, so the purge finds the files");
  return { store: s3 ? s3Store(parseS3Url(s3)) : diskStore(join(dir!, "media")), hasher: suppressionHasher(vault) };
}
