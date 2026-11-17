// SPDX-License-Identifier: AGPL-3.0-only
// The review feed pilot report (spec S5, S6). For each member with a feed it compares how long
// their decisions took, in hours from the Action's approval request, in the 28 days before the
// feed was made and since. It also counts the Workspace's approvals that expired in each window,
// from the ledger's own record of the hold. Read-only.
//   bun scripts/review-feed-report.ts <workspaceId>
import { sql } from "drizzle-orm";
import { closeDb, withWorkspace } from "@direx/db";

const HOUR_MS = 3_600_000;
const WINDOW_MS = 28 * 24 * HOUR_MS;

export type Feed = { userId: string; email: string; createdAt: Date };
export type Decision = { reviewerId: string; requestedAt: Date; decidedAt: Date };
export type Window = { decisions: number; medianHours: number | null; expired: number };
export type Row = { email: string; createdAt: Date; before: Window; since: Window };

export function median(xs: number[]): number | null {
  if (xs.length === 0) return null;
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2;
}

/** The 28 days before the feed's creation and from it to now, each as [from, to). */
export function windows(createdAt: Date, now: Date) {
  return {
    before: { from: new Date(createdAt.getTime() - WINDOW_MS), to: createdAt },
    since: { from: createdAt, to: now },
  };
}

const inside = (at: Date, w: { from: Date; to: Date }) => at >= w.from && at < w.to;

/** Pure: one row per feed, from the Workspace's decisions and approval expiry times. */
export function summarize(feeds: Feed[], decisions: Decision[], expiries: Date[], now: Date): Row[] {
  return feeds.map((f) => {
    const mine = decisions.filter((d) => d.reviewerId === f.userId);
    const win = (w: { from: Date; to: Date }): Window => {
      const hours = mine.filter((d) => inside(d.decidedAt, w)).map((d) => (d.decidedAt.getTime() - d.requestedAt.getTime()) / HOUR_MS);
      return { decisions: hours.length, medianHours: median(hours), expired: expiries.filter((at) => inside(at, w)).length };
    };
    const w = windows(f.createdAt, now);
    return { email: f.email, createdAt: f.createdAt, before: win(w.before), since: win(w.since) };
  });
}

const hours = (h: number | null) => (h === null ? "none" : h.toFixed(1));

export function formatTable(rows: Row[]): string {
  const head = ["member", "feed made", "before: median h", "decisions", "expired", "since: median h", "decisions", "expired"];
  const body = rows.map((r) => [
    r.email,
    r.createdAt.toISOString().slice(0, 10),
    hours(r.before.medianHours),
    String(r.before.decisions),
    String(r.before.expired),
    hours(r.since.medianHours),
    String(r.since.decisions),
    String(r.since.expired),
  ]);
  const all = [head, ...body];
  const widths = head.map((_, i) => Math.max(...all.map((cells) => cells[i]!.length)));
  return all.map((cells) => cells.map((c, i) => c.padEnd(widths[i]!)).join("  ").trimEnd()).join("\n");
}

/** Reads the Workspace under its own row security and summarizes it. */
export async function report(workspaceId: string, now = new Date()): Promise<Row[]> {
  const toDate = (v: unknown) => new Date(v as string);
  return withWorkspace(workspaceId, async (tx) => {
    const feeds = (
      await tx.execute(sql`select f.user_id, u.email, f.created_at from review_feeds f join auth."user" u on u.id = f.user_id order by u.email`)
    ).rows.map((r) => ({ userId: String(r.user_id), email: String(r.email), createdAt: toDate(r.created_at) }));
    if (feeds.length === 0) return [];
    const earliest = new Date(Math.min(...feeds.map((f) => f.createdAt.getTime())) - WINDOW_MS).toISOString();
    // A decision made before the Action's current approval request belongs to an earlier draft, so it has no wait to measure.
    const decisions = (
      await tx.execute(sql`
        select d.reviewer_id, a.approval_requested_at, d.decided_at
        from review_decisions d
        join items i on i.workspace_id = d.workspace_id and i.id = d.item_id
        join actions a on a.workspace_id = i.workspace_id and a.id = i.action_id
        where d.reviewer_id in (select user_id from review_feeds)
          and a.approval_requested_at is not null and d.decided_at >= a.approval_requested_at
          and d.decided_at >= ${earliest}::timestamptz`)
    ).rows.map((r) => ({ reviewerId: String(r.reviewer_id), requestedAt: toDate(r.approval_requested_at), decidedAt: toDate(r.decided_at) }));
    // The hold's event, not actions.hold_reason: a re-requested Action loses its hold reason, the event stays.
    const expiries = (
      await tx.execute(sql`select at from action_events where to_state = 'held' and reason = 'approval_expired' and at >= ${earliest}::timestamptz`)
    ).rows.map((r) => toDate(r.at));
    return summarize(feeds, decisions, expiries, now);
  });
}

if (import.meta.main) {
  const workspaceId = process.argv[2];
  if (!workspaceId) {
    console.error("usage: bun scripts/review-feed-report.ts <workspaceId>");
    process.exit(2);
  }
  try {
    const rows = await report(workspaceId);
    console.log(rows.length === 0 ? "No member of this Workspace has a review feed." : formatTable(rows));
  } finally {
    await closeDb();
  }
}
