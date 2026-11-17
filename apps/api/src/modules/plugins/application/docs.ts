// SPDX-License-Identifier: AGPL-3.0-only
// What makes a plugin a docs provider: the pages a person shared with it, and one page's text, on
// one connection. Core finds it from this, never from a plugin's name (DX-R-0006-007).
import type { Manifest } from "@direx/plugin-sdk";
import { PROVIDER_KINDS } from "@direx/plugin-sdk/host";

export const DOCS_SOURCES = "docs.sources";
export const DOCS_PAGE_TEXT = "docs.page_text";
export const DOCS_ROWS = "docs.rows";
/** The one docs effect: an imported row's status written back under a recorded yes (ADR 0025). */
export const DOCS_ROW_UPDATE = "docs.row.update";

/** Whether the manifest has this capability on this connection, as its own or one it also runs on. */
export const hasOn = (m: Manifest, connection: string, name: string, kind = "query") =>
  m.capabilities.some((c) => c.kind === kind && c.name === name && (c.connection === connection || ("alsoConnections" in c && c.alsoConnections?.includes(connection))));

/** The manifest's connections that answer both docs queries. */
export function docsConnections(m: Manifest): string[] {
  return m.connections.map((c) => c.key).filter((key) => PROVIDER_KINDS.docs.every(([kind, name]) => hasOn(m, key, name, kind)));
}
