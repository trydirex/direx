// SPDX-License-Identifier: AGPL-3.0-only
// `bun run plugin` against this file's database, as the owner (ADR 0026 rules 001 to 005): the hello
// example is bundled, read in the sandbox with no network, shown, stored under its hash and installed.
import { existsSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, expect, test } from "vitest";
import { sandboxStatus } from "../apps/api/src/modules/models/index";
import { permissionHash, type ProbeResult } from "../apps/api/src/modules/plugins/index";
import { pluginCli } from "../scripts/plugin";
import { ownerClient } from "./db";

let owner: Awaited<ReturnType<typeof ownerClient>>;
const status = await sandboxStatus();
const work = mkdtempSync(join(tmpdir(), "direx-plugin-cli-"));
const storeDir = join(work, "store");
let hello = "";
const ID = "com.example.hello";

async function run(args: string[], opts: { confirm?: boolean; probe?: (file: string) => Promise<ProbeResult> } = {}) {
  const lines: string[] = [];
  const code = await pluginCli(args, owner, {
    storeDir,
    firstPartyIds: new Set(["com.example.gmail"]),
    print: (l) => lines.push(l),
    confirm: async () => opts.confirm ?? false,
    ...(opts.probe && { probe: opts.probe }),
  });
  return { code, lines, out: lines.join("\n") };
}
const installed = async () => (await owner.query("select plugin_id, version, entry_sha256, permission_hash from system.installed_plugins()")).rows;

beforeAll(async () => {
  owner = await ownerClient();
  const built = await Bun.build({ entrypoints: [join(import.meta.dirname, "../packages/plugin-sdk/examples/hello/plugin.ts")], outdir: join(work, "hello"), target: "bun" });
  if (!built.success) throw new Error(built.logs.join("\n"));
  hello = built.outputs[0]!.path;
});
afterAll(() => owner.end());
beforeEach(async () => {
  await owner.query("delete from system.plugin_installs; delete from system.plugin_install_events");
});

test("usage for anything else", async () => {
  expect((await run([])).code).toBe(2);
  expect((await run(["install"])).code).toBe(2);
  expect((await run(["frobnicate", "x"])).code).toBe(2);
  expect((await run(["install", "a", "b"])).out).toMatch(/^Usage: bun run plugin install/);
  expect((await run(["--bogus"])).code).toBe(2);
});

test("list says when nothing is installed", async () => {
  expect(await run(["list"])).toMatchObject({ code: 0, out: "No third-party plugins are installed." });
});

test("a missing file, or one too big, is refused before anything runs", async () => {
  let probed = false;
  const probe = async () => ((probed = true), { ok: false as const, reason: "x" });
  expect((await run(["install", join(work, "nope.js")], { probe })).out).toMatch(/there is no file at/);
  const big = join(work, "big.js");
  writeFileSync(big, Buffer.alloc(10 * 1024 * 1024 + 1));
  expect((await run(["install", big], { probe })).out).toMatch(/may be at most 10485760/);
  expect(probed).toBe(false);
});

if (status.ok) {
  test("install reads the bundle in the sandbox, shows what it asks for, and does nothing without a yes", async () => {
    const r = await run(["install", hello]);
    expect(r.code).toBe(1);
    expect(r.out).toContain("Hello (com.example.hello) version 0.1.0");
    expect(r.out).toContain("  effect hello.ping");
    expect(r.out).toContain("  hello (api_key)");
    expect(r.out).toContain("  api.example.com");
    expect(r.out).toContain("Anything it is handed");
    expect(r.out).toMatch(/Nothing was changed\.$/);
    expect(await installed()).toEqual([]);
  });

  test("with a yes it is stored read-only under its hash and installed; a second install is refused", async () => {
    const r = await run(["install", hello], { confirm: true });
    expect(r).toMatchObject({ code: 0 });
    expect(r.out).toMatch(/com\.example\.hello is installed\. A Workspace owner turns it on/);
    const [row] = await installed();
    const sha = new Bun.CryptoHasher("sha256").update(readFileSync(hello)).digest("hex");
    expect(row).toMatchObject({ plugin_id: ID, version: "0.1.0", entry_sha256: sha });
    const stored = join(storeDir, `${sha}.js`);
    expect(readFileSync(stored)).toEqual(readFileSync(hello));
    expect(statSync(stored).mode & 0o222).toBe(0);
    expect((await run(["install", hello], { confirm: true })).out).toMatch(/is already installed\. Use: bun run plugin upgrade/);
    expect((await run(["list"])).out).toBe(`${ID} 0.1.0 sha256 ${sha}`);
  });

  test("remove takes it away and deletes the stored file; removing again says it isn't there", async () => {
    await run(["install", hello], { confirm: true });
    const [row] = await installed();
    expect((await run(["remove", ID])).out).toMatch(/Nothing was changed/);
    expect(await run(["remove", ID, "--yes"])).toMatchObject({ code: 0, out: `${ID} is removed.` });
    expect(await installed()).toEqual([]);
    expect(existsSync(join(storeDir, `${String(row!.entry_sha256)}.js`))).toBe(false);
    expect((await run(["remove", ID, "--yes"])).out).toBe(`${ID} isn't installed.`);
  });
} else {
  test("where the sandbox can't hold, install refuses and gives the sandbox's reason", async () => {
    expect((await run(["install", hello], { confirm: true })).out).toContain(status.reason);
  });
}

