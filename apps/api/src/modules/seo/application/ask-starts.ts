// SPDX-License-Identifier: AGPL-3.0-only
// The SEO page's "write a brief", as a start a person can ask for in Ask (ADR 0008 rule 028). Its
// check reads only this server: whether a brief for that page and search already waits. Whether the
// pair is still a candidate comes from Search Console and the page from the web, so the button's own
// writeOne checks those when the start runs, and a refusal there is the start's recorded outcome.
import { z } from "zod";
import { askStart, type AskStart, type WorkReport } from "../../agents/index";
import { briefWaiting, workspaceName } from "../adapters/briefs-repo";
import { pageBrief } from "../definitions/page-brief";
import type { Briefs } from "./briefs";
import type { Seo } from "./search-console";

const RUN = "agent_run";

export function seoAskStarts(d: { briefs: () => Pick<Briefs, "writeOne">; report: (workspaceId: string, runId: string) => Promise<WorkReport | null> }): AskStart[] {
  return [
    askStart({
      id: "write_brief",
      definition: pageBrief.id,
      area: "seo",
      says: "Write a search brief for one tracked page and the search it shows up for. Args: page (its full address) and query, both from read_seo_pages.",
      args: z.strictObject({ page: z.url({ protocol: /^https?$/ }).max(2048), query: z.string().trim().min(1).max(200) }),
      permission: "item.edit",
      async check(workspaceId, a) {
        if (await briefWaiting(workspaceId, pageBrief.id, a.page, a.query)) return { ok: false, why: "brief_waiting" };
        return { ok: true, title: `Write a brief for ${a.page} on "${a.query}"`, basis: "brief" };
      },
      async start(workspaceId, a, by) {
        const r = await d.briefs().writeOne(workspaceId, { page: a.page, query: a.query, userId: by.userId }, { key: by.key, tainted: by.tainted });
        return r.ok ? { ok: true, work: { kind: RUN, id: r.run.id } } : { ok: false, why: r.reason };
      },
      report: (workspaceId, work) => (work.kind === RUN ? d.report(workspaceId, work.id) : Promise.resolve(null)),
    }),
  ];
}

/** The pages and searches worth a brief now, the SEO page's own lists, for Ask to name one by. */
export function pagesWorthABrief(seo: () => Pick<Seo, "candidates">) {
  return async (workspaceId: string): Promise<{ ok: true; pairs: { page: string; query: string }[] } | { ok: false; reason: string }> => {
    const name = await workspaceName(workspaceId);
    if (name === null) return { ok: false, reason: "no_workspace" };
    const c = await seo().candidates(workspaceId, name);
    if (!c.ok) return { ok: false, reason: c.reason };
    const pairs = [...c.nearPageOne.top, ...c.slipping.top, ...c.competing.top.flatMap((x) => x.pages.map((p) => ({ page: p.page, query: x.query })))].map((x) => ({ page: x.page, query: x.query }));
    return { ok: true, pairs: [...new Map(pairs.map((x) => [`${x.page}\n${x.query}`, x])).values()] };
  };
}
