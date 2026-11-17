// SPDX-License-Identifier: AGPL-3.0-only
// Installed plugins in the registry, against the real database and sandbox (ADR 0026 rules 002, 004
// and 010): the hello example is installed as `bun run plugin` installs it, loaded by reload, and
// every call checks the install and the Workspace's turn-on first.
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, expect, test } from "vitest";
import { insertAuthUser, ownerClient } from "../../../../../test/db";
import { sandboxStatus } from "../models";
import { behavePlugin } from "./fixtures/behave-plugin";
import { newWorkspace, turnOffPlugins, turnOnPlugin } from "./fixtures/installs";
import {
  confinedSpawn,
  HOST_VERSION,
  installGate,
  isPublicSuffix,
  listenForInstalls,
  listInstalled,
  loadPlugins,
  prepareInstall,
  storeBundle,
  type InstallPlan,
  type Plugins,
} from "./index";

const ID = "com.example.hello";
const PING = `${ID}/hello.ping`;
const status = await sandboxStatus();
const work = mkdtempSync(join(tmpdir(), "direx-installed-"));
const storeDir = join(work, "store");
const OWNER = crypto.randomUUID();
let owner: Awaited<ReturnType<typeof ownerClient>>;
let W = "";
let OTHER = "";
let v1: InstallPlan;
let v2: InstallPlan;
const opened: Plugins[] = [];

async function plan(file: string): Promise<InstallPlan> {
  const r = await prepareInstall(file, { hostVersion: HOST_VERSION, firstPartyIds: new Set(), isPublicSuffix });
  if (!r.ok) throw new Error(r.reasons.join("; "));
  return r.plan;
}

const put = async (mode: "install" | "upgrade", p: InstallPlan) => {
  await storeBundle(p, storeDir);
  await owner.query("select system.cli_install_plugin($1, $2, $3, $4, $5, $6)", [mode, ID, p.manifest.version, p.manifest, p.permissionHash, p.entrySha256]);
};
const turnOn = async (w: string) => {
  const [row] = (await owner.query("select install_id, permission_hash from system.plugin_installs where plugin_id = $1", [ID])).rows;
  await turnOnPlugin(w, { pluginId: ID, installId: String(row!.install_id), permissionHash: String(row!.permission_hash), by: OWNER });
};

const asked: unknown[] = [];

function setup() {
  const logs: string[] = [];
  const log = (l: string) => logs.push(l);
  const plugins = loadPlugins({
    sources: [],
    credentials: async (_ws, _id, use) => (asked.push(use), { key: "k" }),
    confinement: "external",
    spawn: confinedSpawn(log),
    log,
    hostOptions: { drainMs: 200, killMs: 200 },
    installed: { list: listInstalled, storeDir, gate: installGate },
  });
  opened.push(plugins);
  return { plugins, logs, prepare: (w: string) => plugins.prepare(w, PING, { message: "hi" }) };
}

beforeAll(async () => {
  owner = await ownerClient();
  await insertAuthUser(OWNER);
  W = await newWorkspace();
  OTHER = await newWorkspace();
  const built = await Bun.build({ entrypoints: [join(import.meta.dirname, "../../../../../packages/plugin-sdk/examples/hello/plugin.ts")], outdir: join(work, "v1"), target: "bun" });
  if (!built.success) throw new Error(built.logs.join("\n"));
  const first = built.outputs[0]!.path;
  // The same plugin with other bytes: what a re-uploaded build looks like.
  const second = join(work, "v2.js");
  writeFileSync(second, `${readFileSync(first, "utf8")}\n// rebuilt\n`);
  if (status.ok) {
    v1 = await plan(first);
    v2 = await plan(second);
  }
});
afterEach(async () => {
  await Promise.all(opened.splice(0).map((p) => p.close({ force: true })));
});
afterAll(() => owner.end());
beforeEach(async () => {
  await owner.query("delete from system.plugin_installs; delete from system.plugin_install_events");
  await owner.query("delete from workspace_plugins");
});