test("a bundle that asks for something third-party plugins can't have is refused with every reason", async () => {
  const probe = async (): Promise<ProbeResult> => ({
    ok: true,
    manifest: {
      id: "com.trydirex.links", apiVersion: 1, version: "1.0.0", minHostVersion: "0.1.0", trust: "third_party",
      connections: [{ key: "x", auth: "oauth2" }], egress: { hosts: ["*.co.uk"] },
      capabilities: [{ kind: "effect", name: "email.send", connection: "x", dedupe: "blind", risk: "low", reachesPerson: true }],
    },
  });
  const r = await run(["install", hello, "--yes"], { probe });
  expect(r.code).toBe(1);
  expect(r.lines[0]).toBe("This plugin can't be installed:");
  expect(r.lines.slice(1)).toEqual([
    "  the id com.trydirex.links belongs to Direx's own plugins",
    "  email.send is a shape only Direx's own plugins may offer for now",
    "  connection x signs in with OAuth, which third-party plugins can't yet",
    "  *.co.uk would reach every site under co.uk",
  ]);
  expect((await run(["install", hello, "--yes"], { probe: async () => ({ ok: false, reason: "it exited without answering" }) })).out).toMatch(/couldn't be read: it exited without answering/);
});

test("upgrade shows what changes, says whether owners must turn it on again, and keeps the install", async () => {
  const base = {
    id: ID, name: "Hello", apiVersion: 1 as const, version: "0.1.0", minHostVersion: "0.2.0", trust: "third_party" as const,
    connections: [{ key: "hello", auth: "api_key" as const }], egress: { hosts: ["api.example.com"] },
    capabilities: [{ kind: "effect" as const, name: "hello.ping", connection: "hello", dedupe: "blind" as const, risk: "low" as const, reachesPerson: false }],
  };
  expect((await run(["upgrade", hello, "--yes"], { probe: async () => ({ ok: true, manifest: base }) })).out).toMatch(/isn't installed\. Use: bun run plugin install/);
  expect((await run(["install", hello, "--yes"], { probe: async () => ({ ok: true, manifest: base }) })).code).toBe(0);

  const same = await run(["upgrade", hello, "--yes"], { probe: async () => ({ ok: true, manifest: { ...base, version: "0.2.0" } }) });
  expect(same.out).toMatch(/unchanged, so it stays on where it is on\. Approvals waiting on it go back to a person/);

  const wider = { ...base, version: "0.3.0", egress: { hosts: ["api.example.com", "cdn.example.com"] } };
  const r = await run(["upgrade", hello, "--yes"], { probe: async () => ({ ok: true, manifest: wider }) });
  expect(r.code).toBe(0);
  expect(r.out).toContain("  new: reaches cdn.example.com");
  expect(r.out).toMatch(/stops in every Workspace until an owner turns it on again/);
  expect(r.out).toMatch(/is upgraded\.$/);
  expect(await installed()).toEqual([expect.objectContaining({ plugin_id: ID, version: "0.3.0", permission_hash: permissionHash(wider) })]);
  const { rows } = await owner.query("select action, version, via from system.plugin_install_events order by id");
  expect(rows).toEqual([
    { action: "install", version: "0.1.0", via: "cli" },
    { action: "upgrade", version: "0.2.0", via: "cli" },
    { action: "upgrade", version: "0.3.0", via: "cli" },
  ]);
});
