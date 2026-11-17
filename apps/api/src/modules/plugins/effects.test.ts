// SPDX-License-Identifier: AGPL-3.0-only
// Loading rules, and the same plugin in and out of process.
import { join } from "node:path";
import { afterAll, expect, test } from "vitest";
import { definePlugin } from "@direx/plugin-sdk";
import { behavePlugin } from "./fixtures/behave-plugin";
import { behaveManifest } from "./fixtures/manifest";
import { touchCheck } from "../schedule/index";
import { loadPlugins, type PluginSource } from "./index";
import { PLACEMENT_EFFECTS, reachesPerson } from "./application/mailbox";

const dir = join(import.meta.dirname, "fixtures");
const W = crypto.randomUUID();
const credentials = async (ws: string) => ({ accessToken: `tok-${ws}`, expiresAt: "2026-11-02T10:00:00Z" });
const load = (source: PluginSource) => loadPlugins({ sources: [source], credentials, confinement: "external", log: () => {} });

const inProc = load({ mode: "in_process", plugin: behavePlugin });
const outProc = load({ mode: "process", manifest: behaveManifest, entry: join(dir, "behave.ts"), dir });
afterAll(() => outProc.close({ force: true }));

const shape = (effects: typeof inProc.effects) =>
  Object.fromEntries(
    Object.entries(effects).map(([k, e]) => [k, { dedupe: e.dedupe, reconcile: "reconcile" in e, keyWindowMs: "keyWindowMs" in e }]),
  );

test("one plugin gives the same capability records in and out of process", () => {
  expect(Object.keys(inProc.effects).sort()).toEqual(["com.example.behave/behave.check", "com.example.behave/behave.send"]);
  expect(shape(outProc.effects)).toEqual(shape(inProc.effects));
});

test("only a plugin shipped in core may say its effect reaches no Person, whatever its manifest claims", async () => {
  const check = "com.example.behave/behave.check";
  // The manifest says first_party and reachesPerson: false; out of process, neither is taken on trust.
  expect(behaveManifest.trust).toBe("first_party");
  expect(inProc.effects[check]!.reachesPerson).toBe(false);
  expect(outProc.effects[check]!.reachesPerson).toBe(true);
  // So an Action with no Touch can't use it to skip Touch caps and suppression.
  const row = { capability: check, spec: { to: "dana@example.com" } } as Parameters<ReturnType<typeof touchCheck>>[1];
  const now = () => new Date();
  const approval = { approverId: "u1", standingRuleId: null, producerDigest: null };
  expect(await touchCheck({ effects: inProc.effects, now })({} as never, row, approval)).toEqual({ kind: "ok" });
  expect(await touchCheck({ effects: outProc.effects, now })({} as never, row, approval)).toMatchObject({ kind: "block", reason: "touch_undeclared" });
});

test("core alone decides which placement effects reach no Person, whatever the manifest says", async () => {
  const effect = (name: string, reaches: boolean) => ({ kind: "effect", name, connection: "svc", dedupe: "blind", risk: "low", reachesPerson: reaches }) as const;
  const manifest = {
    ...behaveManifest,
    id: "com.example.circle",
    capabilities: [effect("placement.send", true), effect("placement.forward", false), effect("behave.check", false)],
  };
  const handler = { prepare: async (input: unknown) => ({ spec: input, preview: "x" }), execute: async () => ({ kind: "sent", providerRef: "r" }) as const };
  const plugin = definePlugin({ manifest, effects: { "placement.send": handler, "placement.forward": handler, "behave.check": handler } });
  const { effects } = load({ mode: "in_process", plugin });

  // A known placement effect reaches no Person even though its manifest says it does.
  expect(effects["com.example.circle/placement.send"]!.reachesPerson).toBe(false);
  // A placement name core doesn't know reaches a Person even though its manifest says it doesn't.
  expect(effects["com.example.circle/placement.forward"]!.reachesPerson).toBe(true);
  // Other in-core effects keep their manifest's answer, so social posts and newsletter drafts are unchanged.
  expect(effects["com.example.circle/behave.check"]!.reachesPerson).toBe(false);

  const row = (capability: string) => ({ capability, spec: { to: "member@example.com" } }) as Parameters<ReturnType<typeof touchCheck>>[1];
  const approval = { approverId: "u1", standingRuleId: null, producerDigest: null };
  const check = touchCheck({ effects, now: () => new Date() });
  expect(await check({} as never, row("com.example.circle/placement.send"), approval)).toEqual({ kind: "ok" });
  expect(await check({} as never, row("com.example.circle/placement.forward"), approval)).toMatchObject({ kind: "block", reason: "touch_undeclared" });
});

