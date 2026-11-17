// SPDX-License-Identifier: AGPL-3.0-only
// Newsletter work on the worker side: every connected list read nightly and one list as soon as it is
// connected, so its subscribers stay out of cold email; the weekly draft; and the check after an issue
// is sent. Each queue, schedule and consumer goes through `later` (ADR 0027 rule 001).
import type { PgBoss } from "pg-boss";
import type { newsletterSync, Outreach } from "../modules/outreach/index";
import type { newsletterLists, Plugins } from "../modules/plugins/index";
import type { Later } from "./sweeps";

export const NEWSLETTER_SYNC_SWEEP = "outreach.newsletter_sync_sweep";
export const NEWSLETTER_SYNC_ONE = "outreach.newsletter_sync_one";
export const NEWSLETTER_WEEKLY = "newsletter.weekly";
export const NEWSLETTER_AFTER_SEND = "newsletter.after_send";

export type ListKey = { workspaceId: string; credentialId: string; connection: string };

export function newsletterJobs(d: {
  boss: Pick<PgBoss, "createQueue" | "schedule" | "work">;
  later: Later;
  lists: ReturnType<typeof newsletterLists>;
  connected: (connections: string[]) => Promise<ListKey[]>;
  query: Plugins["query"];
  syncOne: ReturnType<typeof newsletterSync>;
  outreach: () => Pick<Outreach, "askAgainForSubscribers">;
  weekly: { run: () => Promise<unknown> };
  afterSend: { run: () => Promise<unknown> };
}) {
  const { boss, later, lists } = d;
  // One list at a time, so a slow tool delays only the lists after it.
  const readList = async (m: ListKey) => {
    const list = lists.find((l) => l.connection === m.connection);
    if (!list) return;
    // An account with several lists has every one read, not only the one the issue goes to: anyone on
    // any of them stays out of cold email.
    let ids: (string | undefined)[] = [undefined];
    if (list.lists) {
      try {
        ids = (await d.query(m.workspaceId, list.lists, {}, m.credentialId)).map((l) => l.id);
      } catch (e) {
        console.error(`worker: couldn't read the lists behind newsletter key ${m.credentialId}: ${e instanceof Error ? e.message : String(e)}`);
        return;
      }
    }
    for (const id of ids) {
      const r = await d.syncOne(m.workspaceId, m.credentialId, list.subscribers, id);
      if (r.kind !== "done") console.error(`worker: newsletter list ${m.credentialId}${id ? ` (${id})` : ""} stopped after ${r.addresses} addresses: ${r.kind}${r.detail ? `, ${r.detail}` : ""}`);
    }
    // Whoever just turned up on the list, any cold email already approved for them asks again.
    await d.outreach().askAgainForSubscribers(m.workspaceId);
  };
  later(() => boss.createQueue(NEWSLETTER_SYNC_SWEEP));
  later(() => boss.schedule(NEWSLETTER_SYNC_SWEEP, "0 5 * * *"));
  later(() =>
    boss.work(NEWSLETTER_SYNC_SWEEP, async () => {
      for (const m of await d.connected(lists.map((l) => l.connection))) await readList(m);
    }),
  );
  later(() => boss.createQueue(NEWSLETTER_SYNC_ONE));
  later(() =>
    boss.work<ListKey>(NEWSLETTER_SYNC_ONE, async ([job]) => {
      if (job) await readList(job.data);
    }),
  );
  // Hourly, because each Workspace's draft is due at 06:00 in its own time zone. A pass that finds nothing due changes nothing.
  later(() => boss.createQueue(NEWSLETTER_WEEKLY));
  later(() => boss.schedule(NEWSLETTER_WEEKLY, "0 * * * *"));
  later(() => boss.work(NEWSLETTER_WEEKLY, async () => d.weekly.run()));
  // Every ten minutes, so the 30 minute delivered check lands within its window.
  later(() => boss.createQueue(NEWSLETTER_AFTER_SEND));
  later(() => boss.schedule(NEWSLETTER_AFTER_SEND, "*/10 * * * *"));
  later(() => boss.work(NEWSLETTER_AFTER_SEND, async () => d.afterSend.run()));
}
