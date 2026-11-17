// SPDX-License-Identifier: AGPL-3.0-only
// The terminal side of third-party plugin installs (ADR 0026 rule 001). Connects as the database
// owner, the only role that may run the cli_* functions, so having this server's shell and .env is
// the proof that a Server admin is at the keyboard.
//   bun run plugin install <plugin.js> [--yes]   read it in the sandbox, show what it asks for, install
//   bun run plugin upgrade <plugin.js> [--yes]   the same, showing what changes for Workspace owners
//   bun run plugin remove <plugin id> [--yes]    remove it; every Workspace's turn-on stops counting
//   bun run plugin list                          what is installed
import type { Manifest } from "@trydirex/plugin-sdk";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { dataDir } from "../apps/api/src/modules/credentials/index";
import { HOST_VERSION, isPublicSuffix, prepareInstall, storeBundle, storedBundle, upgradeDiff, type InstallPlan, type ProbeResult } from "../apps/api/src/modules/plugins/index";

export type Db = { query: (text: string, params?: unknown[]) => Promise<{ rows: Record<string, unknown>[] }> };

export type PluginCliOptions = {
  storeDir: string;
  firstPartyIds: ReadonlySet<string>;
  print?: (line: string) => void;
  /** Asks the person to confirm; `--yes` skips it. */
  confirm?: (question: string) => Promise<boolean>;
  probe?: (file: string, opts: { hostVersion: string }) => Promise<ProbeResult>;
};

const USAGE = [
  "Usage: bun run plugin install <plugin.js> [--yes]",
  "       bun run plugin upgrade <plugin.js> [--yes]",
  "       bun run plugin remove <plugin id> [--yes]",
  "       bun run plugin list",
].join("\n");

const codeOf = (e: unknown) => (e as { code?: string }).code;

function describe(m: Manifest, plan: InstallPlan, print: (l: string) => void) {
  print(`${m.name ?? m.id} (${m.id}) version ${m.version}`);
  print(`File: sha256 ${plan.entrySha256}`);
  print("It can:");
  for (const c of m.capabilities) print(`  ${c.kind} ${c.name}${c.kind === "effect" && c.reachesPerson ? " (reaches a person)" : ""}`);
  print("It connects with:");
  for (const c of m.connections) print(`  ${c.key} (${c.auth})`);
  print("It may reach, on port 443 only:");
  for (const h of m.egress.hosts) print(`  ${h}`);
  print("Anything it is handed, such as a key a Workspace connects, it can send to those hosts.");
}

/** Runs one command; returns the exit code. Every line goes through `print`. */
export async function pluginCli(args: string[], db: Db, opts: PluginCliOptions): Promise<number> {
  const print = opts.print ?? console.log;
  let parsed;
  try {
    parsed = parseArgs({ args, allowPositionals: true, options: { yes: { type: "boolean" } } });
  } catch {
    print(USAGE);
    return 2;
  }
  const [command, target, ...extra] = parsed.positionals;
  const yes = parsed.values.yes === true;
  const confirm = async (q: string) => yes || ((await opts.confirm?.(q)) ?? false);

  if (command === "list" && !target) {
    const { rows } = await db.query("select plugin_id, version, entry_sha256, generation from system.installed_plugins()");
    if (!rows.length) print("No third-party plugins are installed.");
    for (const r of rows) print(`${String(r.plugin_id)} ${String(r.version)} sha256 ${String(r.entry_sha256)}`);
    return 0;
  }

  if ((command === "install" || command === "upgrade") && target && !extra.length) {
    const prepared = await prepareInstall(target, { hostVersion: HOST_VERSION, firstPartyIds: opts.firstPartyIds, isPublicSuffix, ...(opts.probe && { probe: opts.probe }) });
    if (!prepared.ok) {
      print("This plugin can't be installed:");
      for (const r of prepared.reasons) print(`  ${r}`);
      return 1;
    }
    const { plan } = prepared;
    const m = plan.manifest;
    const { rows: current } = await db.query("select manifest, permission_hash from system.installed_plugins() where plugin_id = $1", [m.id]);
    if (command === "install" && current.length) {
      print(`${m.id} is already installed. Use: bun run plugin upgrade ${target}`);
      return 1;
    }
    if (command === "upgrade" && !current.length) {
      print(`${m.id} isn't installed. Use: bun run plugin install ${target}`);
      return 1;
    }
    describe(m, plan, print);
    if (command === "upgrade") {
      const diff = upgradeDiff(current[0]!.manifest as Manifest, m);
      for (const a of diff.added) print(`  new: ${a}`);
      for (const r of diff.removed) print(`  gone: ${r}`);
      if (current[0]!.permission_hash !== plan.permissionHash) print("What it may do or reach changes, so it stops in every Workspace until an owner turns it on again.");
      else print("What it may do and reach is unchanged, so it stays on where it is on. Approvals waiting on it go back to a person.");
    }
    if (!(await confirm(`${command === "install" ? "Install" : "Upgrade"} ${m.id}?`))) {
      print("Nothing was changed.");
      return 1;
    }
    await storeBundle(plan, opts.storeDir);
    await db.query("select system.cli_install_plugin($1, $2, $3, $4, $5, $6)", [command, m.id, m.version, m, plan.permissionHash, plan.entrySha256]);
    print(command === "install" ? `${m.id} is installed. A Workspace owner turns it on from the Capabilities page.` : `${m.id} is upgraded.`);
    return 0;
  }

  if (command === "remove" && target && !extra.length) {
    const { rows } = await db.query("select entry_sha256 from system.installed_plugins() where plugin_id = $1", [target]);
    if (!rows.length) {
      print(`${target} isn't installed.`);
      return 1;
    }
    if (!(await confirm(`Remove ${target}? It stops in every Workspace, and an owner has to turn it on again after a reinstall.`))) {
      print("Nothing was changed.");
      return 1;
    }
    try {
      await db.query("select system.cli_remove_plugin($1)", [target]);
    } catch (e) {
      if (codeOf(e) !== "DX404") throw e;
      print(`${target} isn't installed.`);
      return 1;
    }
    const sha = String(rows[0]!.entry_sha256);
    const { rows: others } = await db.query("select 1 from system.installed_plugins() where entry_sha256 = $1", [sha]);
    if (!others.length) await rm(storedBundle(opts.storeDir, sha), { force: true });
    print(`${target} is removed.`);
    return 0;
  }

  print(USAGE);
  return 2;
}

if (import.meta.main) {
  const url = process.env.DIREX_DB_OWNER_URL;
  const dir = dataDir(process.env);
  if (!url || !dir) {
    console.error("DIREX_DB_OWNER_URL and DIREX_DATA_DIR (or HOME) must be set. Run this from the repository root, where .env is.");
    process.exit(2);
  }
  const { default: pg } = await import("pg");
  const { firstPartyPlugins } = await import("@direx/extensions");
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  try {
    process.exitCode = await pluginCli(process.argv.slice(2), client, {
      storeDir: join(dir, "plugin-store"),
      firstPartyIds: new Set(firstPartyPlugins().map((p) => p.manifest.id)),
      confirm: async (q) => (prompt(`${q} [y/N]`) ?? "").trim().toLowerCase() === "y",
    });
  } finally {
    await client.end();
  }
}
