// SPDX-License-Identifier: AGPL-3.0-only
// Reads one connected newsletter list, page by page, and records every address on it. Nothing is
// ever removed: anyone once on the list stays out of cold email. A refused key or a slow tool stops
// this list only, and what was read so far is kept.
import { failureOf, type QueryId, type QueryOf } from "../../plugins/index";
import { inWorkspace, upsertSubscribers, type SubscriberState } from "../adapters/repo";

export const SYNC_DEFAULTS = {
  /** How long one list may take, waits included, before the rest waits for the next run. */
  ceilingMs: 30 * 60_000,
  /** Used when a tool says to slow down without saying for how long. */
  waitMs: 60_000,
};

export type SyncDeps = {
  /** A plugin query, as the plugin host runs it, its answer checked there. */
  query: QueryOf<"newsletter.subscribers">;
  store: (workspaceId: string, credentialId: string, rows: { email: string; state: SubscriberState }[], at: Date) => Promise<void>;
  now: () => Date;
  sleep: (ms: number) => Promise<void>;
  ceilingMs?: number;
};

export type SyncResult = { kind: "done" | "key_refused" | "too_slow" | "failed"; pages: number; addresses: number; detail?: string };


/** `syncList` storing into the Workspace's newsletter_subscribers, with real time and waits. */
export const newsletterSync =
  (o: { query: SyncDeps["query"]; now?: () => Date; sleep?: (ms: number) => Promise<void> }) =>
  (workspaceId: string, credentialId: string, capability: QueryId<"newsletter.subscribers">, listId?: string): Promise<SyncResult> =>
    syncList(
      {
        query: o.query,
        store: (ws, cred, rows, at) => inWorkspace(ws, (tx) => upsertSubscribers(tx, ws, cred, rows, at)),
        now: o.now ?? (() => new Date()),
        sleep: o.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms))),
      },
      workspaceId,
      credentialId,
      capability,
      listId,
    );

/** `listId` names one list in an account that holds several; each list is read on its own. */
export async function syncList(deps: SyncDeps, workspaceId: string, credentialId: string, capability: QueryId<"newsletter.subscribers">, listId?: string): Promise<SyncResult> {
  const ceiling = deps.ceilingMs ?? SYNC_DEFAULTS.ceilingMs;
  const start = deps.now().getTime();
  let cursor: string | null = null;
  let pages = 0;
  let addresses = 0;
  for (;;) {
    if (deps.now().getTime() - start > ceiling) return { kind: "too_slow", pages, addresses };
    let page;
    try {
      page = await deps.query(workspaceId, capability, { ...(cursor ? { cursor } : {}), ...(listId ? { listId } : {}) }, credentialId);
    } catch (e) {
      // detail is for the log line only; the decision reads the typed fields (ADR 0028 rule 002).
      const detail = e instanceof Error ? e.message : String(e);
      const f = failureOf(e, capability);
      if (f.reason === "credential_rejected") return { kind: "key_refused", pages, addresses, detail };
      if (f.reason === "rate_limited") {
        const wait = f.waitMs ?? SYNC_DEFAULTS.waitMs;
        if (deps.now().getTime() - start + wait > ceiling) return { kind: "too_slow", pages, addresses, detail };
        await deps.sleep(wait);
        continue;
      }
      return { kind: "failed", pages, addresses, detail };
    }
    await deps.store(workspaceId, credentialId, page.subscribers.map(({ email, state }) => ({ email, state })), deps.now());
    pages++;
    addresses += page.subscribers.length;
    if (!page.nextCursor) return { kind: "done", pages, addresses };
    cursor = page.nextCursor;
  }
}
