// SPDX-License-Identifier: AGPL-3.0-only
// Brand's "read the website again", as a start a person can ask for in Ask (ADR 0008 rule 028). No
// column records the Workspace's website, so the address is the one its latest Brand read used.
// The model never names it.
import { z } from "zod";
import { brandReader } from "../definitions/brand-reader";
import { askStart, type AskStart } from "./ask-start";
import type { Agents } from "./create";

const RUN = "agent_run";

export function brandAskStarts(agents: () => Pick<Agents, "list" | "start" | "report">): AskStart[] {
  /** The address of the newest Brand read that read a website, and that run's id. */
  async function lastSite(workspaceId: string) {
    const runs = await agents().list(workspaceId, brandReader.id);
    for (const { run } of runs) {
      const input = run.input as { url?: unknown };
      if (typeof input.url === "string") return { url: input.url, runId: run.id };
    }
    return null;
  }
  return [
    askStart({
      id: "read_website",
      definition: brandReader.id,
      area: null,
      says: "Read the business's website again, the one Brand was last read from, and suggest what Brand should hold. Args: none.",
      args: z.strictObject({}),
      permission: "item.edit",
      async check(workspaceId) {
        const site = await lastSite(workspaceId);
        return site ? { ok: true, title: `Read ${site.url} again`, basis: `brand_read:${site.runId}` } : { ok: false, why: "no_website" };
      },
      async start(workspaceId, _a, by) {
        const site = await lastSite(workspaceId);
        if (!site) return { ok: false, why: "no_website" };
        const r = await agents().start(workspaceId, { agent: brandReader.id, input: { url: site.url }, key: by.key, tainted: by.tainted, startedBy: by.userId });
        return r.ok ? { ok: true, work: { kind: RUN, id: r.run.id } } : { ok: false, why: r.reason };
      },
      report: (workspaceId, work) => (work.kind === RUN ? agents().report(workspaceId, work.id) : Promise.resolve(null)),
    }),
  ];
}
