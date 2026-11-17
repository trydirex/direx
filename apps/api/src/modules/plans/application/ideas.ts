// SPDX-License-Identifier: AGPL-3.0-only
// Ideas: sentences saved to start a Campaign from later. Not Items, so nothing here touches the queue.
// Starting one is the browser's two calls, POST /plans then `started`, so a failed second call leaves
// a Campaign and an open Idea, and nothing is lost.
import { inWorkspace } from "../adapters/repo";
import { dismissIdea, hasPlan, insertIdea, listIdeas, startIdea, type IdeaRow } from "../adapters/ideas";

/** How many open Ideas the list shows, and started ones from the last 14 days. */
export const OPEN_IDEAS = 50;
export const STARTED_IDEAS = 10;
const STARTED_DAYS = 14;

const view = (r: IdeaRow) => ({ id: r.id, text: r.text, createdBy: r.createdBy, createdAt: r.createdAt.toISOString() });

export function ideaStore({ now }: { now: () => Date }) {
  return {
    async ideas(workspaceId: string) {
      const since = new Date(now().getTime() - STARTED_DAYS * 86_400_000);
      const r = await inWorkspace(workspaceId, (tx) => listIdeas(tx, { open: OPEN_IDEAS, started: STARTED_IDEAS, startedSince: since }));
      return {
        open: r.open.map(view),
        started: r.started.map(({ idea, planTitle }) => ({ ...view(idea), planId: idea.planId!, planTitle, startedAt: idea.startedAt!.toISOString() })),
      };
    },

    async addIdea(workspaceId: string, a: { text: string; userId: string }) {
      return view(await inWorkspace(workspaceId, (tx) => insertIdea(tx, { workspaceId, text: a.text.trim(), createdBy: a.userId, now: now() })));
    },

    async dismissIdea(workspaceId: string, id: string) {
      return (await inWorkspace(workspaceId, (tx) => dismissIdea(tx, id, now()))) ? ({ ok: true } as const) : ({ ok: false, reason: "not_found" } as const);
    },

    async startIdea(workspaceId: string, id: string, planId: string) {
      const r = await inWorkspace(workspaceId, async (tx) => {
        if (!(await hasPlan(tx, planId))) return "not_found" as const;
        return (await startIdea(tx, id, planId, now())) ? null : ("not_open" as const);
      });
      return r ? ({ ok: false, reason: r } as const) : ({ ok: true } as const);
    },
  };
}
