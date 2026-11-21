// SPDX-License-Identifier: AGPL-3.0-only
// The root key at startup. It decrypts the vault, so it can't live there: it lives in a file
// outside the database, generated on first run. Generating is only safe on a first run,
// because a new key can read nothing that an old one wrapped, so a deployment that has
// already run refuses to start instead.
import { defaultKeyPath, generateKeyFile, rootKeyConfigured, rootKeyFromEnv, unwrapDataKey, type RootKey } from "../adapters/crypto";
import { keysOf, readDeploymentRootKey, recordDeploymentRootKey, replaceDeploymentRootKey, rewrapKey, withWorkspace, workspacesKeyedByOtherRoot } from "../adapters/repo";

// The deployment row holds no tenant data, and this is the wrapper the app role reads through.
const NO_WORKSPACE = "00000000-0000-4000-8000-000000000000";

/** Why this deployment couldn't start with this key, or null. Unlike `ensureRootKey`, it writes nothing. */
export async function rootKeyProblem(env: Record<string, string | undefined> = process.env): Promise<string | null> {
  const recorded = await withWorkspace(NO_WORKSPACE, readDeploymentRootKey);
  if (!recorded) return null;
  const path = defaultKeyPath(env);
  const restore = `restore the key file this deployment ran with${path ? ` to ${path}` : ""}, or set DIREX_MASTER_KEY. Never make a new one`;
  let id: string;
  try {
    if (!rootKeyConfigured(env)) return restore;
    id = rootKeyFromEnv(env).id;
  } catch {
    return restore;
  }
  if (id !== recorded) return restore;
  // A key file replaced after some Workspaces were set up leaves their keys wrapped by the old one.
  const orphans = await workspacesKeyedByOtherRoot(id);
  return orphans.length
    ? `Workspaces ${orphans.join(", ")} were set up under another root key, so their credentials and approvals can't be read. Restore that key file, or remove those Workspaces if they were tests`
    : null;
}

export async function ensureRootKey(
  env: Record<string, string | undefined> = process.env,
  log: (line: string) => void = console.log,
  supplied?: RootKey,
): Promise<RootKey> {
  // A key from an extension (a KMS, say) is the only one: a second source in env would leave which key runs to chance.
  if (supplied && (env.DIREX_MASTER_KEY || env.DIREX_MASTER_KEY_FILE)) {
    throw new Error("a root key was supplied to runServer, so DIREX_MASTER_KEY and DIREX_MASTER_KEY_FILE must be unset");
  }
  if (!supplied && !rootKeyConfigured(env)) {
    const recorded = await withWorkspace(NO_WORKSPACE, readDeploymentRootKey);
    const path = defaultKeyPath(env);
    if (recorded) {
      throw new Error(`no root key found, but this deployment ran with ${recorded}. Restore its key file${path ? ` to ${path}` : ""} or set DIREX_MASTER_KEY`);
    }
    if (!path) throw new Error("DIREX_MASTER_KEY or DIREX_MASTER_KEY_FILE must be set, or DIREX_DATA_DIR for a generated key");
    if (generateKeyFile(path)) {
      log(`Generated a new root key at ${path}. Back this file up separately from the database: without it, no stored credential can be read.`);
    }
  }
  const root = supplied ?? rootKeyFromEnv(env);
  const recorded = await withWorkspace(NO_WORKSPACE, (tx) => recordDeploymentRootKey(tx, root.id, new Date()));
  if (recorded !== root.id) throw new Error(`this process has root key ${root.id}, but this deployment ran with ${recorded}. Restore the original key`);
  return root;
}

/**
 * Wraps every Workspace's data keys under `to`, then records `to` as the deployment's root key.
 * No credential is re-encrypted: only the wrapped data keys change. Each Workspace commits on
 * its own, so a run that stopped partway is finished by running it again with the same two keys.
 * Returns how many Workspaces it rewrapped.
 */
export async function replaceRootKey(from: RootKey, to: RootKey): Promise<number> {
  const recorded = await withWorkspace(NO_WORKSPACE, readDeploymentRootKey);
  if (recorded !== from.id) throw new Error(`this deployment runs with root key ${recorded ?? "none"}, not ${from.id}. Run this with the key the server uses`);
  if (to.id === from.id) throw new Error("the new key is the one already in use");
  const workspaces = await workspacesKeyedByOtherRoot(to.id);
  for (const workspaceId of workspaces) {
    await withWorkspace(workspaceId, async (tx) => {
      for (const row of await keysOf(tx, workspaceId)) {
        let dek: Buffer;
        try {
          dek = await unwrapDataKey(from, { wrapped: row.wrappedDek, rootKeyId: row.rootKeyId, workspaceId });
        } catch (e) {
          throw new Error(`Workspace ${workspaceId}: ${(e as Error).message}. Nothing was recorded; restore that key, or remove the Workspace if it was a test`);
        }
        await rewrapKey(tx, workspaceId, row.keyVersion, await to.wrap(dek, workspaceId), to.id);
      }
    });
  }
  if (!(await replaceDeploymentRootKey(from.id, to.id))) {
    throw new Error("a data key was made under the old root key while this ran. Stop the API and the worker, then run this again");
  }
  return workspaces.length;
}
