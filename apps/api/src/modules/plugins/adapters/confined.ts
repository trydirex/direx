// SPDX-License-Identifier: AGPL-3.0-only
// Starts a plugin in the sandbox (ADR 0026 rules 006 and 007): its one bundled file, its manifest's
// egress hosts as its only network, and every refused connection logged under the plugin's id.
import type { Manifest } from "@direx/plugin-sdk";
import { spawnSandboxed } from "../../models";
import type { PluginProcess } from "./process";

export function confinedSpawn(log: (line: string) => void) {
  return async (plugin: { manifest: Manifest; entry: string }, onStderr: (line: string) => void): Promise<PluginProcess> => {
    const r = await spawnSandboxed({
      file: plugin.entry,
      egressHosts: plugin.manifest.egress.hosts,
      onStderr,
      onRefused: (target, why) => log(`plugin ${plugin.manifest.id} tried to reach ${target}, refused: ${why}`),
    });
    if (!r.ok) throw new Error(r.reason);
    return r.process;
  };
}
