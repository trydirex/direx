// SPDX-License-Identifier: AGPL-3.0-only
// First-party plugins run in this process, through the same invoke the stdio worker
// uses. Params and results go through JSON, as they would over the pipe, so a plugin
// behaves the same when it moves out of process.
import { PluginError, type Plugin } from "@direx/plugin-sdk";
import { invoke, readErrorData, RPC_ERRORS, RpcError } from "@direx/plugin-sdk/host";
import type { Call } from "./effects";
import { CallFailed, wireParams } from "./host";

const viaJson = (v: unknown): unknown => (v === undefined ? null : JSON.parse(JSON.stringify(v)));

export function inProcessCall(plugin: Plugin, log: (line: string) => void): Call {
  const id = plugin.manifest.id;
  return async (workspaceId, method, params) => {
    let result: unknown;
    try {
      result = await invoke(plugin, method, viaJson(wireParams(params)), { workspaceId, log: (m) => log(`plugin ${id}: ${m}`) });
    } catch (e) {
      // The same fields the stdio worker sends as error data, read the same tolerant way.
      const data = e instanceof PluginError ? e : { reason: e instanceof RpcError && e.code === RPC_ERRORS.invalidParams ? "invalid_params" : "failed" };
      throw new CallFailed(`plugin error: ${e instanceof Error ? e.message : String(e)}`, readErrorData(data));
    }
    return viaJson(result);
  };
}
