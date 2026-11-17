// SPDX-License-Identifier: AGPL-3.0-only
// What may be installed (ADR 0026 rule 003), what turn-on is bound to (rule 002), and the probe that
// reads a manifest by running the file with no network (rule 005).
import type { Manifest } from "@direx/plugin-sdk";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, describe, expect, test } from "vitest";
import { sandboxStatus } from "../models";
import { behaveManifest } from "./fixtures/manifest";
import { HOST_VERSION, installRefusals, isPublicSuffix, permissionHash, probePlugin } from "./index";

const thirdParty: Manifest = {
  id: "com.example.links",
  apiVersion: 1,
  version: "1.0.0",
  minHostVersion: "0.1.0",
  trust: "third_party",
  connections: [{ key: "svc", auth: "api_key" }],
  egress: { hosts: ["api.example.com", "*.example.net"] },
  capabilities: [{ kind: "effect", name: "links.check", connection: "svc", dedupe: "blind", risk: "low", reachesPerson: false }],
};
const checks = { firstPartyIds: new Set(["com.example.gmail"]), isPublicSuffix: (n: string) => ["com", "co.uk", "workers.dev"].includes(n) };
const withMore = (patch: Partial<Manifest>): Manifest => ({ ...thirdParty, ...patch });

describe("installRefusals", () => {
  test("a plain third-party plugin with an API key and its own hosts may be installed", () => {
    expect(installRefusals(thirdParty, checks)).toEqual([]);
  });

  test("anything claiming to be first-party, or taking a Direx or shipped id, is refused", () => {
    expect(installRefusals(withMore({ trust: "first_party" }), checks)).toEqual([expect.stringMatching(/says it is first-party/)]);
    expect(installRefusals(withMore({ id: "com.trydirex.gmail" }), checks)).toEqual([expect.stringMatching(/belongs to Direx's own plugins/)]);
    expect(installRefusals(withMore({ id: "direx.links" }), checks)).toEqual([expect.stringMatching(/belongs to Direx's own plugins/)]);
    expect(installRefusals(withMore({ id: "com.example.gmail" }), checks)).toEqual([expect.stringMatching(/belongs to Direx's own plugins/)]);
  });

  test("core shapes, OAuth, media and costs are refused, each with its own reason", () => {
    const r = installRefusals(
      withMore({
        connections: [{ key: "svc", auth: "oauth2" }],
        capabilities: [
          { kind: "effect", name: "email.send", connection: "svc", dedupe: "blind", risk: "low", reachesPerson: true },
          { kind: "effect", name: "links.post", connection: "svc", dedupe: "blind", risk: "low", reachesPerson: false, media: "read", costs: true },
        ],
      }),
      checks,
    );
    expect(r).toEqual([
      expect.stringMatching(/email\.send is a shape only/),
      expect.stringMatching(/links\.post asks to read media/),
      expect.stringMatching(/links\.post costs money/),
      expect.stringMatching(/connection svc signs in with OAuth/),
    ]);
  });

  test("only an API key connection can be connected yet; header, basic and secret are refused", () => {
    const withAuth = (auth: "header" | "basic" | "secret") => withMore({ connections: [{ key: "svc", auth }] });
    expect(installRefusals(withAuth("basic"), checks)).toEqual(["connection svc uses basic, which third-party plugins can't connect yet; use api_key"]);
    expect(installRefusals(withAuth("header"), checks)).toHaveLength(1);
    expect(installRefusals(withAuth("secret"), checks)).toHaveLength(1);
  });

  test("a trigger is refused, since installed plugins' triggers aren't run yet", () => {
    const withTrigger = withMore({ capabilities: [...thirdParty.capabilities, { kind: "trigger", name: "links.found", connection: "svc", source: "poll", pollIntervalMs: 60_000 }] });
    expect(installRefusals(withTrigger, checks)).toEqual(["links.found is a trigger, which third-party plugins can't have yet"]);
  });

  test("a wildcard on a public suffix is refused; a wildcard on a real domain is not", () => {
    expect(installRefusals(withMore({ egress: { hosts: ["*.co.uk", "*.workers.dev", "*.example.net"] } }), checks)).toEqual([
      "*.co.uk would reach every site under co.uk",
      "*.workers.dev would reach every site under workers.dev",
    ]);
  });
});

describe("isPublicSuffix", () => {
  test("ICANN and PRIVATE suffixes count; a registrable domain or a name below one doesn't", () => {
    for (const n of ["com", "co.uk", "workers.dev", "herokuapp.com", "blob.core.windows.net", "CO.UK"]) expect(isPublicSuffix(n)).toBe(true);
    for (const n of ["example.com", "example.co.uk", "api.example.com", "myapp.workers.dev"]) expect(isPublicSuffix(n)).toBe(false);
  });

  test("used as the installer's check, it refuses a wildcard over shared hosting", () => {
    expect(installRefusals(withMore({ egress: { hosts: ["*.herokuapp.com", "*.example.net"] } }), { ...checks, isPublicSuffix })).toEqual([
      "*.herokuapp.com would reach every site under herokuapp.com",
    ]);
  });
});

describe("permissionHash", () => {
  test("order doesn't matter, and the version isn't part of it", () => {
    const shuffled = withMore({ version: "2.0.0", egress: { hosts: ["*.example.net", "api.example.com"] } });
    expect(permissionHash(shuffled)).toBe(permissionHash(thirdParty));
  });

  test("a new host, connection or capability changes it", () => {
    const base = permissionHash(thirdParty);
    expect(permissionHash(withMore({ egress: { hosts: [...thirdParty.egress.hosts, "other.example.org"] } }))).not.toBe(base);
    expect(permissionHash(withMore({ connections: [...thirdParty.connections, { key: "two", auth: "api_key" }] }))).not.toBe(base);
    expect(permissionHash(withMore({ capabilities: [...thirdParty.capabilities, { kind: "effect", name: "links.other", connection: "svc", dedupe: "blind", risk: "high", reachesPerson: false }] }))).not.toBe(base);
  });
});

const status = await sandboxStatus();

describe("probePlugin", () => {
  let bundle = "";
  const dir = mkdtempSync(join(tmpdir(), "direx-probe-"));
  const file = (name: string, body: string) => {
    const path = join(dir, name);
    writeFileSync(path, body);
    return path;
  };

  beforeAll(async () => {
    const built = await Bun.build({ entrypoints: [join(import.meta.dirname, "fixtures", "behave.ts")], outdir: dir, target: "bun" });
    if (!built.success) throw new Error(built.logs.join("\n"));
    bundle = built.outputs[0]!.path;
  });

  if (status.ok) {
    test("it reads the manifest the file reports when it runs", async () => {
      expect(await probePlugin(bundle, { hostVersion: HOST_VERSION })).toEqual({ ok: true, manifest: behaveManifest });
    });

    test("a file that never answers is stopped after the time limit", async () => {
      const r = await probePlugin(file("silent.js", "setInterval(() => {}, 1000);"), { hostVersion: HOST_VERSION, timeoutMs: 500 });
      expect(r).toEqual({ ok: false, reason: "it didn't answer within 0.5 seconds" });
    });

    test("a file that exits, prints garbage or reports a bad manifest is refused with the reason", async () => {
      expect(await probePlugin(file("exit.js", "process.exit(0);"), { hostVersion: HOST_VERSION })).toEqual({ ok: false, reason: "it exited without answering" });
      expect(await probePlugin(file("garbage.js", 'console.log("hello");'), { hostVersion: HOST_VERSION })).toEqual({ ok: false, reason: "its first line isn't JSON-RPC" });
      const bad = file("bad.js", 'console.log(JSON.stringify({ jsonrpc: "2.0", id: 1, result: { manifest: { id: "x" } } }));');
      expect(await probePlugin(bad, { hostVersion: HOST_VERSION })).toMatchObject({ ok: false, reason: expect.stringMatching(/^its manifest is invalid: /) });
    });

    test("the file gets no network while it is probed, not even to a host its own manifest lists", async () => {
      // The file reports what it saw as its manifest's id, so the probe's answer says whether it got out.
      const reach = file(
        "reach.js",
        `const m = ${JSON.stringify(behaveManifest)};
         const seen = await fetch("https://api.example.com/").then(() => "reached", () => "blocked");
         console.log(JSON.stringify({ jsonrpc: "2.0", id: 1, result: { manifest: { ...m, id: "com.example." + seen } } }));`,
      );
      expect(await probePlugin(reach, { hostVersion: HOST_VERSION })).toMatchObject({ ok: true, manifest: { id: "com.example.blocked" } });
    });
  } else {
    test("where the sandbox can't hold, nothing is probed and the reason says why", async () => {
      expect(await probePlugin(bundle, { hostVersion: HOST_VERSION })).toEqual({ ok: false, reason: status.reason });
    });
  }
});
