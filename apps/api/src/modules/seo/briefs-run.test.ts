// SPDX-License-Identifier: AGPL-3.0-only
// A week's Brief run over the real seo module and its fake Search Console: which pages it reads,
// what it hands the brief agent, what it notes, and that it runs once a week.
import { expect, test } from "vitest";
import { createBriefs, seoAskStarts, stepBriefState, weekOf, type StartBrief } from "./index";
import { briefsHistory } from "./application/briefs";
import type { PageRead } from "./application/read-page";
import { seoWorld } from "./fixtures/world";
import { appClient } from "../../../../../test/db";

const w = seoWorld();
const near = (query: string, page: string, impressions: number) => ({ keys: [query, `https://example.com${page}`], clicks: 1, impressions, ctr: 0.01, position: 12 });
const read = (url: string): PageRead => ({ ok: true, url, finalUrl: url, title: `Title of ${url}`, metaDescription: "A description.", html: "<html></html>", text: `Text of ${url}`, truncated: false, readAt: new Date("2026-11-06T09:00:00Z") });

function world(opts: { failRead?: string[]; refuseStart?: string; throwOn?: string } = {}) {
  const started: Parameters<StartBrief>[1][] = [];
  const workspaces: string[] = [];
  const briefs = createBriefs({
    seo: () => w.seo,
    readPage: async (url) => {
      if (opts.throwOn && url.endsWith(opts.throwOn)) throw new Error("socket hang up");
      return opts.failRead?.some((p) => url.endsWith(p)) ? { ok: false, reason: "robots_disallowed" } : read(url);
    },
    start: () => async (_ws, a) => {
      if (opts.refuseStart) return { ok: false, reason: opts.refuseStart };
      started.push(a);
      return { ok: true, run: { id: crypto.randomUUID() } };
    },
    workspaces: async () => workspaces,
    now: () => w.clock.at,
  });
  return { briefs, started, workspaces };
}

async function connected() {
  const { W, userId } = await w.workspace();
  await w.connect(W, userId);
  expect(await w.seo.choose(W, "sc-domain:example.com")).toMatchObject({ ok: true });
  return { W, userId };
}

test("the week is keyed by its Monday in UTC", () => {
  expect(weekOf(new Date("2026-11-06T12:00:00Z"))).toBe("2026-11-02");
  expect(weekOf(new Date("2026-11-02T00:00:00Z"))).toBe("2026-11-02");
  expect(weekOf(new Date("2026-11-08T23:59:00Z"))).toBe("2026-11-02");
});

test("a person's run reads pages in order, skips one it may not read, and starts 3 briefs as that person", async () => {
  const { W, userId } = await connected();
  w.clock.at = new Date("2026-11-06T12:00:00Z");
  w.sc.rows.splice(0, w.sc.rows.length, near("a", "/a", 90), near("b", "/b", 80), near("c", "/c", 70), near("d", "/d", 60), near("e", "/e", 50));
  const { briefs, started } = world({ failRead: ["/b"] });
  const r = await briefs.run(W, { userId });
  expect(r).toMatchObject({ ok: true, note: { week: "2026-11-02", by: "person", stopped: null, skipped: [{ page: "https://example.com/b", reason: "robots_disallowed" }] } });
  expect(r.ok && r.note.started.map((s) => s.page)).toEqual(["https://example.com/a", "https://example.com/c", "https://example.com/d"]);
  expect(started).toHaveLength(3);
  expect(started[0]).toMatchObject({ agent: "page_brief", startedBy: userId, input: { candidate: { selector: "near_page_one", query: "a" }, window: { startDate: "2026-10-07", endDate: "2026-11-03" }, page: { title: "Title of https://example.com/a" } } });
  expect(started[0]!.input.text).toContain("Search: a\nPage: https://example.com/a\nWhy this page and search: Search Console, 2026-10-07 to 2026-11-03: position 12.0, 90 impressions, 1 clicks");
  expect(started[0]!.input.text).toContain("Text:\nText of https://example.com/a");
  expect(await briefs.latest(W)).toMatchObject({ ranThisWeek: true, note: { started: [{ page: "https://example.com/a" }, {}, {}] } });
});

