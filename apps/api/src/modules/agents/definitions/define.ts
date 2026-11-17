// SPDX-License-Identifier: AGPL-3.0-only
// What an agent is, as code. A Workspace can't edit any of this. Every tool here only reads, so
// a definition has no way to name one with an effect. Plugin reads come only as agent queries
// from the plugin SDK's catalogue, named with their version, never by plugin.
import { agentQuery } from "@direx/plugin-sdk/host";
import type { ZodType } from "zod";

/** `fetch_page` reads a website; the rest read the run's own Workspace, through readers handed in at startup. */
export const READ_TOOLS = ["fetch_page", "read_needs_you", "read_schedule", "read_campaign", "read_plans", "read_companies", "read_seo_pages", "read_media"] as const;
export type ReadTool = (typeof READ_TOOLS)[number];
/** An agent query from the catalogue, such as `mail.from@1`. */
export type AgentQueryRef = `${string}@${number}`;

export type ProposalKind = "fact_proposal" | "strategy_proposal" | "plan_proposal" | "draft" | "schedule_entry" | "rule_proposal" | "action_proposal" | "ask_reply";
export type Proposal = { kind: ProposalKind; outputKey: string; body: unknown };

export type AgentDefinition<O = unknown> = {
  id: string;
  version: number;
  promptRevision: string;
  prompt: string;
  purposes: readonly string[];
  tools: readonly (ReadTool | AgentQueryRef)[];
  deadlineMs: number;
  stepCap: number;
  /** The most pages one run may read. Left out, only the step cap limits it. */
  maxPages?: number;
  /**
   * The run can't finish until it has read: given an address, until it has tried a page, since the page
   * is the whole job; otherwise, until one Workspace read has come back.
   */
  mustRead?: boolean;
  /** Direx code reads the given site's home and about pages before the model starts, so the model never picks an address. */
  prefetch?: "home_and_about";
  output: ZodType<O>;
  context: readonly string[];
  proposals: (output: O) => Proposal[];
};

export function defineAgent<O>(d: AgentDefinition<O>): AgentDefinition<O> {
  if (d.deadlineMs <= 0 || d.stepCap <= 0) throw new Error(`${d.id}: a definition needs a deadline and a step cap`);
  const known = (t: string) => (READ_TOOLS as readonly string[]).includes(t) || agentQuery(t) !== undefined;
  if (!d.tools.every(known)) throw new Error(`${d.id}: a definition may only use read tools and agent queries from the catalogue`);
  if (d.prefetch && d.tools.length) throw new Error(`${d.id}: a definition that prefetches pages may have no tools`);
  return d;
}
