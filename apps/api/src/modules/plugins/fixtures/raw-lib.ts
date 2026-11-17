// SPDX-License-Identifier: AGPL-3.0-only
// A hand-written worker without the SDK, for host behaviour the SDK would never show:
// echoing every received line, reporting a different manifest, ignoring shutdown.
import { behaveManifest } from "./manifest";

export function serveRaw(opts: { spy?: boolean; manifest?: unknown; stubborn?: boolean }) {
  if (opts.stubborn) process.on("SIGTERM", () => {});
  let buf = "";
  process.stdin.on("data", (d) => {
    buf += d;
    let i: number;
    while ((i = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, i);
      buf = buf.slice(i + 1);
      if (opts.spy) process.stderr.write(`RECV ${line}\n`);
      const m = JSON.parse(line) as { id: number; method: string };
      const reply = (result: unknown) => process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id: m.id, result })}\n`);
      if (m.method === "initialize") reply({ manifest: opts.manifest ?? behaveManifest });
      else if (m.method === "shutdown") {
        if (opts.stubborn) continue;
        reply({});
        process.exit(0);
      } else if (m.method === "execute") reply({ kind: "sent", providerRef: "raw" });
      // A newer plugin's error: a reason this host does not know, and a wait it should keep.
      else if (m.method === "query") process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id: m.id, error: { code: -32603, message: "quota", data: { reason: "quota_exhausted", waitMs: 700 } } })}\n`);
      else reply(null);
    }
  });
}