test("a second run in the same week is refused, and the next week runs again", async () => {
  const { W, userId } = await connected();
  w.clock.at = new Date("2026-11-06T12:00:00Z");
  w.sc.rows.splice(0, w.sc.rows.length, near("a", "/a", 90));
  const { briefs, started } = world();
  expect(await briefs.run(W, { userId })).toMatchObject({ ok: true });
  expect(await briefs.run(W, "schedule")).toEqual({ ok: false, reason: "already_ran" });
  w.clock.at = new Date("2026-11-09T06:00:00Z");
  expect(await briefs.latest(W)).toMatchObject({ ranThisWeek: false });
  expect(await briefs.run(W, "schedule")).toMatchObject({ ok: true, note: { week: "2026-11-09", by: "schedule" } });
  expect(started.at(-1)).toMatchObject({ schedule: true });
  expect(started.at(-1)).not.toHaveProperty("startedBy");
});

test("a refused start stops the run and says why; Search Console refusals pass through", async () => {
  const { W, userId } = await connected();
  w.clock.at = new Date("2026-11-06T12:00:00Z");
  w.sc.rows.splice(0, w.sc.rows.length, near("a", "/a", 90), near("b", "/b", 80));
  expect(await world({ refuseStart: "no_route" }).briefs.run(W, { userId })).toMatchObject({ ok: true, note: { started: [], stopped: "no_route" } });

  const { W: other, userId: u2 } = await w.workspace();
  expect(await world().briefs.run(other, { userId: u2 })).toEqual({ ok: false, reason: "not_connected" });
});

test("the weekly job runs each Workspace with Search Console, and one failing doesn't stop the rest", async () => {
  const one = await connected();
  const two = await connected();
  w.clock.at = new Date("2026-11-16T06:00:00Z");
  w.sc.rows.splice(0, w.sc.rows.length, near("a", "/a", 90));
  const { briefs, started, workspaces } = world();
  workspaces.push(crypto.randomUUID(), one.W, two.W);
  await briefs.weekly();
  expect(started).toHaveLength(2);
  expect((await briefs.latest(two.W)).ranThisWeek).toBe(true);
});

test("one page going wrong is noted and passed over, and what started is kept", async () => {
  const { W, userId } = await connected();
  w.clock.at = new Date("2026-11-06T12:00:00Z");
  w.sc.rows.splice(0, w.sc.rows.length, near("a", "/a", 90), near("b", "/b", 80), near("c", "/c", 70), near("d", "/d", 60));
  const { briefs, started } = world({ throwOn: "/b" });
  const r = await briefs.run(W, { userId });
  expect(r.ok && r.note.started.map((s) => s.page)).toEqual(["https://example.com/a", "https://example.com/c", "https://example.com/d"]);
  expect(r.ok && r.note.skipped).toEqual([{ page: "https://example.com/b", reason: "failed" }]);
  expect(started).toHaveLength(3);
  expect((await briefs.latest(W)).note).toMatchObject({ started: [{}, {}, {}], skipped: [{ reason: "failed" }] });
});

test("a run that started nothing holds the week only while it may still be going", async () => {
  const { W, userId } = await connected();
  w.clock.at = new Date("2026-11-06T12:00:00Z");
  w.sc.rows.splice(0, w.sc.rows.length, near("a", "/a", 90));
  const { briefs } = world({ failRead: ["/a"] });
  expect(await briefs.run(W, { userId })).toMatchObject({ ok: true, note: { started: [] } });
  expect(await briefs.run(W, { userId })).toEqual({ ok: false, reason: "already_ran" });
  w.clock.at = new Date("2026-11-06T12:11:00Z");
  expect((await briefs.latest(W)).ranThisWeek).toBe(false);
  expect(await briefs.run(W, { userId })).toMatchObject({ ok: true });
});

const step = { campaignId: crypto.randomUUID(), stepKey: "rank", campaign: "Autumn offer", step: "Rank the offer page" };

