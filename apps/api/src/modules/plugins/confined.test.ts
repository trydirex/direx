// SPDX-License-Identifier: AGPL-3.0-only
// A plugin in the real sandbox (ADR 0026 rules 006 and 007): the fixture plugin is bundled into one
// file, as an installed plugin is, then started through confinedSpawn and asked to break out.
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, expect, test } from "vitest";
import { sandboxStatus } from "../models";
import { behaveManifest } from "./fixtures/manifest";
import { confinedSpawn, loadPlugins, type Plugins } from "./index";

const W1 = crypto.randomUUID();
const SEND = "com.example.behave/behave.send";
const status = await sandboxStatus();
const opened: Plugins[] = [];
let bundle = "";
const hostFile = join(mkdtempSync(join(tmpdir(), "direx-host-")), "secret.txt");

beforeAll(async () => {
  writeFileSync(hostFile, "HOST-FILE-MARKER");
  const out = mkdtempSync(join(tmpdir(), "direx-bundle-"));
  const built = await Bun.build({ entrypoints: [join(import.meta.dirname, "fixtures", "behave.ts")], outdir: out, target: "bun" });
  if (!built.success) throw new Error(built.logs.join("\n"));
  bundle = built.outputs[0]!.path;
});

afterEach(async () => {
  await Promise.all(opened.splice(0).map((p) => p.close({ force: true })));
});

afterAll(() => {
  delete process.env.DIREX_TEST_HOST_SECRET;
});

function setup() {
  const logs: string[] = [];
  const log = (l: string) => logs.push(l);
  const plugins = loadPlugins({
    sources: [{ mode: "process", manifest: behaveManifest, entry: bundle, dir: tmpdir() }],
    credentials: async () => ({ accessToken: "tok", expiresAt: "2026-11-02T10:00:00Z" }),
    confinement: "external",
    spawn: confinedSpawn(log),
    log,
    hostOptions: { drainMs: 200, killMs: 200 },
  });
  opened.push(plugins);
  const send = async (spec: unknown) => {
    const r = await plugins.effects[SEND]!.execute(spec, { workspaceId: W1, idempotencyKey: crypto.randomUUID() });
    return r.kind === "sent" ? (r.providerRef ?? "") : JSON.stringify(r);
  };
  return { send, logs };
}

if (status.ok) {
  test("a confined plugin answers calls, and sees only the environment it was given", async () => {
    process.env.DIREX_TEST_HOST_SECRET = "do-not-leak";
    const { send } = setup();
    expect(await send({ do: "sent" })).toBe(`ws=${W1} token=tok`);
    const env = (await send({ do: "env" })).split(",");
    expect(env).not.toContain("DIREX_TEST_HOST_SECRET");
    for (const key of env) expect(["DIREX_PLUGIN_DIR", "HOME", "HTTPS_PROXY", "HTTP_PROXY", "PATH", "PWD", "http_proxy", "https_proxy"]).toContain(key);
  });

  test("it can't read a host file, and its own file is the only one of the host's it sees", async () => {
    const { send } = setup();
    expect(await send({ do: "read", path: hostFile })).toMatch(/^failed .*ENOENT/);
    expect(await send({ do: "read", path: "/etc/hostname" })).toMatch(/^failed/);
    expect(await send({ do: "read", path: "/plugin/plugin.js" })).toMatch(/^read \d+/);
  });

  test("a host its manifest doesn't list fails as a network error, and the attempt is logged", async () => {
    const { send, logs } = setup();
    expect(await send({ do: "fetch", url: "https://other.example/" })).toMatch(/^failed /);
    expect(logs.some((l) => /com\.example\.behave tried to reach other\.example:443, refused: not an allowed host/.test(l))).toBe(true);
  });

  test("a listed host on a port other than 443 is refused too", async () => {
    const { send, logs } = setup();
    expect(await send({ do: "fetch", url: "https://api.example.com:8443/" })).toMatch(/^failed /);
    expect(logs.some((l) => /api\.example\.com:8443, refused: not an allowed host/.test(l))).toBe(true);
  });

  test("it can't make new namespaces, and /tmp stops at 64 MB", async () => {
    const { send } = setup();
    expect(await send({ do: "run", cmd: ["unshare", "-U", "true"] })).toMatch(/^exit 1 /);
    expect(await send({ do: "run", cmd: ["unshare", "-n", "true"] })).toMatch(/^exit 1 /);
    expect(await send({ do: "run", cmd: ["dd", "if=/dev/zero", "of=/tmp/big", "bs=1M", "count=80"] })).toMatch(/^exit 1 .*No space left/);
  });

  test("its processes are gone once the host closes", async () => {
    const { send } = setup();
    await send({ do: "sent" });
    const pids = opened[0]!.processes().map((p) => p.pid);
    expect(pids).toHaveLength(1);
    await opened.splice(0)[0]!.close();
    for (const pid of pids) expect(() => process.kill(pid, 0)).toThrow();
  });
} else {
  test("where the sandbox can't hold, a confined plugin doesn't start and the refusal gives the reason", async () => {
    const { send } = setup();
    await expect(send({ do: "sent" })).rejects.toThrow(status.reason);
  });
}
