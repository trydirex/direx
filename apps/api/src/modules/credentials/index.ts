// SPDX-License-Identifier: AGPL-3.0-only
// The credential vault: every secret a Workspace stores, encrypted with that Workspace's
// key and handed only to host code that makes the outside call. useSecret has its own
// entry point, use-secret.ts. The ledger takes credentialReady as a check and
// credentialLabel as the "credential" resolver.
import { rootKeyFromEnv } from "./adapters/crypto";
import type { AppProvider } from "./adapters/provider";
import { createVault, type VaultDeps } from "./application/secrets";
import { readSystemApp } from "./system-secrets";

export { suppressionHasher, type SuppressionHasher } from "./system-secrets";

export { credentialLabel, credentialReady, credentialSettings } from "./application/check";
export { createVault, type CredentialMeta, type Vault } from "./application/secrets";
export type { AppProvider } from "./adapters/provider";
export type { Identify, Identity } from "./application/connect";
export { credentialRoutes, type CheckMailbox, type CredentialRouteDeps, type KeyConnect, type MailboxConnect } from "./routes";
export { dataDir, generateKeyFile, rootKeyFromEnv, type RootKey } from "./adapters/crypto";
export { ensureRootKey, replaceRootKey, rootKeyProblem } from "./application/root-key";
export { migrationsPending, type MigrationState } from "./adapters/repo";

/**
 * The vault the API and the worker run with: the root key from env, and the `googleApps` the
 * composition root passes when Google's sign-in pair is set, since one OAuth app signs people in,
 * connects Mailboxes, each as its own connection with its own scopes. `googleAppProviders` are
 * Google connections a Workspace may bring its own app for, such as Search Console; without one
 * they use the server's app for that connection, then the sign-in pair.
 */
export function vaultFromEnv(
  cfg: { baseURL: string; google?: { clientId: string; clientSecret: string } },
  onReady?: VaultDeps["onReady"],
  social?: Pick<VaultDeps, "appProviders" | "identify"> & { googleApps?: readonly AppProvider[]; googleAppProviders?: readonly AppProvider[] },
) {
  const { googleApps = [], googleAppProviders = [], appProviders = [], ...rest } = social ?? {};
  const google = cfg.google;
  const signInFallback = (connection: string) => (google && googleAppProviders.some((p) => p.connection === connection) ? google : null);
  const vault = createVault({
    rootKey: rootKeyFromEnv(),
    now: () => new Date(),
    providers: google ? googleApps.map((p) => ({ ...p, ...google })) : [],
    appProviders: [...appProviders, ...googleAppProviders],
    callbackUrl: `${cfg.baseURL}/api/connections/callback`,
    onReady,
    ...rest,
    systemApp: async (connection) => (await readSystemApp(vault, connection)) ?? signInFallback(connection),
  });
  return vault;
}