test("a step's Brief reads its one page, carries the Search Console numbers, and leaves the week alone", async () => {
  const { W, userId } = await connected();
  w.clock.at = new Date("2026-11-06T12:00:00Z");
  w.sc.rows.splice(0, w.sc.rows.length, near("acme pricing", "/offer", 400), near("a", "/a", 90));
  const { briefs, started } = world();
  const r = await briefs.startForStep(W, { page: "https://example.com/offer", query: " Acme Pricing ", step, userId });
  expect(r).toMatchObject({ ok: true, run: { id: expect.any(String) } });
  expect(started).toEqual([expect.objectContaining({ agent: "page_brief", startedBy: userId, input: expect.objectContaining({ step, candidate: { selector: "step", page: "https://example.com/offer", query: "Acme Pricing", numbers: { impressions: 400, clicks: 1, position: 12 }, asked: { campaign: "Autumn offer", step: "Rank the offer page" } } }) })]);
  expect(started[0]!.input.text).toContain('Why this page and search: Asked for by step "Rank the offer page" of Campaign "Autumn offer". Search Console, 2026-10-07 to 2026-11-03: position 12.0, 400 impressions');
  expect(await briefs.latest(W)).toMatchObject({ ranThisWeek: false });
});

test("a step's Brief without Search Console says so, and an unreadable page starts nothing", async () => {
  const { W, userId } = await w.workspace();
  const { briefs, started } = world({ failRead: ["/private"] });
  expect(await briefs.startForStep(W, { page: "https://example.com/new", query: "acme pricing", step, userId })).toMatchObject({ ok: true });
  expect(started[0]!.input.candidate.numbers).toEqual({});
  expect(started[0]!.input.text).toContain("No Search Console data for this page and search yet.");
  expect(await briefs.startForStep(W, { page: "https://example.com/private", query: "acme pricing", step, userId })).toEqual({ ok: false, reason: "robots_disallowed" });
  expect(started).toHaveLength(1);
});

test("a step's Brief state comes from its Item once there is one, else from the run", () => {
  const run = (status: string, rejections: string[] = [], statusReason: string | null = null) => ({ status, statusReason, rejections });
  const item = (state: string) => ({ id: "i1", state });
  expect(stepBriefState(run("running"), null)).toEqual({ state: "running" });
  expect(stepBriefState(run("queued"), null)).toEqual({ state: "running" });
  expect(stepBriefState(run("succeeded"), null)).toEqual({ state: "no_brief", reason: "no_gaps" });
  expect(stepBriefState(run("succeeded", ["brief_refused: quote not on the page"]), null)).toEqual({ state: "no_brief", reason: "brief_refused: quote not on the page" });
  expect(stepBriefState(run("refused", [], "no_route"), null)).toEqual({ state: "failed", reason: "no_route" });
  expect(stepBriefState(run("timed_out"), null)).toEqual({ state: "failed", reason: "timed_out" });
  expect(stepBriefState(null, null)).toEqual({ state: "failed", reason: "run_missing" });
  expect(stepBriefState(run("succeeded"), item("needs_approval"))).toEqual({ state: "waiting", itemId: "i1" });
  expect(stepBriefState(run("succeeded"), item("applied"))).toEqual({ state: "approved", itemId: "i1" });
  expect(stepBriefState(run("succeeded"), item("cancelled"))).toEqual({ state: "dismissed", itemId: "i1" });
});

