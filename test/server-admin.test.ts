// SPDX-License-Identifier: AGPL-3.0-only
// `bun run server-admin` against this file's database, as the owner (ADR 0024, rules 005 and 009).
import { createHash } from "node:crypto";
import { afterAll, beforeAll, beforeEach, expect, test } from "vitest";
import { serverAdmin } from "../scripts/server-admin";
import { insertAuthUser, ownerClient } from "./db";

let owner: Awaited<ReturnType<typeof ownerClient>>;
const BASE = "https://direx.example.com/";
const HOUR = 3_600_000;

async function run(...args: string[]) {
  const lines: string[] = [];
  const code = await serverAdmin(args, owner, { baseURL: BASE, print: (l) => lines.push(l) });
  return { code, lines };
}
/** Hours from the row's creation to its expiry, as the database recorded both. */
const life = (row: Record<string, unknown>) => (new Date(row.expires_at as string).getTime() - new Date(row.created_at as string).getTime()) / HOUR;
const invites = async () => (await owner.query("select token_hash, created_at, expires_at, revoked_at from system.bootstrap_invites order by created_at, id")).rows;

beforeAll(async () => {
  owner = await ownerClient();
});
afterAll(() => owner.end());
beforeEach(async () => {
  await owner.query("delete from system.server_admins; delete from system.bootstrap_invites; delete from system.server_admin_events;");
});

test("--invite prints a one-time claim link and its expiry, and stores only the token's hash", async () => {
  const { code, lines } = await run("--invite", "--hours", "24");
  expect(code).toBe(0);
  const link = lines.find((l) => l.startsWith("https://"))!;
  expect(link).toMatch(/^https:\/\/direx\.example\.com\/claim\/[0-9a-f]{64}$/);
  const token = link.split("/claim/")[1]!;
  const [row] = await invites();
  expect(life(row!)).toBe(24);
  expect(lines).toContain(`It expires ${new Date(row!.expires_at as string).toISOString()}. Any earlier link no longer works.`);
  expect(row!.token_hash).toBe(createHash("sha256").update(token).digest("hex"));
  expect(JSON.stringify(await invites())).not.toContain(token);
});

test("a new --invite revokes the earlier one, and the default is 72 hours", async () => {
  await run("--invite");
  await run("--invite");
  const [first, second] = await invites();
  expect(first!.revoked_at).not.toBeNull();
  expect(second!.revoked_at).toBeNull();
  expect(life(second!)).toBe(72);
});

test("--hours outside 1 to 72 is refused, and nothing is stored", async () => {
  for (const h of ["0", "73", "1.5", "soon"]) expect((await run("--invite", "--hours", h)).code).toBe(2);
  expect(await invites()).toEqual([]);
});

test("--invite on a claimed server says what to do instead", async () => {
  const id = crypto.randomUUID();
  await insertAuthUser(id);
  await owner.query("insert into system.server_admins (user_id) values ($1)", [id]);
  const { code, lines } = await run("--invite");
  expect(code).toBe(1);
  expect(lines).toEqual(["This server already has a Server admin. Ask one of them, or make an account one with: bun run server-admin <email>"]);
});

test("<email> makes an existing account a Server admin, recorded as the CLI's grant", async () => {
  const id = crypto.randomUUID();
  await insertAuthUser(id);
  const { code, lines } = await run(`${id}@example.com`);
  expect(code).toBe(0);
  expect(lines).toEqual([`${id}@example.com is now a Server admin.`]);
  const { rows } = await owner.query("select user_id, via from system.server_admin_events");
  expect(rows).toEqual([{ user_id: id, via: "cli" }]);
});

test("<email> with no account says so", async () => {
  expect(await run("nobody@example.com")).toEqual({ code: 1, lines: ["No account has that email. Have them sign in to this server once, then run this again."] });
});

test("anything else prints the usage", async () => {
  for (const args of [[], ["a@example.com", "b@example.com"], ["--invite", "a@example.com"], ["--bogus"]]) expect((await run(...args)).code).toBe(2);
});

