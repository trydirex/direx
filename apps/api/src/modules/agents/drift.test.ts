// SPDX-License-Identifier: AGPL-3.0-only
// The drift check against the database: runs and proposals seeded per agent version, counted per
// Workspace, and one notice per version and measure that rose past ADR 0008's line.
import { afterAll, expect, test } from "vitest";
import { appClient } from "../../../../../test/db";
import { seedMember } from "../identity/fixtures/member";
import type { Mail } from "../identity/index";
import * as repo from "./adapters/repo";
import { createDrift, driftNotice } from "./application/drift";

const db = await appClient();
afterAll(() => db.end());
async function q(ws: string, text: string, params: unknown[] = []) {
  await db.query("begin");
  await db.query("select set_config('app.workspace_id', $1, true)", [ws]);
  const r = await db.query(text, params);
  await db.query("commit");
  return r.rows;
}

const AGENT = "recipient_writer";
async function workspace() {
  const ws = crypto.randomUUID();
  const owner = crypto.randomUUID();
  await seedMember(ws, owner);
  return { ws, owner };
}

/** `runs` runs of one version on one route, each with one proposal; the first `refused` refused with `code`. */
async function seed(ws: string, v: { version: number; route: string | null; runs: number; refused?: number; code?: string; day: number }) {
  await q(
    ws,
    `with made as (
       insert into agent_runs (workspace_id, idempotency_key, agent, definition_version, prompt_revision, prompt_digest, tool_set_digest, trigger, status, deadline_ms, step_cap, cost_cap_micros, input, created_at, updated_at)
       select $1, gen_random_uuid()::text, $2, $3, 'r', 'd', 't', 'person', 'succeeded', 60000, 8, 1000, '{}', $4::timestamptz + g * interval '1 second', now()
       from generate_series(1, $5::int) g
       returning id, created_at
     )
     insert into agent_proposals (workspace_id, run_id, output_key, kind, rejection_code, route_hash, at)
     select $1, id, 'draft', 'fact_proposal', case when row_number() over (order by created_at) <= $6 then $7::text end, $8, now() from made`,
    [ws, AGENT, v.version, `2026-11-${String(v.day).padStart(2, "0")}T00:00:00Z`, v.runs, v.refused ?? 0, v.code ?? null, v.route],
  );
}

/** Approved Items with these edit distances, from proposals of one version that weren't refused. */
async function edits(ws: string, owner: string, version: number, distances: number[], decision = "edit_approve") {
  const picked = await q(
    ws,
    `select p.run_id from agent_proposals p join agent_runs r on r.workspace_id = p.workspace_id and r.id = p.run_id
     where r.definition_version = $1 and p.item_id is null and p.rejection_code is null limit $2`,
    [version, distances.length],
  );
  for (const [i, distance] of distances.entries()) {
    const item = crypto.randomUUID();
    await q(ws, `insert into items (id, workspace_id, kind, state, title, warnings, created_at, updated_at) values ($1, $2, 'notice', 'needs_approval', 'x', '[]', now(), now())`, [item, ws]);
    await q(ws, `update agent_proposals set item_id = $1 where run_id = $2`, [item, picked[i].run_id]);
    await q(ws, `insert into review_decisions (workspace_id, item_id, reviewer_id, kind, decision, opened_at, decided_at, edit_distance) values ($1, $2, $3, 'email', $4, now(), now(), $5)`, [ws, item, owner, decision, distance]);
  }
}

const outbox: Mail[] = [];
const drift = createDrift({ mailer: async (m) => void outbox.push(m), adminEmails: async (ws) => [`${ws}@admins.test`] });
const mailTo = (ws: string) => outbox.filter((m) => m.to === `${ws}@admins.test`);
const incidents = (ws: string) => q(ws, "select measure, agent, definition_version, route_hash, previous_definition_version, previous_route_hash, rate, previous_rate, runs, previous_runs from agent_drift_incidents order by measure");