test("writing one Brief: a waiting one for the same page and search, an unreadable page or no Search Console starts nothing", async () => {
  const { W, userId } = await connected();
  w.clock.at = new Date("2026-11-06T12:00:00Z");
  w.sc.rows.splice(0, w.sc.rows.length, near("a", "/a", 90), near("b", "/b", 80), { ...near("shared", "/c", 50), position: 3 }, { ...near("shared", "/d", 30), position: 40 }, near("e", "/e", 70));
  const { briefs, started } = world({ failRead: ["/b"] });
  const db = await appClient();
  await db.query("select set_config('app.workspace_id', $1, false)", [W]);
  await db.query(`insert into items (workspace_id, kind, state, title, warnings, payload, created_at, updated_at) values ($1, 'brief', 'needs_approval', 't', '[]', $2, now(), now())`, [W, { page: "https://example.com/a", query: "a" }]);
  await db.end();
  expect(await briefs.writeOne(W, { page: "https://example.com/a", query: "a", userId })).toEqual({ ok: false, reason: "brief_waiting" });
  expect(await briefs.writeOne(W, { page: "https://example.com/b", query: "b", userId })).toEqual({ ok: false, reason: "robots_disallowed" });
  expect(started).toHaveLength(0);
  // A competing search's Brief is for its top page, and names the others.
  expect(await briefs.writeOne(W, { page: "https://example.com/c", query: "shared", userId })).toMatchObject({ ok: true });
  expect(started[0]).toMatchObject({ startedBy: userId, input: { candidate: { selector: "competing", page: "https://example.com/c", others: ["https://example.com/d"] } } });
  expect(await briefs.writeOne(W, { page: "https://example.com/d", query: "shared", userId })).toEqual({ ok: false, reason: "not_a_candidate" });
  expect(await briefs.latest(W)).toMatchObject({ ranThisWeek: false });

  // Ask's start checks only what waits here; the candidate and the page are the button's own call's to refuse.
  const [ask] = seoAskStarts({ briefs: () => briefs, report: async (_w, runId) => ({ state: "running", itemIds: [runId] }) });
  expect(ask).toMatchObject({ id: "write_brief", definition: "page_brief", area: "seo", permission: "item.edit" });
  expect(await ask!.check(W, { page: "https://example.com/a", query: "a" })).toEqual({ ok: false, why: "brief_waiting" });
  expect(await ask!.check(W, { page: "https://example.com/b", query: "b" })).toMatchObject({ ok: true, title: 'Write a brief for https://example.com/b on "b"' });
  expect(await ask!.start(W, { page: "https://example.com/b", query: "b" }, { userId, key: "item-1", tainted: false })).toEqual({ ok: false, why: "robots_disallowed" });
  expect(await ask!.start(W, { page: "https://example.com/d", query: "shared" }, { userId, key: "item-2", tainted: false })).toEqual({ ok: false, why: "not_a_candidate" });
  const made = await ask!.start(W, { page: "https://example.com/e", query: "e" }, { userId, key: "item-3", tainted: true });
  expect(made).toMatchObject({ ok: true, work: { kind: "agent_run" } });
  expect(started.at(-1)).toMatchObject({ startedBy: userId, key: "item-3", tainted: true });
  expect(ask!.args.safeParse({ page: "not a page", query: "e" }).success).toBe(false);
  expect(await ask!.report(W, { kind: "clip_run", id: "x" })).toBeNull();

  const { W: other, userId: u2 } = await w.workspace();
  expect(await briefs.writeOne(other, { page: "https://example.com/c", query: "shared", userId: u2 })).toEqual({ ok: false, reason: "not_connected" });
  expect(await briefs.writeOne(crypto.randomUUID(), { page: "https://example.com/c", query: "shared", userId: u2 })).toEqual({ ok: false, reason: "no_workspace" });
});

test("writing one Brief is refused while a run for the same page and search is still going, and the history lists it as being written", async () => {
  const { W, userId } = await connected();
  w.clock.at = new Date("2026-11-06T12:00:00Z");
  w.sc.rows.splice(0, w.sc.rows.length, near("a", "/a", 90), near("b", "/b", 80));
  const { briefs, started } = world();
  const db = await appClient();
  await db.query("select set_config('app.workspace_id', $1, false)", [W]);
  const run = (status: string, page: string) =>
    db.query(
      `insert into agent_runs (workspace_id, idempotency_key, agent, definition_version, prompt_revision, prompt_digest, tool_set_digest, trigger, status, status_reason, deadline_ms, step_cap, cost_cap_micros, input, created_at, updated_at)
       values ($1, $2, 'page_brief', 1, 'r', 'd', 't', 'person', $3, $4, 60000, 10, 1000000, $5, now(), now())`,
      [W, crypto.randomUUID(), status, status === "failed" ? "boom" : null, { candidate: { page, query: page.endsWith("/a") ? "a" : "b" } }],
    );
  await run("running", "https://example.com/a");
  await run("failed", "https://example.com/b");
  await db.end();
  expect(await briefs.writeOne(W, { page: "https://example.com/a", query: "a", userId })).toEqual({ ok: false, reason: "brief_waiting" });
  // A run that ended without a Brief doesn't hold the row.
  expect(await briefs.writeOne(W, { page: "https://example.com/b", query: "b", userId })).toMatchObject({ ok: true });
  expect(started).toHaveLength(1);
  expect((await briefsHistory(W)).writing).toEqual([{ page: "https://example.com/a", query: "a" }]);
});
