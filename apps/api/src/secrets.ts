// SPDX-License-Identifier: AGPL-3.0-only
// Sets the deployment's secrets. A value comes in on stdin and never as an argument, so it
// stays out of shell history and process lists. Needs the root key and the database.
//
//   bun apps/api/src/secrets.ts list
//   printf %s "$VALUE" | bun apps/api/src/secrets.ts set smtp.url
//   bun apps/api/src/secrets.ts replace-root-key /path/to/new.key
import { existsSync } from "node:fs";
import { createVault, ensureRootKey, generateKeyFile, replaceRootKey, rootKeyFromEnv, type Vault } from "./modules/credentials/index";
import { isSystemSecretName, listSystemSecrets, setSystemSecret, SYSTEM_SECRET_NAMES } from "./modules/credentials/system-secrets";

const USAGE = `usage: secrets list | secrets set <name>, with the value on stdin. Names: ${SYSTEM_SECRET_NAMES.join(", ")}`;

/** Returns the exit code. Nothing it prints ever holds a value. */
export async function runSecretsCommand(args: string[], stdin: () => Promise<string>, vault: Vault, out: (line: string) => void): Promise<number> {
  const [command, name, ...rest] = args;
  if (command === "list" && !name) {
    const rows = await listSystemSecrets(vault);
    for (const n of SYSTEM_SECRET_NAMES) {
      const row = rows.find((r) => r.name === n);
      out(`${n}: ${row ? `set, last changed ${row.updatedAt.toISOString()}` : "not set"}`);
    }
    return 0;
  }
  if (command !== "set" || !name || rest.length > 0 || !isSystemSecretName(name)) {
    out(USAGE);
    return 2;
  }
  if (name === "suppression.key") {
    out("suppression.key is made by the first Workspace purge and never changes: a new key would lose every opt-out kept with the old one.");
    return 2;
  }
  const value = (await stdin()).replace(/\r?\n$/, "");
  if (!value) {
    out(`no value on stdin; nothing changed. ${USAGE}`);
    return 2;
  }
  await setSystemSecret(vault, name, value);
  out(`${name} saved. A running server reads auth.secret, smtp.url, media.s3 and the signin secrets only when it starts.`);
  return 0;
}

const REPLACE_USAGE = "usage: secrets replace-root-key <new key file>. Stop the API and the worker first. The file is made if it isn't there";

/**
 * Moves the deployment to a new root key, read from a file or generated into it. The key in use
 * comes from the environment, as the server finds it. Returns the exit code and prints no key.
 */
export async function runReplaceRootKey(args: string[], env: Record<string, string | undefined>, out: (line: string) => void): Promise<number> {
  const [path, ...rest] = args;
  if (!path || rest.length > 0) {
    out(REPLACE_USAGE);
    return 2;
  }
  try {
    const from = rootKeyFromEnv(env);
    if (!existsSync(path)) generateKeyFile(path);
    const count = await replaceRootKey(from, rootKeyFromEnv({ DIREX_MASTER_KEY_FILE: path }));
    out(`Workspaces rewrapped: ${count}. This deployment now opens only with the key in ${path}.`);
    out("Start the API and the worker with that file: put it where the old key file was, or set DIREX_MASTER_KEY_FILE.");
    out("Back it up apart from the database, then destroy every copy of the old key.");
    return 0;
  } catch (e) {
    out(`Root key not replaced: ${(e as Error).message}`);
    return 1;
  }
}

if (import.meta.main) {
  if (process.argv[2] === "replace-root-key") process.exit(await runReplaceRootKey(process.argv.slice(3), process.env, console.log));
  const vault = createVault({ rootKey: await ensureRootKey(), now: () => new Date() });
  process.exit(await runSecretsCommand(process.argv.slice(2), () => Bun.stdin.text(), vault, console.log));
}
