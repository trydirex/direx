// SPDX-License-Identifier: AGPL-3.0-only
// A test plugin whose execute does what spec.do says: answer, hang, crash, or break the
// protocol in one of the ways the host must survive. "MARK <name>" on stderr tells a
// test the plugin has reached that point.
import { accessToken, definePlugin, PluginError, type TriggerEvent } from "@direx/plugin-sdk";
import { behaveManifest } from "./manifest";

const never = () => new Promise<never>(() => {});
const mark = (name: string) => process.stderr.write(`MARK ${name}\n`);
const line = (m: unknown) => process.stdout.write(`${JSON.stringify(m)}\n`);

export const behavePlugin = definePlugin({
  manifest: behaveManifest,
  effects: {
    "behave.send": {
      prepare: async (input) => ({ spec: input, preview: `send ${JSON.stringify(input)}` }),
      async execute(spec, ctx) {
        const s = spec as { do: string; marker?: string };
        switch (s.do) {
          case "sent":
            return { kind: "sent", providerRef: `ws=${ctx.workspaceId} token=${accessToken(ctx.credential) ?? "none"}` };
          case "env":
            return { kind: "sent", providerRef: Object.keys(process.env).sort().join(",") };
          // For the sandbox tests: what a hostile plugin would try, reported instead of thrown.
          case "fetch":
            return fetch((s as { url?: string }).url ?? "").then(
              (r) => ({ kind: "sent", providerRef: `status ${r.status}` }),
              (e: unknown) => ({ kind: "sent", providerRef: `failed ${String(e)}` }),
            );
          case "read":
            return Bun.file((s as { path?: string }).path ?? "")
              .text()
              .then(
                (t) => ({ kind: "sent", providerRef: `read ${t.length}` }),
                (e: unknown) => ({ kind: "sent", providerRef: `failed ${String(e)}` }),
              );
          case "run": {
            const p = Bun.spawn((s as { cmd?: string[] }).cmd ?? [], { stdout: "ignore", stderr: "pipe" });
            const code = await p.exited;
            return { kind: "sent", providerRef: `exit ${code} ${(await new Response(p.stderr).text()).trim()}` };
          }
          case "refuse":
            return { kind: "refused", permanent: false, retryable: true, detail: "rate limited" };
          case "leak":
            return { kind: "refused", permanent: false, retryable: true, detail: `provider rejected ${JSON.stringify(ctx.credential)}` };
          case "bad-shape":
            return { kind: "maybe" } as never;
          case "throw":
            throw new Error("provider exploded");
          case "hang":
            mark(s.marker ?? "hang");
            return never();
          case "exit":
            mark(s.marker ?? "exit");
            process.exit(3);
            return never();
          case "garbage":
            process.stdout.write("this is not json\n");
            return never();
          case "oversize":
            process.stdout.write("x".repeat(2 * 1024 * 1024));
            return never();
          case "unknown-id":
            line({ jsonrpc: "2.0", id: 999_999, result: null });
            return never();
          case "rogue":
            line({ jsonrpc: "2.0", id: "r1", method: "credentials.resolve", params: { key: "svc" } });
            return { kind: "sent", providerRef: "rogue" };
          default:
            throw new Error(`unknown behaviour ${s.do}`);
        }
      },
    },
    "behave.check": {
      prepare: async (input) => ({ spec: input, preview: "check" }),
      execute: async () => ({ kind: "sent", correlationKey: "found-1" }),
      reconcile: async (key) => (key.startsWith("found") ? { kind: "sent", providerRef: key } : { kind: "not_sent" }),
    },
  },
  queries: {
    "mailbox.probe_read": async (input, ctx) => {
      const asked = (input as { actionId?: string } | null)?.actionId;
      // A provider that echoes the credential it was given in its error.
      if (asked === "leak") throw new Error(`bad token ${accessToken(ctx.credential)}`);
      // A provider asking the host to slow down, as typed error data.
      if (asked === "slow") throw new PluginError("rate_limited", "slow down", { status: 429, waitMs: 1500 });
      // An answer that fits no probe, holding a token the host must not repeat.
      if (asked === "malformed") return { found: "maybe", headers: accessToken(ctx.credential) };
      // The probe it finds carries the Workspace and token it was called with, for tests to see.
      return { found: true, folder: "inbox", headers: ctx.workspaceId, text: accessToken(ctx.credential) ?? "", html: null };
    },
  },
  triggers: {
    "behave.feed": {
      // Each poll returns the event at the cursor again plus the next one, so
      // consecutive polls overlap by one event. Cursor "3" crashes the plugin.
      async poll(cursor) {
        const n = cursor === null ? 1 : Number(cursor);
        if (n === 3) {
          if (process.env.DIREX_PLUGIN_DIR) process.exit(4);
          throw new Error("feed broke");
        }
        const events: TriggerEvent[] = [n, n + 1].map((i) => ({ eventId: `e${i}`, data: { n: i } }));
        return { events, cursor: String(n + 1) };
      },
    },
    "behave.hook": {
      normalize: async (payload) => (payload as { events: TriggerEvent[] }).events,
    },
  },
});
