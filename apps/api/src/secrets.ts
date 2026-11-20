// SPDX-License-Identifier: AGPL-3.0-only
// Sets the deployment's secrets. A value comes in on stdin and never as an argument, so it
// stays out of shell history and process lists. Needs the root key and the database.
//
//   bun apps/api/src/secrets.ts list
//   printf %s "$VALUE" | bun apps/api/src/secrets.ts set smtp.url [--test-to <address>]
//   printf '%s\n' host port user password tls | bun apps/api/src/secrets.ts set smtp.url --parts
//   bun apps/api/src/secrets.ts replace-root-key /path/to/new.key
import { existsSync } from "node:fs";
import { isIPv6 } from "node:net";
import { createVault, ensureRootKey, generateKeyFile, replaceRootKey, rootKeyFromEnv, type Vault } from "./modules/credentials/index";
import { checkSmtp, type SmtpCheck } from "./modules/identity/index";
import { isSystemSecretName, listSystemSecrets, setSystemSecret, SYSTEM_SECRET_NAMES } from "./modules/credentials/system-secrets";

const USAGE = `usage: secrets list | secrets set <name>, with the value on stdin. Names: ${SYSTEM_SECRET_NAMES.join(", ")}`;

const PARTS_USAGE = "--parts reads five lines on stdin: host, port, user name, password, and tls or any. Nothing changed.";

type SmtpFlags = { parts: boolean; testTo?: string };
type Deps = { checkSmtp?: (url: string, from: string, testTo?: string) => Promise<SmtpCheck>; env?: Record<string, string | undefined> };

/** `--parts` and `--test-to <address>`, which only smtp.url takes. Null on anything else. */
function smtpFlags(rest: string[]): SmtpFlags | null {
  const flags: SmtpFlags = { parts: false };
  for (let i = 0; i < rest.length; i++) {
    if (rest[i] === "--parts") flags.parts = true;
    else if (rest[i] === "--test-to" && rest[i + 1]) flags.testTo = rest[++i];
    else return null;
  }
  return flags;
}

/** Builds the URL from its parts, so a password holding `@`, `/` or `:` needs no encoding in shell. */
function urlFromParts(text: string): string | null {
  const [host = "", port = "", user = "", pass = "", tls, ...extra] = text.split(/\r?\n/);
  if (!/^\d+$/.test(port) || (tls !== "tls" && tls !== "any") || extra.length > 0) return null;
  let hostname = host;
  if (!/^[\w.-]+$/.test(host)) {
    const address = host.startsWith("[") && host.endsWith("]") ? host.slice(1, -1) : host;
    // URL host syntax doesn't accept IPv6 zone identifiers.
    if (address.includes("%") || !isIPv6(address)) return null;
    hostname = `[${address}]`;
  }
  // Port 465 is TLS from the start; elsewhere `tls` makes nodemailer insist on STARTTLS.
  return `${port === "465" ? "smtps" : "smtp"}://${encodeURIComponent(user)}:${encodeURIComponent(pass)}@${hostname}:${port}${tls === "tls" ? "?requireTLS=true" : ""}`;
}

/** Returns the exit code. Nothing it prints ever holds a value. smtp.url is stored only after it logs in. */
export async function runSecretsCommand(
  args: string[],
  stdin: () => Promise<string>,
  vault: Vault,
  out: (line: string) => void,
  { checkSmtp: check = checkSmtp, env = process.env }: Deps = {},
): Promise<number> {
  const [command, name, ...rest] = args;
  if (command === "list" && !name) {
    const rows = await listSystemSecrets(vault);
    for (const n of SYSTEM_SECRET_NAMES) {
      const row = rows.find((r) => r.name === n);
      out(`${n}: ${row ? `set, last changed ${row.updatedAt.toISOString()}` : "not set"}`);
    }
    return 0;
  }
  const flags = name === "smtp.url" ? smtpFlags(rest) : rest.length > 0 ? null : { parts: false };
  if (command !== "set" || !name || !flags || !isSystemSecretName(name)) {
    out(USAGE);
    return 2;
  }
  if (name === "suppression.key") {
    out("suppression.key is made by the first Workspace purge and never changes: a new key would lose every opt-out kept with the old one.");
    return 2;
  }
  const raw = (await stdin()).replace(/\r?\n$/, "");
  const value = flags.parts ? urlFromParts(raw) : raw;
  if (value === null) {
    out(PARTS_USAGE);
    return 2;
  }
  if (!value) {
    out(`no value on stdin; nothing changed. ${USAGE}`);
    return 2;
  }
  if (name === "smtp.url") {
    if (flags.testTo && !env.DIREX_MAIL_FROM) {
      out("--test-to sends from DIREX_MAIL_FROM, which isn't set. Set it, then run this again. Nothing changed.");
      return 2;
    }
    // Without --test-to the check only logs in, so the From is never used.
    const checked = await check(value, env.DIREX_MAIL_FROM ?? "", flags.testTo);
    if (!checked.ok) {
      out(checked.line);
      return 1;
    }
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
