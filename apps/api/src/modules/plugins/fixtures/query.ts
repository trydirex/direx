// SPDX-License-Identifier: AGPL-3.0-only
// A plugin's query handlers called directly, as a module test's Query: the answer is parsed through
// the catalogue entry, as the host parses it. Tests only.
import type { Credential, Plugin } from "@direx/plugin-sdk";
import { queryEntry } from "@direx/plugin-sdk/host";
import type { Query } from "../index";

export function directQuery(plugin: Plugin, credential: (workspaceId: string) => Credential | null): Query {
  return async (workspaceId, capability, input) => {
    const name = capability.split("/")[1]!;
    const answer = await plugin.queries[name]!(input, { workspaceId, log: () => {}, credential: credential(workspaceId) });
    // Parsed by the entry the capability id names, as the host does.
    return queryEntry(name)!.output.parse(answer) as never;
  };
}
