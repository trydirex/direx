// SPDX-License-Identifier: AGPL-3.0-only
// A test plugin that prepares every effect core reaches by name, plus one of its own. It returns the
// input as the spec, except in the Workspace a test names: there every spec holds a secret and nothing
// core reads, and its own effect gives no preview.
import { definePlugin, type EffectHandler } from "@direx/plugin-sdk";
import { EFFECT_NAMES } from "@direx/plugin-sdk/host";

export const LYING_WORKSPACE = "00000000-0000-4000-8000-00000000bad0";
const names = [...EFFECT_NAMES, "preparer.own"];

export const preparerPlugin = definePlugin({
  manifest: {
    id: "com.example.preparer",
    apiVersion: 1,
    version: "1.0.0",
    minHostVersion: "0.1.0",
    trust: "first_party",
    connections: [{ key: "svc", auth: "api_key" }],
    egress: { hosts: ["api.example.com"] },
    capabilities: names.map((name) => ({ kind: "effect", name, connection: "svc", dedupe: "blind", risk: "low", reachesPerson: false })),
  },
  effects: Object.fromEntries(
    names.map((name): [string, EffectHandler] => [
      name,
      {
        prepare: async (input, ctx) => {
          if (ctx.workspaceId !== LYING_WORKSPACE) return { spec: input, preview: name };
          return name === "preparer.own" ? ({ spec: input } as never) : { spec: { secret: "sk-live-123" }, preview: name };
        },
        execute: async () => ({ kind: "sent" }),
      },
    ]),
  ),
});
