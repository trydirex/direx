// SPDX-License-Identifier: AGPL-3.0-only
// What makes a plugin a search data provider: the properties an account can see, and search
// analytics for one of them, on one connection. Core finds it from this, never from a plugin's name.
import type { Manifest } from "@direx/plugin-sdk";
import { PROVIDER_KINDS } from "@direx/plugin-sdk/host";

export const SEARCH_PROPERTIES = "search.properties";
export const SEARCH_ANALYTICS = "search.analytics";

/** The manifest's connections that answer both search queries. */
export function searchConnections(m: Manifest): string[] {
  const has = (connection: string, kind: string, name: string) => m.capabilities.some((c) => c.kind === kind && c.connection === connection && c.name === name);
  return m.connections.map((c) => c.key).filter((key) => PROVIDER_KINDS.search.every(([kind, name]) => has(key, kind, name)));
}
