// SPDX-License-Identifier: MIT

// The catalogue's names, its agent queries and the finer error codes a query may carry. Most
// queries are called only by Direx code. An agent query is one a model may call during a run. For
// those, Direx writes what the model is told, what input it may give and what it sees of the
// answer, so no text a plugin wrote reaches the prompt. Changing any of that is a new version, and
// agent definitions name the version they use.
import type { ZodType } from "zod";
import { CATALOGUE } from "./catalogue/index";
import type { InputScope, QueryEntry } from "./catalogue/entry";

export { INPUT_SCOPES, type InputScope } from "./catalogue/entry";

export type AgentQuery<W = unknown, V = unknown> = {
  name: string;
  version: number;
  /** All the model is told about the query. */
  description: string;
  input: ZodType;
  scope: InputScope;
  /** What the plugin returns, parsed before anything else reads it. */
  output: ZodType<W>;
  /** What the model sees of a parsed answer. */
  view: (wire: W) => V;
};

const entries: readonly QueryEntry[] = Object.values(CATALOGUE);

export const AGENT_QUERIES: readonly AgentQuery[] = entries.flatMap((e) => (e.agent ? [{ name: e.name, version: e.version, output: e.output, ...e.agent } as AgentQuery] : []));

/**
 * The finer codes a query's PluginError may carry beside its reason, by query name. Core reads a
 * code only for a query listed here (ADR 0028 rule 002).
 */
export const QUERY_CODES: Readonly<Record<string, readonly string[]>> = {
  "docs.sources": ["no_access"],
  "docs.page_text": ["no_access"],
  "docs.rows": ["no_access"],
  "search.properties": ["no_access", "api_disabled"],
  "search.analytics": ["no_access", "api_disabled"],
};

/** Every query name a manifest may declare. */
export const QUERY_NAMES: ReadonlySet<string> = new Set(entries.map((e) => e.name));

/** The agent query a definition names as `name@version`, or undefined for anything else. */
export function agentQuery(ref: string): AgentQuery | undefined {
  return AGENT_QUERIES.find((q) => `${q.name}@${q.version}` === ref);
}