test("a placement effect from a plugin outside core always reaches a Person", () => {
  for (const name of PLACEMENT_EFFECTS) {
    expect(reachesPerson(name, false, false)).toBe(true);
    expect(reachesPerson(name, true, true)).toBe(false);
  }
  expect(reachesPerson("social.publish", false, true)).toBe(false);
  expect(reachesPerson("social.publish", false, false)).toBe(true);
});

test("one plugin gives the same results in and out of process", async () => {
  const ctx = { workspaceId: W, idempotencyKey: "k-1" };
  for (const p of [inProc, outProc]) {
    expect(await p.effects["com.example.behave/behave.send"]!.execute({ do: "sent" }, ctx)).toEqual({
      kind: "sent",
      providerRef: `ws=${W} token=tok-${W}`,
    });
    const check = p.effects["com.example.behave/behave.check"]!;
    if (check.dedupe !== "queryable") throw new Error("expected queryable");
    expect(await check.reconcile("found-7", ctx)).toEqual({ kind: "sent", providerRef: "found-7" });
    expect(await check.reconcile("other", ctx)).toEqual({ kind: "not_sent" });
    expect(await p.prepare(W, "com.example.behave/behave.send", { to: "dana@example.com" })).toEqual({
      spec: { to: "dana@example.com" },
      preview: 'send {"to":"dana@example.com"}',
    });
    expect(await p.query(W, "com.example.behave/mailbox.probe_read", { actionId: "a1", subject: "s" })).toEqual({ found: true, folder: "inbox", headers: W, text: `tok-${W}`, html: null });
  }
});

test("an effect whose answer has the wrong shape, or throws, fails in process as it does out of process", async () => {
  const send = inProc.effects["com.example.behave/behave.send"]!;
  await expect(send.execute({ do: "bad-shape" }, { workspaceId: W, idempotencyKey: "k" })).rejects.toThrow();
  await expect(send.execute({ do: "throw" }, { workspaceId: W, idempotencyKey: "k" })).rejects.toThrow(/provider exploded/);
});

test("a third-party plugin cannot be loaded in process", () => {
  const thirdParty = definePlugin({ ...behavePlugin, manifest: { ...behaveManifest, trust: "third_party" } });
  expect(() => load({ mode: "in_process", plugin: thirdParty })).toThrow(/only first-party plugins run in process/);
});

test("costs, a newer host version and a duplicate id are refused at load", () => {
  const caps = behaveManifest.capabilities.map((c) => (c.name === "behave.send" ? { ...c, costs: true } : c));
  expect(() => load({ mode: "process", manifest: { ...behaveManifest, capabilities: caps }, entry: "x", dir })).toThrow(
    /declares costs, and budgets are not supported by this host/,
  );
  expect(() => load({ mode: "process", manifest: { ...behaveManifest, minHostVersion: "9.0.0" }, entry: "x", dir })).toThrow(
    /needs host 9\.0\.0/,
  );
  const twice = { mode: "in_process", plugin: behavePlugin } as const;
  expect(() => loadPlugins({ sources: [twice, twice], credentials, confinement: "none" })).toThrow(/loaded twice/);
  expect(() => load({ mode: "process", manifest: { ...behaveManifest, extra: 1 }, entry: "x", dir })).toThrow(/invalid manifest/);
});