if (status.ok) {
  test("an installed plugin is loaded by reload, and runs only in a Workspace that turned it on", async () => {
    await put("install", v1);
    const { plugins, prepare } = setup();
    expect(plugins.effects[PING]).toBeUndefined();
    await plugins.reload();
    expect(plugins.effects[PING]).toMatchObject({ dedupe: "blind", reachesPerson: true });
    await expect(prepare(W)).rejects.toThrow(/can't run here: it isn't turned on in this Workspace/);
    await turnOn(W);
    expect(await prepare(W)).toEqual({ spec: { message: "hi" }, preview: 'Send "hi" to Hello' });
    await expect(prepare(OTHER)).rejects.toThrow(/isn't turned on in this Workspace/);
  });

  test("a third-party effect counts as reaching a Person whatever its manifest says, because core decides", async () => {
    await put("install", v1);
    const { plugins, logs } = setup();
    await plugins.reload();
    expect(plugins.effects[PING]!.reachesPerson).toBe(true);
    expect(logs).toContain(`plugin ${ID}: hello.ping is treated as reaching a Person, which core decides`);
  });

  test("an upgrade elsewhere is refused here until this process reloads, then the new bytes run and approvals go back", async () => {
    await put("install", v1);
    await turnOn(W);
    const { plugins, prepare } = setup();
    await plugins.reload();
    await prepare(W);
    const before = plugins.capabilityVersion(PING);
    const pids = plugins.processes().map((p) => p.pid);
    expect(pids).toHaveLength(1);

    await put("upgrade", v2);
    await expect(prepare(W)).rejects.toThrow(/it was upgraded, and this process hasn't loaded the new version yet/);
    await plugins.reload();
    // The old process is gone; the next call starts one on the new bytes, still turned on (same permissions).
    for (const pid of pids) expect(() => process.kill(pid, 0)).toThrow();
    expect(await prepare(W)).toMatchObject({ spec: { message: "hi" } });
    const after = plugins.capabilityVersion(PING);
    expect(after).not.toBeNull();
    expect(after).not.toBe(before);
  });

  test("a removal is refused at once, and reload takes the plugin and its effects away", async () => {
    await put("install", v1);
    await turnOn(W);
    const { plugins, prepare } = setup();
    await plugins.reload();
    await prepare(W);
    await owner.query("select system.cli_remove_plugin($1)", [ID]);
    await expect(prepare(W)).rejects.toThrow(/it is no longer installed/);
    await plugins.reload();
    expect(plugins.effects[PING]).toBeUndefined();
    expect(plugins.capabilityVersion(PING)).toBeNull();
    expect(plugins.processes()).toEqual([]);
  });

  test("its calls ask the vault only for a credential connected for its own connection, and its key connection is listed", async () => {
    await put("install", v1);
    await turnOn(W);
    const { plugins } = setup();
    await plugins.reload();
    expect(plugins.installedKeyServices()).toEqual([{ connection: `${ID}:hello`, name: "Hello" }]);
    asked.length = 0;
    // The sandbox refuses example.com, so the send fails; the credential was asked for first.
    await expect(plugins.effects[PING]!.execute({ message: "hi" }, { workspaceId: W, idempotencyKey: crypto.randomUUID(), credentialId: crypto.randomUUID() })).rejects.toThrow(/socket connection was closed/);
    expect(asked).toEqual([expect.objectContaining({ consumer: "execute", connections: [`${ID}:hello`] })]);
  });

  test("turning it off in a Workspace refuses the very next call, with no reload", async () => {
    await put("install", v1);
    await turnOn(W);
    const { plugins, prepare } = setup();
    await plugins.reload();
    await prepare(W);
    await turnOffPlugins(W);
    await expect(prepare(W)).rejects.toThrow(/isn't turned on in this Workspace/);
  });

  test("a change anywhere on the server is heard, so a process can reload without being asked", async () => {
    let heard = 0;
    const stop = await listenForInstalls(() => heard++);
    try {
      await put("install", v1);
      await owner.query("select system.cli_remove_plugin($1)", [ID]);
      for (let i = 0; i < 50 && heard < 2; i++) await Bun.sleep(20);
      expect(heard).toBe(2);
    } finally {
      await stop();
    }
  });
}

test("an installed row whose manifest is unreadable, claims first-party, or takes a shipped id is not loaded", async () => {
  const manifest = {
    id: ID, apiVersion: 1, version: "1.0.0", minHostVersion: "0.1.0", trust: "third_party",
    connections: [{ key: "x", auth: "api_key" }], egress: { hosts: ["api.example.com"] },
    capabilities: [{ kind: "effect", name: "hello.ping", connection: "x", dedupe: "blind", risk: "low", reachesPerson: false }],
  };
  const logs: string[] = [];
  const row = (m: unknown, pluginId = ID) => ({ pluginId, installId: crypto.randomUUID(), manifest: m, entrySha256: "1".repeat(64), generation: "1" });
  const plugins = loadPlugins({
    sources: [{ mode: "in_process", plugin: behavePlugin }],
    credentials: async () => null,
    confinement: "external",
    log: (l) => logs.push(l),
    installed: {
      list: async () => [
        row({ id: ID }),
        row({ ...manifest, id: "com.example.first", trust: "first_party" }, "com.example.first"),
        row({ ...manifest, id: "com.example.other" }, "com.example.mismatch"),
        row({ ...manifest, id: "com.example.behave" }, "com.example.behave"),
      ],
      storeDir,
      gate: async () => null,
    },
  });
  opened.push(plugins);
  await plugins.reload();
  expect(Object.keys(plugins.effects).filter((k) => !k.startsWith("com.example.behave/"))).toEqual([]);
  expect(logs).toEqual([
    expect.stringMatching(new RegExp(`^installed plugin ${ID} has a manifest this host can't read`)),
    "installed plugin com.example.first isn't loaded: its manifest doesn't match its install",
    "installed plugin com.example.mismatch isn't loaded: its manifest doesn't match its install",
    "installed plugin com.example.behave isn't loaded: a plugin this server ships has that id",
  ]);
});
