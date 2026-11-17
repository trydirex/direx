// SPDX-License-Identifier: MIT

// The smallest third-party plugin: one API key, one host it may reach, one effect a person approves
// before it runs. `bun run build` bundles it into dist/plugin.js, the one file Direx installs.
// Third-party plugins name their own effects; query names come from the SDK's catalogue, and the
// catalogue's current names are shapes only Direx's own plugins may offer for now.
import { definePlugin, runWorker, type Credential } from "@trydirex/plugin-sdk";

const HOST = "api.example.com";

export const plugin = definePlugin({
  manifest: {
    id: "com.example.hello",
    name: "Hello",
    apiVersion: 1,
    version: "0.1.0",
    minHostVersion: "0.2.0",
    trust: "third_party",
    connections: [{ key: "hello", auth: "api_key" }],
    egress: { hosts: [HOST] },
    capabilities: [{ kind: "effect", name: "hello.ping", connection: "hello", dedupe: "blind", risk: "low", reachesPerson: false }],
  },
  effects: {
    "hello.ping": {
      // What a person sees and approves; execute runs only the approved spec.
      prepare: async (input) => {
        const message = typeof (input as { message?: unknown } | null)?.message === "string" ? (input as { message: string }).message : "hello";
        return { spec: { message }, preview: `Send "${message}" to Hello` };
      },
      // The key goes only to the one host the manifest lists.
      async execute(spec, ctx) {
        const key = keyOf(ctx.credential);
        const res = await fetch(`https://${HOST}/v1/ping`, { method: "POST", headers: { authorization: `Bearer ${key}`, "content-type": "application/json" }, body: JSON.stringify(spec) });
        if (res.status === 401) return { kind: "refused", permanent: true, retryable: false, credentialRejected: true, detail: "Hello refused the key" };
        if (!res.ok) return { kind: "refused", permanent: false, retryable: true, detail: `Hello answered ${res.status}` };
        const body = (await res.json()) as { id?: unknown };
        return { kind: "sent", providerRef: typeof body.id === "string" ? body.id : "" };
      },
    },
  },
});

function keyOf(c: Credential | null): string {
  const key = c && "key" in c ? c.key.trim() : "";
  if (!key) throw new Error("Hello is not connected: add its API key");
  return key;
}

if (import.meta.main) await runWorker(plugin);