test("each version is counted in its own Workspace: codes classified, routeless proposals left out, edit distance from approvals", async () => {
  const a = await workspace();
  const b = await workspace();
  const routeless = await workspace();
  await seed(a.ws, { version: 1, route: "r1", runs: 60, refused: 6, code: "too_long:140", day: 1 });
  await seed(a.ws, { version: 1, route: "r1", runs: 4, refused: 4, code: "target_changed", day: 1 });
  await seed(a.ws, { version: 1, route: "r1", runs: 2, refused: 2, code: "stale", day: 1 });
  await seed(a.ws, { version: 1, route: null, runs: 10, refused: 10, code: "too_long", day: 1 });
  await seed(a.ws, { version: 2, route: "r2", runs: 5, day: 3 });
  // A run with two proposals counts once.
  await q(a.ws, `insert into agent_proposals (workspace_id, run_id, output_key, kind, rejection_code, route_hash, at) select workspace_id, run_id, 'second', kind, 'Stale', route_hash, now() from agent_proposals where route_hash = 'r2' limit 1`);
  await edits(a.ws, a.owner, 1, [2, 10, 4]);
  await edits(a.ws, a.owner, 1, [99], "reject");
  await seed(b.ws, { version: 1, route: "r1", runs: 7, refused: 7, code: "stale", day: 1 });
  await seed(routeless.ws, { version: 1, route: null, runs: 3, day: 1 });

  const counts = (await repo.inWorkspace(a.ws, repo.versionCounts)).sort((x, y) => x.definitionVersion - y.definitionVersion);
  expect(counts).toEqual([
    { agent: AGENT, definitionVersion: 1, routeHash: "r1", firstRunAt: expect.any(Date), runs: 66, proposals: 66, qualityRejections: 8, citationRuns: 2, editMedian: 4, edited: 3 },
    { agent: AGENT, definitionVersion: 2, routeHash: "r2", firstRunAt: expect.any(Date), runs: 5, proposals: 6, qualityRejections: 1, citationRuns: 1, editMedian: null, edited: 0 },
  ]);
  expect(counts[0]!.firstRunAt.toISOString()).toBe("2026-11-01T00:00:01.000Z");
  expect(await repo.inWorkspace(b.ws, repo.versionCounts)).toMatchObject([{ runs: 7, proposals: 7, qualityRejections: 7, citationRuns: 7 }]);
  expect(await repo.inWorkspace(routeless.ws, repo.versionCounts)).toEqual([]);

  const listed = await repo.driftWorkspaces();
  expect(listed).toEqual(expect.arrayContaining([a.ws, b.ws]));
  expect(listed).not.toContain(routeless.ws);
});

test("an approval counts for the version that wrote the draft it measured, not every run that returned its Item", async () => {
  const { ws, owner } = await workspace();
  const item = crypto.randomUUID();
  await q(ws, `insert into items (id, workspace_id, kind, state, title, warnings, created_at, updated_at) values ($1, $2, 'notice', 'needs_approval', 'x', '[]', now(), now())`, [item, ws]);
  // Version 1 writes the draft, a later version 1 run finds it already there, and version 2 rewrites it.
  for (const [version, input, at] of [[1, {}, 1], [1, {}, 2], [2, { target: { redraft: item } }, 3]] as const) {
    await q(
      ws,
      `with made as (
         insert into agent_runs (workspace_id, idempotency_key, agent, definition_version, prompt_revision, prompt_digest, tool_set_digest, trigger, status, deadline_ms, step_cap, cost_cap_micros, input, created_at, updated_at)
         values ($1, gen_random_uuid()::text, $2, $3, 'r', 'd', 't', 'person', 'succeeded', 60000, 8, 1000, $4, $5, now()) returning id, created_at
       )
       insert into agent_proposals (workspace_id, run_id, output_key, kind, item_id, route_hash, at) select $1, id, 'draft', 'fact_proposal', $6, $7, created_at from made`,
      [ws, AGENT, version, JSON.stringify(input), `2026-11-0${at}T00:00:00Z`, item, `r${version}`],
    );
  }
  const decide = (distance: number, day: number) => q(ws, `insert into review_decisions (workspace_id, item_id, reviewer_id, kind, decision, opened_at, decided_at, edit_distance) values ($1, $2, $3, 'email', 'edit_approve', $4, $4, $5)`, [ws, item, owner, `2026-11-0${day}T12:00:00Z`, distance]);
  await decide(14, 3);
  const counts = async () => (await repo.inWorkspace(ws, repo.versionCounts)).sort((x, y) => x.definitionVersion - y.definitionVersion).map((c) => [c.definitionVersion, c.editMedian, c.edited]);
  expect(await counts()).toEqual([[1, null, 0], [2, 14, 1]]);
  // An approval made before the rewrite measured version 1's words.
  await decide(4, 2);
  expect(await counts()).toEqual([[1, 4, 1], [2, 14, 1]]);
});

