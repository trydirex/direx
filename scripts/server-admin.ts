// SPDX-License-Identifier: AGPL-3.0-only
// The terminal side of Server admins (ADR 0024). Connects as the database owner, the only role
// that may run these functions, so having this server's shell and .env is the proof.
//   bun run server-admin --invite [--hours N]   prints a one-time link that makes the first Server admin
//   bun run server-admin <email>                makes an existing account a Server admin
//   bun run server-admin purge <workspace-id> [--confirm]
//                                               prints what purging a deleted Workspace removes; with
//                                               --confirm, purges it and prints the receipt (ADR 0030)
//   bun run server-admin purge --replay <file> [--confirm]
//                                               after a restore, purges again every Workspace whose
//                                               receipt is in the file, one JSON receipt per line
//   bun run server-admin hold (--org <id> | --workspace <id> | --deployment) --reason <text>
//                                               stops sending there until lifted; no member can lift it
//   bun run server-admin lift (--org <id> | --workspace <id> | --deployment)
//                                               lifts it: what it held is checked again and resumes
//   bun run server-admin holds                  lists the live operator holds
// The link is printed here and nowhere else. Agents never read, print or pass it on (DX-R-0024-006).
import { createHash, randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { previewPurge, PurgeRefused, purgeRefusal, purgeWorkspace, type PurgeDeps } from "../apps/api/src/modules/retention/index";

export type Db = { query: (text: string, params?: unknown[]) => Promise<{ rows: Record<string, unknown>[] }> };

const USAGE = [
  "Usage: bun run server-admin --invite [--hours 1-72]",
  "       bun run server-admin <email>",
  "       bun run server-admin purge <workspace-id> [--confirm]",
  "       bun run server-admin purge --replay <receipts file> [--confirm]",
  "       bun run server-admin hold (--org <id> | --workspace <id> | --deployment) --reason <text>",
  "       bun run server-admin lift (--org <id> | --workspace <id> | --deployment)",
  "       bun run server-admin holds",
].join("\n");
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** Why a purge was refused, as the Server admin reads it. */
const REFUSED: Record<string, string> = {
  system: "That is the system Workspace, which holds this server's own secrets. It is never purged.",
  not_found: "No Workspace has that id.",
  purged: "That Workspace was purged already.",
  live: "That Workspace is not deleted. An Owner deletes it first; it can be purged 30 days later.",
  recent: "That Workspace was deleted less than 30 days ago. It can be purged once 30 days have passed.",
  in_flight: "That Workspace has Actions that are not sent, blocked or cancelled, such as one held with an unknown outcome. Purging waits until each is settled.",
};
const refusedLine = (reason: string) => REFUSED[reason] ?? `The purge refused: ${reason}.`;

type PurgeOpts = { print: (line: string) => void; actor: string; deps?: () => Promise<Omit<PurgeDeps, "db">> };

async function purgeCommand(values: { confirm?: boolean; replay?: string }, positionals: string[], db: Db, o: PurgeOpts): Promise<number> {
  const { print } = o;
  const run = async (ws: string, replay: boolean) => {
    if (!o.deps) throw new Error("server-admin: purge needs the store and the vault");
    try {
      const receipt = await purgeWorkspace(ws, o.actor, { db, ...(await o.deps()) }, { replay });
      print(`Purged ${ws}. Receipt: ${JSON.stringify(receipt)}`);
      return 0;
    } catch (e) {
      if (!(e instanceof PurgeRefused)) throw e;
      print(refusedLine(e.reason));
      return 1;
    }
  };

  if (values.replay !== undefined && positionals.length === 1) {
    const ids = readFileSync(values.replay, "utf8").split("\n").filter((l) => l.trim()).map((l) => String((JSON.parse(l.replace(/^.*?Receipt: /, "")) as { workspace?: unknown }).workspace));
    let code = 0;
    for (const ws of ids) {
      const why = UUID.test(ws) ? await purgeRefusal(db, ws) : "not_found";
      if (why === "purged" || why === "not_found") print(`${ws}: nothing to replay (${why === "purged" ? "purged in this database too" : "not in this database"}).`);
      else if (!values.confirm) print(`${ws}: would be purged again.`);
      else code = Math.max(code, await run(ws, true));
    }
    if (!values.confirm && ids.length) print("Run again with --confirm to replay, before the server takes any traffic.");
    return code;
  }

  const ws = positionals[1];
  if (values.replay !== undefined || positionals.length !== 2 || !UUID.test(ws!)) {
    print(USAGE);
    return 2;
  }
  if (values.confirm) return run(ws!, false);
  const p = await previewPurge(db, ws!);
  if (p.refusal) {
    print(refusedLine(p.refusal));
    return 1;
  }
  print(`Purging Workspace ${ws} removes:`);
  for (const [t, n] of Object.entries(p.remove)) print(`  ${t}: ${n} rows`);
  print(`  queued jobs: ${p.jobs}`);
  print(`  stored files: ${p.files}`);
  print("Its opt-outs are kept as keyed hashes and the receipt holds counts only. Nothing else of it is kept, so download its export first.");
  print("Nothing has changed. Run again with --confirm to purge.");
  return 0;
}
const MAX_HOURS = 72;

const codeOf = (e: unknown) => (e as { code?: string }).code;

type HoldOpts = { org?: string; workspace?: string; deployment?: boolean; reason?: string };
const HOLD_COMMANDS = new Set(["hold", "lift", "holds"]);

/** Operator holds (docs/operator-holds.md): set, lift or list them. Returns the exit code. */
async function holdCommand(command: string, values: HoldOpts, args: number, db: Db, o: { print: (line: string) => void; actor: string }): Promise<number> {
  const { print } = o;
  const usage = () => {
    print(USAGE);
    return 2;
  };
  if (args !== 1) return usage();
  if (command === "holds") {
    if (values.org !== undefined || values.workspace !== undefined || values.deployment || values.reason !== undefined) return usage();
    const { rows } = await db.query("select scope, target, reason, set_by, set_at from system.operator_holds where lifted_at is null order by set_at");
    if (!rows.length) print("No operator holds are live.");
    for (const r of rows) print(`${r.scope}${r.target ? ` ${r.target}` : ""}: ${r.reason} (set by ${r.set_by}, ${new Date(r.set_at as string).toISOString()})`);
    return 0;
  }
  const picked: [string, string | null][] = [];
  if (values.org !== undefined) picked.push(["organization", values.org]);
  if (values.workspace !== undefined) picked.push(["workspace", values.workspace]);
  if (values.deployment) picked.push(["deployment", null]);
  const reason = values.reason?.trim();
  const [scope, target] = picked[0] ?? [];
  if (picked.length !== 1 || (target !== null && !UUID.test(target!)) || (command === "hold") !== (reason !== undefined)) return usage();
  const named = target ? `${scope} ${target}` : "the deployment";
  if (command === "hold") {
    if (!reason || reason.length > 500) {
      print("--reason must say why, in at most 500 characters. Only operators read it.");
      return 2;
    }
    let made: unknown;
    try {
      made = (await db.query("select system.set_operator_hold($1, $2, $3, $4) as id", [scope, target, reason, o.actor])).rows[0]!.id;
    } catch (e) {
      if (codeOf(e) !== "DX404") throw e;
      print(`No ${scope} has that id.`);
      return 1;
    }
    print(made ? `Held ${named}. Nothing it has due sends, and no model runs for it, until you lift the hold.` : `${named} was already held. Nothing changed.`);
    return 0;
  }
  const lifted = (await db.query("select system.lift_operator_hold($1, $2, $3) as lifted", [scope, target, o.actor])).rows[0]!.lifted;
  print(lifted ? `Lifted the hold on ${named}. What it held is checked again and resumes within a minute.` : `${named} has no live hold. Nothing changed.`);
  return lifted ? 0 : 1;
}

/** Runs one command; returns the exit code. Every line goes through `print`. */
export async function serverAdmin(
  args: string[],
  db: Db,
  opts: { baseURL: string; print?: (line: string) => void; actor?: string; purge?: PurgeOpts["deps"] },
): Promise<number> {
  const print = opts.print ?? console.log;
  let parsed;
  try {
    parsed = parseArgs({
      args,
      allowPositionals: true,
      options: {
        invite: { type: "boolean" },
        hours: { type: "string" },
        confirm: { type: "boolean" },
        replay: { type: "string" },
        org: { type: "string" },
        workspace: { type: "string" },
        deployment: { type: "boolean" },
        reason: { type: "string" },
      },
    });
  } catch {
    print(USAGE);
    return 2;
  }
  const { values, positionals } = parsed;
  const holdOption = values.org !== undefined || values.workspace !== undefined || values.deployment || values.reason !== undefined;
  const hold = HOLD_COMMANDS.has(positionals[0] ?? "");
  if (hold || holdOption) {
    if (!hold || values.invite || values.hours !== undefined || values.confirm || values.replay !== undefined) {
      print(USAGE);
      return 2;
    }
    return holdCommand(positionals[0]!, values, positionals.length, db, { print, actor: opts.actor ?? "cli" });
  }

  if (positionals[0] === "purge" && !values.invite && values.hours === undefined)
    return purgeCommand(values, positionals, db, { print, actor: opts.actor ?? "cli", deps: opts.purge });
  if (values.confirm || values.replay !== undefined) {
    print(USAGE);
    return 2;
  }

  if (values.invite && positionals.length === 0) {
    const hours = values.hours === undefined ? MAX_HOURS : Number(values.hours);
    if (!Number.isInteger(hours) || hours < 1 || hours > MAX_HOURS) {
      print(`--hours must be a whole number from 1 to ${MAX_HOURS}.`);
      return 2;
    }
    const token = randomBytes(32).toString("hex");
    let expires: Date;
    try {
      // The database's clock sets the expiry, as its check compares against its own now().
      const { rows } = await db.query("select system.issue_bootstrap_invite($1, e), e from (select now() + make_interval(hours => $2::int) as e) x", [
        createHash("sha256").update(token).digest("hex"),
        hours,
      ]);
      expires = new Date(rows[0]!.e as string);
    } catch (e) {
      if (codeOf(e) !== "DXCLM") throw e;
      print("This server already has a Server admin. Ask one of them, or make an account one with: bun run server-admin <email>");
      return 1;
    }
    print("Open this link to become this server's first Server admin. It works once.");
    print(`${opts.baseURL.replace(/\/+$/, "")}/claim/${token}`);
    print(`It expires ${expires.toISOString()}. Any earlier link no longer works.`);
    return 0;
  }

  if (!values.invite && values.hours === undefined && positionals.length === 1) {
    try {
      await db.query("select system.cli_grant_server_admin($1)", [positionals[0]]);
    } catch (e) {
      if (codeOf(e) !== "DX404") throw e;
      print("No account has that email. Have them sign in to this server once, then run this again.");
      return 1;
    }
    print(`${positionals[0]!.trim()} is now a Server admin.`);
    return 0;
  }

  print(USAGE);
  return 2;
}

if (import.meta.main) {
  const url = process.env.DIREX_DB_OWNER_URL;
  if (!url) {
    console.error("DIREX_DB_OWNER_URL is not set. Run this from the repository root, where .env is.");
    process.exit(2);
  }
  const { default: pg } = await import("pg");
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  const purging = process.argv[2] === "purge";
  try {
    process.exitCode = await serverAdmin(process.argv.slice(2), client, {
      baseURL: process.env.DIREX_BASE_URL ?? "http://localhost:5173",
      actor: `cli:${(await import("node:os")).userInfo().username}`,
      // The vault reads through the app's connection, so only a purge opens one.
      purge: async () => (await import("../apps/api/src/startup")).purgeDeps(),
    });
  } finally {
    await client.end();
    if (purging) await (await import("@direx/db")).closeDb();
  }
}
