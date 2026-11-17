// SPDX-License-Identifier: AGPL-3.0-only
import { afterAll, beforeAll, expect, test } from "vitest";
import { withWorkspace } from "@direx/db";
import { organizations, workspaceMembers, workspaces } from "@direx/db/schema";
import { appClient, insertAuthUser } from "../test/db";
import { formatTable, median, report, summarize, windows } from "./review-feed-report";

const H = 3_600_000;
const D = 24 * H;
const T = Date.parse("2026-10-01T00:00:00Z");
const at = (ms: number) => new Date(T + ms);
const NOW = at(10 * D);

test("median of odd, even and empty lists", () => {
  expect(median([9, 2, 4])).toBe(4);
  expect(median([3, 1])).toBe(2);
  expect(median([])).toBeNull();
});

test("windows are the 28 days before the feed and from it to now", () => {
  const w = windows(at(0), NOW);
  expect(w.before.from).toEqual(at(-28 * D));
  expect(w.before.to).toEqual(at(0));
  expect(w.since).toEqual({ from: at(0), to: NOW });
});

test("a window with no decisions prints none, not 0", () => {
  const rows = summarize([{ userId: "u", email: "u@example.com", createdAt: at(0) }], [{ reviewerId: "u", requestedAt: at(D), decidedAt: at(D + 90 * 60_000) }], [], NOW);
  expect(rows[0]!.before).toEqual({ decisions: 0, medianHours: null, expired: 0 });
  const line = formatTable(rows).split("\n")[1]!.split(/\s{2,}/);
  expect(line).toEqual(["u@example.com", "2026-10-01", "none", "0", "0", "1.5", "1", "0"]);
});

let c: Awaited<ReturnType<typeof appClient>>;
const W = crypto.randomUUID();
const OTHER = crypto.randomUUID();
const [A, B, C] = [crypto.randomUUID(), crypto.randomUUID(), crypto.randomUUID()];
const hash = () => Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("hex");

async function workspaceWith(w: string, users: string[]) {
  const orgId = crypto.randomUUID();
  await withWorkspace(w, async (tx) => {
    await tx.insert(organizations).values({ id: orgId, name: "Org", createdAt: at(-60 * D) });
    await tx.insert(workspaces).values({ id: w, orgId, name: "W", createdAt: at(-60 * D) });
    for (const u of users) await tx.insert(workspaceMembers).values({ workspaceId: w, userId: u, role: "marketer", createdAt: at(-60 * D) });
  });
}

const asWorkspace = (w: string) => c.query("select set_config('app.workspace_id', $1, false)", [w]);

async function action(w: string, state: string, requestedAt: Date | null): Promise<string> {
  const { rows } = await c.query(
    `insert into actions (workspace_id, idempotency_key, capability, dedupe_class, state, hold_reason, spec, spec_hash, approval_requested_at, created_at, updated_at)
     values ($1, gen_random_uuid(), 'x/email.send', 'queryable', $2, $3, '{}', 'h', $4, now(), now()) returning id`,
    [w, state, state === "held" ? "approval_expired" : null, requestedAt],
  );
  return rows[0].id as string;
}

/** One Action, its Item and one decision on it, waiting `waitH` hours from the request. */
async function decision(reviewer: string, decidedAt: Date, waitH: number) {
  const actionId = await action(W, "sent", new Date(decidedAt.getTime() - waitH * H));
  const { rows } = await c.query(
    `insert into items (workspace_id, kind, action_id, described_draft_version, title, warnings, created_at, updated_at)
     values ($1, 'action', $2, 1, 't', '[]', now(), now()) returning id`,
    [W, actionId],
  );
  await c.query(
    `insert into review_decisions (workspace_id, item_id, reviewer_id, kind, decision, opened_at, decided_at) values ($1, $2, $3, 'email', 'approve', $4, $4)`,
    [W, rows[0].id, reviewer, decidedAt],
  );
}

async function held(w: string, eventAt: Date, reason = "approval_expired") {
  const actionId = await action(w, "held", eventAt);
  await c.query(
    `insert into action_events (workspace_id, action_id, from_state, to_state, reason, version, actor_system, at) values ($1, $2, 'needs_approval', 'held', $3, 2, 'dispatcher', $4)`,
    [w, actionId, reason, eventAt],
  );
}

beforeAll(async () => {
  for (const u of [A, B, C]) await insertAuthUser(u);
  await workspaceWith(W, [A, B, C]);
  await workspaceWith(OTHER, []);
  c = await appClient();
  await asWorkspace(W);
  const feed = (u: string, createdAt: Date) =>
    c.query(`insert into review_feeds (workspace_id, user_id, token_hash, weekdays, start_minute, length_minutes, time_zone, created_at) values ($1, $2, $3, '{2,4}', 600, 30, 'UTC', $4)`, [W, u, hash(), createdAt]);
  await feed(A, at(0));
  await feed(B, at(3 * D));

  // A: before the feed 2, 4 and 9 hours (median 4); one 30 days back is outside the window.
  await decision(A, at(-10 * D), 2);
  await decision(A, at(-5 * D), 4);
  await decision(A, at(-H), 9);
  await decision(A, at(-30 * D), 50);
  // A since: 1 and 3 hours (median 2).
  await decision(A, at(D), 1);
  await decision(A, at(2 * D), 3);
  // Decided before the Action's current request: an earlier draft, not counted.
  await decision(A, at(4 * D), -24);
  // B since its feed (day 3): one decision of 5 hours; nothing before.
  await decision(B, at(4 * D), 5);
  // C has no feed, so C is not reported and C's decisions count for nobody.
  await decision(C, at(D), 7);

  for (const d of [-40, -5, -1, 2, 5]) await held(W, at(d * D));
  await held(W, at(D), "outcome_unknown");
  await asWorkspace(OTHER);
  await held(OTHER, at(D));
  await asWorkspace(W);
});
afterAll(() => c.end());

test("a seeded Workspace gives exact medians and counts per member", async () => {
  const rows = await report(W, NOW);
  const by = (u: string) => rows.find((r) => r.email === `${u}@example.com`);
  expect(rows).toHaveLength(2);
  expect(by(A)).toEqual({
    email: `${A}@example.com`,
    createdAt: at(0),
    before: { decisions: 3, medianHours: 4, expired: 2 },
    since: { decisions: 2, medianHours: 2, expired: 2 },
  });
  expect(by(B)).toEqual({
    email: `${B}@example.com`,
    createdAt: at(3 * D),
    before: { decisions: 0, medianHours: null, expired: 3 },
    since: { decisions: 1, medianHours: 5, expired: 1 },
  });
  expect(formatTable(rows)).toContain("none");
  expect(await report(OTHER, NOW)).toEqual([]);
});