test("a version whose rejection rate rose opens one incident and sends one notice, once; another Workspace waits for its own check", async () => {
  const a = await workspace();
  const b = await workspace();
  for (const { ws } of [a, b]) {
    await seed(ws, { version: 1, route: "r1", runs: 60, refused: 3, code: "too_long", day: 1 });
    await seed(ws, { version: 2, route: "r2", runs: 60, refused: 12, code: "unknown_merge_field:first_name", day: 2 });
  }

  await drift.checkDrift(a.ws);
  expect(mailTo(a.ws)).toEqual([
    {
      to: `${a.ws}@admins.test`,
      subject: "Test: The email drafter's drafts are refused more often since its last update",
      text: "Workspace: Test\n\nSince Direx changed how the email drafter works, 20% of its drafts broke a writing rule, up from 5% before (60 runs since, 60 before). See AI models in Workspace settings.",
    },
  ]);
  const opened = await incidents(a.ws);
  expect(opened).toEqual([{ measure: "rejections", agent: AGENT, definition_version: 2, route_hash: "r2", previous_definition_version: 1, previous_route_hash: "r1", rate: 0.2, previous_rate: 0.05, runs: 60, previous_runs: 60 }]);
  expect(await incidents(b.ws)).toEqual([]);

  // The daily sweep reaches the other Workspace and sends nothing new for the first.
  await drift.driftAll();
  await drift.checkDrift(a.ws);
  expect(mailTo(a.ws)).toHaveLength(1);
  expect(await incidents(a.ws)).toEqual(opened);
  expect(mailTo(b.ws)).toHaveLength(1);
  expect(await incidents(b.ws)).toHaveLength(1);
});

test("refusals that say the world moved don't count, and a version under 50 runs never fires", async () => {
  const { ws } = await workspace();
  await seed(ws, { version: 1, route: "r1", runs: 60, day: 1 });
  await seed(ws, { version: 2, route: "r2", runs: 60, refused: 40, code: "target_changed", day: 2 });
  await seed(ws, { version: 3, route: "r3", runs: 49, refused: 40, code: "too_long", day: 3 });
  await drift.checkDrift(ws);
  expect(mailTo(ws)).toEqual([]);
  expect(await incidents(ws)).toEqual([]);
});

test("citation failures fire on their own measure, and the notice says how much people edited when both versions were measured", async () => {
  const { ws, owner } = await workspace();
  await seed(ws, { version: 1, route: "r1", runs: 60, day: 1 });
  await seed(ws, { version: 2, route: "r2", runs: 60, refused: 9, code: "stale", day: 2 });
  await edits(ws, owner, 1, [4, 6, 5]);
  await edits(ws, owner, 2, [12, 14, 20]);
  await drift.checkDrift(ws);
  const sent = mailTo(ws).map((m) => m.text);
  expect(sent).toHaveLength(2);
  expect(sent).toContain(
    "Workspace: Test\n\nSince Direx changed how the email drafter works, 15% of its drafts broke a writing rule, up from 0% before (60 runs since, 60 before). People also edited the drafts they approved more: a median of 14 words changed, up from 5. See AI models in Workspace settings.",
  );
  expect(sent).toContain(
    "Workspace: Test\n\nSince Direx changed how the email drafter works, 15% of its runs cited something that didn't check out, up from 0% before (60 runs since, 60 before). People also edited the drafts they approved more: a median of 14 words changed, up from 5. See AI models in Workspace settings.",
  );
  expect(mailTo(ws).map((m) => m.subject)).toContain("Test: The email drafter cites things that don't check out more often since its last update");
  expect((await incidents(ws)).map((i) => i.measure)).toEqual(["citations", "rejections"]);
});

test("an agent without a name is named from its id, and fewer edits are said plainly", () => {
  const v = (definitionVersion: number, editMedian: number) => ({ agent: "new_agent", definitionVersion, routeHash: "r", firstRunAt: new Date(), runs: 50, proposals: 50, qualityRejections: 25, citationRuns: 0, editMedian, edited: 3 });
  expect(driftNotice("rejections", "new_agent", v(2, 1), v(1, 5))).toEqual({
    subject: "The new agent's drafts are refused more often since its last update",
    text: "Since Direx changed how the new agent works, 50% of its drafts broke a writing rule, up from 50% before (50 runs since, 50 before). People changed a median of 1 word in the drafts they approved, against 5 before. See AI models in Workspace settings.",
  });
});
