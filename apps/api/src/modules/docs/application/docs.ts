// SPDX-License-Identifier: AGPL-3.0-only
// A docs tool's pages, read for brand facts: the pages a person shared with Direx, and one page's
// text handed to the brand reader as pasted text, so its proposals arrive as any other's do. Which
// docs tool it is comes from the manifests; core never names one (DX-R-0006-007).
import { createImports, type ImportDeps } from "./import";
import { reader, type ReadDeps } from "./read";

type Started = { ok: true; run: { id: string } } | { ok: false; reason: string };
export type DocsDeps = ReadDeps & ImportDeps & { startBrandReader: (workspaceId: string, a: { text: string; startedBy: string }) => Promise<Started> };


export function createDocs(deps: DocsDeps) {
  const { connection, ask } = reader(deps);
  return {
    /**
     * The connected docs tool's name, or null when there is none to connect; whether it is connected; and
     * the connection a person may connect it with by signing in, when this Workspace has an app for it.
     */
    async status(workspaceId: string) {
      const provider = deps.provider();
      const oauth = provider?.oauth;
      const signIn = oauth && (await deps.canSignIn?.(workspaceId, oauth)) ? oauth : null;
      return { provider: provider?.name ?? null, connected: Boolean(await connection(workspaceId)), imports: Boolean(provider?.rows), signIn };
    },

    async pages(workspaceId: string) {
      const c = await connection(workspaceId);
      if (!c) return { ok: false, reason: "not_connected" } as const;
      const r = await ask(workspaceId, c, c.provider.sources, {});
      return r.ok ? ({ ok: true, ...r.out } as const) : r;
    },

    /** Starts the brand reader on one page's title and text. `cut` says the page was longer than it reads. */
    async readForFacts(workspaceId: string, pageId: string, userId: string) {
      const c = await connection(workspaceId);
      if (!c) return { ok: false, reason: "not_connected" } as const;
      const page = await ask(workspaceId, c, c.provider.pageText, { pageId });
      if (!page.ok) return page;
      if (!page.out.text.trim()) return { ok: false, reason: "empty_page" } as const;
      const started = await deps.startBrandReader(workspaceId, { text: `${page.out.title}\n\n${page.out.text}`, startedBy: userId });
      return started.ok ? ({ ok: true, runId: started.run.id, title: page.out.title, cut: page.out.cut } as const) : ({ ok: false, reason: started.reason } as const);
    },

    ...createImports(deps),
  };
}
export type Docs = ReturnType<typeof createDocs>;
