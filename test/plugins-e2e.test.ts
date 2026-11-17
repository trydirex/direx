// SPDX-License-Identifier: AGPL-3.0-only
// One third-party plugin end to end (ADR 0026): the hello example bundled as its author bundles it,
// installed by `bun run plugin` (read in the sandbox with no network), loaded by the registry,
// refused until a Workspace owner turns it on, run confined, then removed and refused at once.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, expect, test } from "vitest";
import { sandboxStatus } from "../apps/api/src/modules/models/index";
import { newWorkspace, turnOnPlugin } from "../apps/api/src/modules/plugins/fixtures/installs";
import { confinedSpawn, installGate, listInstalled, loadPlugins } from "../apps/api/src/modules/plugins/index";
import { pluginCli } from "../scripts/plugin";
import { insertAuthUser, ownerClient } from "./db";

const ID = "com.example.hello";
const status = await sandboxStatus();
const work = mkdtempSync(join(tmpdir(), "direx-plugins-e2e-"));
const storeDir = join(work, "store");
let owner: Awaited<ReturnType<typeof ownerClient>>;
let bundle = "";

beforeAll(async () => {
  owner = await ownerClient();
  await owner.query("delete from system.plugin_installs");
  const built = await Bun.build({ entrypoints: [join(import.meta.dirname, "../packages/plugin-sdk/examples/hello/plugin.ts")], outdir: join(work, "dist"), target: "bun" });
  if (!built.success) throw new Error(built.logs.join("\n"));
  bundle = built.outputs[0]!.path;
});
afterAll(() => owner.end());

const cli = (args: string[]) => pluginCli(args, owner, { storeDir, firstPartyIds: new Set(), print: () => {}, confirm: async () => true });

if (status.ok) {
  test("install, turn on, run confined, remove", async () => {
    const W = await newWorkspace();
    const OWNER = crypto.randomUUID();
    await insertAuthUser(OWNER);
    const logs: string[] = [];
    const plugins = loadPlugins({
      sources: [],
      credentials: async () => ({ key: "k" }),
      confinement: "external",
      spawn: confinedSpawn((l) => logs.push(l)),
      log: (l) => logs.push(l),
      hostOptions: { drainMs: 200, killMs: 200 },
      installed: { list: listInstalled, storeDir, gate: installGate },
    });
    try {
      expect(await cli(["install", bundle])).toBe(0);
      await plugins.reload();
      const ping = () => plugins.prepare(W, `${ID}/hello.ping`, { message: "hi" });
      await expect(ping()).rejects.toThrow(/isn't turned on in this Workspace/);

      const [row] = (await owner.query("select install_id, permission_hash from system.plugin_installs where plugin_id = $1", [ID])).rows;
      await turnOnPlugin(W, { pluginId: ID, installId: String(row!.install_id), permissionHash: String(row!.permission_hash), by: OWNER });
      expect(await ping()).toEqual({ spec: { message: "hi" }, preview: 'Send "hi" to Hello' });
      expect(plugins.processes()).toEqual([expect.objectContaining({ pluginId: ID, workspaceId: W })]);

      expect(await cli(["remove", ID])).toBe(0);
      await expect(ping()).rejects.toThrow(/no longer installed/);
      await plugins.reload();
      expect(plugins.processes()).toEqual([]);
      expect(plugins.effects[`${ID}/hello.ping`]).toBeUndefined();
    } finally {
      await plugins.close({ force: true });
      await owner.query("delete from system.plugin_installs");
    }
  });
} else {
  test("where the sandbox can't hold, the plugin can't be installed", async () => {
    expect(await cli(["install", bundle])).toBe(1);
  });
}
