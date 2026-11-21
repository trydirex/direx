// SPDX-License-Identifier: AGPL-3.0-only
// The credential vault: every secret a Workspace stores, encrypted with that Workspace's
// key and handed only to host code that makes the outside call. useSecret has its own
// entry point, use-secret.ts. The ledger takes credentialReady as a check and
// credentialLabel as the "credential" resolver.
import { rootKeyFromEnv, type RootKey } from "./adapters/crypto";
import type { AppProvider } from "./adapters/provider";
import { singleAppSource } from "./application/apps";
import { createVault, type VaultDeps } from "./application/secrets";
import { readSystemApp } from "./system-secrets";

export { suppressionHasher, type SuppressionHasher } from "./system-secrets";

export { credentialLabel, credentialReady, credentialSettings } from "./application/check";
export { createVault, type CredentialMeta, type Vault } from "./application/secrets";
export type { AppProvider } from "./adapters/provider";
export { singleAppSource, type AppContext, type AppOwner, type AppSource, type OAuthApp } from "./application/apps";
export type { Identify, Identity } from "./application/connect";
export { credentialRoutes, type CheckMailbox, type CredentialRouteDeps, type KeyConnect, type MailboxConnect } from "./routes";
export { dataDir, generateKeyFile, rootKeyFromEnv, type RootKey } from "./adapters/crypto";
export { ensureRootKey, replaceRootKey, rootKeyProblem } from "./application/root-key";
export { migrationsPending, type MigrationState } from "./adapters/repo";

/**
 * The vault the API and the worker run with: the root key `cfg` supplies, or else the one from env. `googleApps` always use
 * Google's sign-in pair, and are offered only when it is set. `googleAppProviders` are Google
 * connections a Workspace may bring its own app for, such as Gmail and Search Console.
 *
 * An app connection uses the Workspace's own app, then the deployment's (`social_app.<connection>`),
 * then, for `googleAppProviders` only, the sign-in pair.
 */
export function vaultFromEnv(
  cfg: { baseURL: string; google?: { clientId: string; clientSecret: string }; rootKey?: RootKey },
  onReady?: VaultDeps["onReady"],
  social?: Pick<VaultDeps, "appProviders" | "identify"> & { googleApps?: readonly AppProvider[]; googleAppProviders?: readonly AppProvider[] },
) {
  const { googleApps = [], googleAppProviders = [], appProviders = [], ...rest } = social ?? {};
  const google = cfg.google;
  const vault = createVault({
    rootKey: cfg.rootKey ?? rootKeyFromEnv(),
    now: () => new Date(),
    providers: google ? googleApps.map((p) => ({ ...p, ...google, appOwner: "sign_in" })) : [],
    appProviders: [...appProviders, ...googleAppProviders],
    callbackUrl: `${cfg.baseURL}/api/connections/callback`,
    onReady,
    ...rest,
    appSources: [
      singleAppSource("deployment", (connection) => readSystemApp(vault, connection)),
      singleAppSource("sign_in", async (connection) => (google && googleAppProviders.some((p) => p.connection === connection) ? google : null)),
    ],
  });
  return vault;
}
