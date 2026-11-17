// SPDX-License-Identifier: AGPL-3.0-only
// How the docs module reaches the docs tool: the provider the manifests name, the Workspace's
// connection to it, and one query whose failure comes back as a reason in a word.
import type { QueryInput, QueryOutput } from "@direx/plugin-sdk";
import { failureOf, type Query, type QueryId } from "../../plugins/index";

/** `connections` reach the tool (a typed key, an OAuth sign-in); `oauth` is the one a person connects by signing in. */
export type DocsProvider = {
  connections: readonly string[];
  oauth?: string | null;
  name: string;
  sources: QueryId<"docs.sources">;
  pageText: QueryId<"docs.page_text">;
  rows: QueryId<"docs.rows"> | null;
  write?: string | null;
};
type DocsQuery = "docs.sources" | "docs.page_text" | "docs.rows";
type StoredCredential = { id: string; connection: string | null };

/** Why a read was refused, in a word the screens turn into a sentence. */
export const DOCS_REASONS = ["not_connected", "needs_reconnecting", "no_access", "busy", "failed", "empty_page"] as const;
export type DocsReason = (typeof DOCS_REASONS)[number];

export type ReadDeps = {
  provider: () => DocsProvider | undefined;
  credentials: (workspaceId: string) => Promise<StoredCredential[]>;
  /** Whether this Workspace has an app to connect the OAuth connection with. Default: no. */
  canSignIn?: (workspaceId: string, connection: string) => Promise<boolean>;
  /** A plugin query through one credential, its answer checked by the host. */
  query: Query;
};
export type Connection = { provider: DocsProvider; credentialId: string };

/** A plugin's failure as a reason, from its typed fields (ADR 0028 rule 002). */
const reasonOf = (e: unknown, capability: string): DocsReason => {
  const f = failureOf(e, capability);
  if (f.code === "no_access") return "no_access";
  return f.reason === "rate_limited" ? "busy" : f.reason === "credential_rejected" || f.reason === "not_connected" ? "needs_reconnecting" : "failed";
};

export function reader(deps: ReadDeps) {
  async function connection(workspaceId: string): Promise<Connection | undefined> {
    const provider = deps.provider();
    const credential = provider && (await deps.credentials(workspaceId)).find((c) => c.connection !== null && provider.connections.includes(c.connection));
    return provider && credential ? { provider, credentialId: credential.id } : undefined;
  }
  async function ask<N extends DocsQuery>(workspaceId: string, c: Connection, capability: QueryId<N>, input: QueryInput<N>): Promise<{ ok: true; out: QueryOutput<N> } | { ok: false; reason: DocsReason }> {
    try {
      return { ok: true, out: await deps.query(workspaceId, capability, input, c.credentialId) };
    } catch (e) {
      return { ok: false, reason: reasonOf(e, capability) };
    }
  }
  return { connection, ask };
}