// `purge` (ADR 0030 rule 003): counts first, --confirm to run, and --replay after a restore.
const purgeDeps = async () => {
  const { diskStore } = await import("../apps/api/src/modules/media/index");
  const { createVault, rootKeyFromEnv, suppressionHasher } = await import("../apps/api/src/modules/credentials/index");
  const { mkdtemp } = await import("node:fs/promises");
  const vault = createVault({ rootKey: rootKeyFromEnv({ DIREX_MASTER_KEY: "22".repeat(32) })!, now: () => new Date() });
  return { store: diskStore(await mkdtemp(`${(await import("node:os")).tmpdir()}/direx-purge-cli-`)), hasher: suppressionHasher(vault) };
};
const purge = async (...args: string[]) => {
  const lines: string[] = [];
  const code = await serverAdmin(["purge", ...args], owner, { baseURL: BASE, print: (l) => lines.push(l), actor: "cli:test", purge: purgeDeps });
  return { code, lines };
};
async function workspace(deletedDaysAgo: number | null) {
  const [org, ws] = [crypto.randomUUID(), crypto.randomUUID()];
  await owner.query("insert into organizations (id, name, created_at) values ($1, 'O', now())", [org]);
  await owner.query("insert into workspaces (id, org_id, name, created_at) values ($1, $2, 'W', now())", [ws, org]);
  await owner.query("insert into suppressions (workspace_id, email, reason, created_at) values ($1, 'gone@example.com', 'unsubscribe', now())", [ws]);
  if (deletedDaysAgo !== null) await owner.query("update workspaces set deleted_at = now() - make_interval(days => $2) where id = $1", [ws, deletedDaysAgo]);
  return ws;
}
const suppressions = async (ws: string) => Number((await owner.query("select count(*) from suppressions where workspace_id = $1", [ws])).rows[0].count);

test("purge without --confirm prints what it would remove and changes nothing", async () => {
  const ws = await workspace(31);
  const { code, lines } = await purge(ws);
  expect(code).toBe(0);
  expect(lines).toContain(`Purging Workspace ${ws} removes:`);
  expect(lines).toContain("  public.suppressions: 1 rows");
  expect(lines).toContain("Its opt-outs are kept as keyed hashes and the receipt holds counts only. Nothing else of it is kept, so download its export first.");
  expect(lines).toContain("  public.workspaces: 1 rows");
  expect(lines).toContain("  public.organizations: 1 rows");
  expect(lines.at(-1)).toBe("Nothing has changed. Run again with --confirm to purge.");
  expect(await suppressions(ws)).toBe(1);
});

test("purge refuses a live, recent or system Workspace, with or without --confirm, and says why", async () => {
  expect(await purge(await workspace(null), "--confirm")).toEqual({ code: 1, lines: ["That Workspace is not deleted. An Owner deletes it first; it can be purged 30 days later."] });
  expect(await purge(await workspace(3))).toEqual({ code: 1, lines: ["That Workspace was deleted less than 30 days ago. It can be purged once 30 days have passed."] });
  expect((await purge("00000000-0000-4000-8000-00000000d1e0", "--confirm")).lines).toEqual(["That is the system Workspace, which holds this server's own secrets. It is never purged."]);
  for (const args of [[], ["not-a-uuid"], [crypto.randomUUID(), crypto.randomUUID()]]) expect((await purge(...args)).code).toBe(2);
});

test("purge --confirm purges and prints the receipt; --replay purges again what a restore brought back", async () => {
  const ws = await workspace(31);
  const done = await purge(ws, "--confirm");
  expect(done.code).toBe(0);
  const receipt = JSON.parse(done.lines[0]!.split("Receipt: ")[1]!) as { workspace: string; rows: Record<string, number> };
  expect(receipt).toMatchObject({ workspace: ws, actor: "cli:test", outcome: "purged", rows: { "public.suppressions": 1 }, hashes_written: 1 });
  expect(await suppressions(ws)).toBe(0);
  expect(await purge(ws, "--confirm")).toEqual({ code: 1, lines: ["That Workspace was purged already."] });

  // A restore from before the delete brings a Workspace back live; its receipt line replays it anyway.
  const restored = await workspace(null);
  const { writeFile, mkdtemp } = await import("node:fs/promises");
  const file = `${await mkdtemp(`${(await import("node:os")).tmpdir()}/direx-receipts-`)}/receipts.jsonl`;
  await writeFile(file, [done.lines[0], JSON.stringify({ workspace: restored }), JSON.stringify({ workspace: crypto.randomUUID() })].join("\n"));
  const dry = await purge("--replay", file);
  expect(dry.lines).toEqual([
    `${ws}: nothing to replay (purged in this database too).`,
    `${restored}: would be purged again.`,
    expect.stringMatching(/: nothing to replay \(not in this database\)\.$/),
    "Run again with --confirm to replay, before the server takes any traffic.",
  ]);
  expect(await suppressions(restored)).toBe(1);
  const replayed = await purge("--replay", file, "--confirm");
  expect(replayed.code).toBe(0);
  expect(replayed.lines[1]).toMatch(new RegExp(`^Purged ${restored}\\. Receipt: .*"replay":true`));
  expect(await suppressions(restored)).toBe(0);
  // Its row and its Organization, which had no other Workspace, are gone.
  expect((await owner.query("select id from workspaces where id = $1", [restored])).rows).toEqual([]);
  expect(JSON.parse(replayed.lines[1]!.split("Receipt: ")[1]!)).toMatchObject({ rows: { "public.workspaces": 1, "public.organizations": 1 }, kept: {} });
});
