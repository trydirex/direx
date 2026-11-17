// SPDX-License-Identifier: AGPL-3.0-only
// The host parses the input core passes to prepare, and the spec a plugin prepares, through the
// effect's catalogue entry, in and out of process (ADR 0028 rule 001). Input core built wrong is core's
// bug, never a CallFailed; a spec that doesn't fit is the provider's error, named by the effect and
// never by the spec. A plugin's own effect stays opaque.
import { join } from "node:path";
import type { EffectName } from "@direx/plugin-sdk";
import { EFFECTS } from "@direx/plugin-sdk/host";
import { afterAll, describe, expect, test } from "vitest";
import { LYING_WORKSPACE, preparerPlugin } from "./fixtures/preparer-plugin";
import { CallFailed, loadPlugins, type PluginSource } from "./index";

const W = crypto.randomUUID();
const mail = { to: ["kim@b.example"], subject: "Hi", text: "Hello" };
const issue = { title: "Week 12", html: "<p>Hi</p>" };
/** An input each entry takes, as core builds it. */
const INPUTS: Record<EffectName, Record<string, unknown>> = {
  "email.send": { ...mail, listUnsubscribe: "https://b.example/u/1" },
  "mailbox.probe": mail,
  "placement.join": { ...mail, inReplyTo: "<1@x>", references: ["<1@x>"] },
  "placement.send": mail,
  "placement.report": mail,
  "placement.archive": { messageId: "<1@x>" },
  "newsletter.draft": issue,
  "newsletter.send": { issueId: "1" },
  "newsletter.publish": { ...issue, at: "2026-11-20T09:00:00Z", audience: { kind: "newsletter_list" } },
  "newsletter.cancel": { issueId: "1" },
  "social.publish": { text: "Hello", followUps: [], target: null, links: true },
  "docs.row.update": { pageId: "p1", statusPropertyId: "st", statusType: "status", optionId: "o1", lastOptionId: null },
};
const names = Object.keys(EFFECTS) as EffectName[];
const ID = (name: string) => `com.example.preparer/${name}`;
const dir = join(import.meta.dirname, "fixtures");
const load = (source: PluginSource) => loadPlugins({ sources: [source], credentials: async () => ({ key: "k" }), confinement: "external", log: () => {} });
const modes = {
  in_process: load({ mode: "in_process", plugin: preparerPlugin }),
  process: load({ mode: "process", manifest: preparerPlugin.manifest, entry: join(dir, "preparer.ts"), dir }),
};
afterAll(() => modes.process.close({ force: true }));

describe.each(Object.entries(modes))("%s", (_mode, plugins) => {
  test.each(names)("%s: a spec that fits goes on exactly as the plugin prepared it", async (name) => {
    expect(await plugins.prepare(W, ID(name), INPUTS[name])).toEqual({ spec: INPUTS[name], preview: name });
  });

  test.each(names)("%s: malformed input is core's own error and never reaches the plugin", async (name) => {
    const e = await plugins.prepare(W, ID(name), { ...INPUTS[name], extra: 1 }).catch((x: unknown) => x);
    expect(e).toBeInstanceOf(Error);
    expect(e).not.toBeInstanceOf(CallFailed);
    expect((e as Error).message).toBe(`the input for ${name} does not fit its catalogue entry`);
  });

  test.each(names.filter((n) => "spec" in EFFECTS[n]))("%s: a malformed spec is a provider_error naming the effect, not the spec", async (name) => {
    const e = await plugins.prepare(LYING_WORKSPACE, ID(name), INPUTS[name]).catch((x: unknown) => x);
    expect(e).toBeInstanceOf(CallFailed);
    expect(e).toMatchObject({ reason: "provider_error", message: `the spec ${name} prepared does not fit its catalogue entry` });
    expect((e as Error).message).not.toContain("sk-live");
  });

  test.each(names.filter((n) => !("spec" in EFFECTS[n])))("%s: a spec Direx never reads stays the plugin's own", async (name) => {
    expect(await plugins.prepare(LYING_WORKSPACE, ID(name), INPUTS[name])).toEqual({ spec: { secret: "sk-live-123" }, preview: name });
  });

  test("a plugin's own effect keeps its input and spec opaque, but must still give a preview", async () => {
    expect(await plugins.prepare(W, ID("preparer.own"), { anything: [1, 2] })).toEqual({ spec: { anything: [1, 2] }, preview: "preparer.own" });
    await expect(plugins.prepare(LYING_WORKSPACE, ID("preparer.own"), {})).rejects.toMatchObject({ reason: "provider_error", message: "preparer.own did not prepare a spec and a preview" });
  });
});
