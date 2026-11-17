// SPDX-License-Identifier: AGPL-3.0-only
// A brief agent's hand-over: checked against the page before it becomes a Brief, made once per run,
// and on approval kept in seo_briefs; a dismissal keeps nothing.
import { expect, test } from "vitest";
import { itemsWorld, person } from "../items/fixtures/items";
import { approvedBriefs } from "./adapters/briefs-repo";
import { briefSink, seoKinds } from "./index";
import { briefsHistory, type BriefInput } from "./application/briefs";
import type { Gap } from "./domain/brief";

const world = await itemsWorld({ kinds: seoKinds({ now: () => new Date("2026-11-07T10:00:00Z") }) });
const { W, items, who } = world;
const sink = briefSink({ items: () => items });

const input = (page = "https://example.com/guide"): BriefInput => ({
  text: "(the agent's text)",
  candidate: { selector: "near_page_one", page, query: "month end close", numbers: { impressions: 268, clicks: 0, position: 19.4 } },
  window: { startDate: "2026-10-07", endDate: "2026-11-03" },
  previous: { startDate: "2026-09-09", endDate: "2026-10-06" },
  page: { url: page, title: "Why the close matters", metaDescription: "Learn more today!", text: "Why the close matters\nOur team closes your books.", readAt: "2026-11-06T09:00:00.000Z" },
});
const gap = (over: Partial<Gap> = {}): Gap => ({ label: "title", problem: "No checklist in the title.", where: "Title", quote: "Why the close matters", fix: "Change it.", newText: ["Month end close checklist"], live: "The new title is in the source.", ...over });
const hand = (body: unknown, i: BriefInput = input(), runId: string = crypto.randomUUID()) =>
  sink(W, { kind: "draft", outputKey: "seo_brief", body }, { runId, input: i, tainted: true, pagesRead: [], pages: [], producer: {} as never });
const briefRows = () => approvedBriefs(W);

test("a Brief whose quotes are on the page becomes a Brief Item, once per run", async () => {
  const runId = crypto.randomUUID();
  const r = await hand({ schemaVersion: 1, gaps: [gap(), gap({ label: "meta", where: "Meta description", quote: "Learn more today!" })], cantTell: null, steered: [] }, input(), runId);
  expect(r).toMatchObject({ ok: true, itemId: expect.any(String) });
  const view = await items.detail(W, (r as { itemId: string }).itemId);
  expect(view!.item).toMatchObject({ kind: "brief", state: "needs_approval", title: '"month end close" on /guide' });
  expect(view!.content).toMatchObject({ runId, page: "https://example.com/guide", query: "month end close", selector: "near_page_one", why: expect.stringContaining("268 impressions"), pageText: expect.stringContaining("Our team closes") });
  expect((view!.content as { markdown: string }).markdown).toContain('| 1 | title: No checklist in the title. | Title: "Why the close matters" |');
  expect(await hand({ schemaVersion: 1, gaps: [gap()], cantTell: null, steered: [] }, input(), runId)).toEqual(r);
});

test("a made-up quote or a fix that writes too much is refused with why; no gaps makes nothing", async () => {
  expect(await hand({ schemaVersion: 1, gaps: [gap({ quote: "The best close software" })], cantTell: null, steered: [] })).toEqual({ ok: false, code: 'brief_refused: quote not on the page: "The best close software"' });
  expect(await hand({ schemaVersion: 1, gaps: [gap({ newText: [Array(61).fill("w").join(" ")] })], cantTell: null, steered: [] })).toEqual({ ok: false, code: "brief_refused: title: fix over 60 words" });
  expect(await hand({ schemaVersion: 1, gaps: [], cantTell: null, steered: [] })).toEqual({ ok: true, itemId: null });
});

test("approving keeps the Brief in seo_briefs; dismissing keeps nothing; nothing else happens", async () => {
  const before = (await briefRows()).length;
  const a = (await hand({ schemaVersion: 1, gaps: [gap()], cantTell: null, steered: [] }, input("https://example.com/a"))) as { itemId: string };
  const d = (await hand({ schemaVersion: 1, gaps: [gap()], cantTell: null, steered: [] }, input("https://example.com/d"))) as { itemId: string };
  const approved = await items.approve(W, a.itemId, (await items.view(W, a.itemId))!.revision, who);
  expect(approved).toMatchObject({ ok: true, item: { state: "applied" } });
  expect(await items.cancel(W, d.itemId, { userId: person.userId })).toMatchObject({ ok: true, item: { state: "cancelled" } });
  const rows = await briefRows();
  expect(rows).toHaveLength(before + 1);
  expect(rows.at(-1)).toMatchObject({
    itemId: a.itemId,
    pageUrl: "https://example.com/a",
    query: "month end close",
    selector: "near_page_one",
    numbers: { impressions: 268, position: 19.4, startDate: "2026-10-07", endDate: "2026-11-03" },
    pageText: "Why the close matters\nOur team closes your books.",
    pageReadAt: new Date("2026-11-06T09:00:00Z"),
    approvedAt: new Date("2026-11-07T10:00:00Z"),
  });
});

test("a step's Brief keeps its step on the Item and is kept with selector step", async () => {
  const step = { campaignId: crypto.randomUUID(), stepKey: "rank", campaign: "Autumn offer", step: "Rank the offer page" };
  const i: BriefInput = { ...input("https://example.com/offer"), step, candidate: { selector: "step", page: "https://example.com/offer", query: "month end close", numbers: {}, asked: { campaign: "Autumn offer", step: "Rank the offer page" } } };
  const r = (await hand({ schemaVersion: 1, gaps: [gap()], cantTell: null, steered: [] }, i)) as { itemId: string };
  expect((await items.detail(W, r.itemId))!.content).toMatchObject({ selector: "step", step, why: expect.stringContaining("No Search Console data") });
  expect(await items.approve(W, r.itemId, (await items.view(W, r.itemId))!.revision, who)).toMatchObject({ ok: true });
  expect((await briefRows()).at(-1)).toMatchObject({ itemId: r.itemId, selector: "step", pageUrl: "https://example.com/offer" });
});

test("the history lists Briefs newest first with their state, clicks before, and when to check after approval", async () => {
  const body = { schemaVersion: 1, gaps: [gap()], cantTell: null, steered: [] };
  const a = (await hand(body, input("https://example.com/h-applied"))) as { itemId: string };
  const s = { ...input("https://example.com/h-slipping"), candidate: { selector: "slipping" as const, page: "https://example.com/h-slipping", query: "month end close", numbers: { impressionsBefore: 900, impressionsNow: 300 } } };
  const w = (await hand(body, s)) as { itemId: string };
  expect(await items.approve(W, a.itemId, (await items.view(W, a.itemId))!.revision, who)).toMatchObject({ ok: true });
  const history = (await briefsHistory(W)).briefs;
  const of = (id: string) => history.find((h) => h.itemId === id);
  expect(of(a.itemId)).toEqual({
    itemId: a.itemId,
    page: "https://example.com/h-applied",
    query: "month end close",
    state: "applied",
    createdAt: expect.any(String),
    appliedAt: "2026-11-07T10:00:00.000Z",
    checkOn: "2026-12-08",
    before: { clicks: 0, startDate: "2026-10-07", endDate: "2026-11-03" },
    after: null,
  });
  // Picked on impressions alone, so there are no clicks to compare.
  expect(of(w.itemId)).toMatchObject({ state: "needs_approval", appliedAt: null, checkOn: null, before: null, after: null });
  expect(history.map((h) => h.createdAt)).toEqual(history.map((h) => h.createdAt).sort().reverse());

  // Read live: nothing before the check day, then the 28 days from approval, and null when Search Console can't be read.
  const asked: { startDate: string; endDate: string }[] = [];
  const live = (clicks: number[] | null, today: string) => ({
    clicksOver: async (_: string, range: { startDate: string; endDate: string }) => (asked.push(range), clicks),
    now: () => new Date(`${today}T12:00:00Z`),
  });
  const early = (await briefsHistory(W, live([7], "2026-12-07"))).briefs;
  expect(early.find((h) => h.itemId === a.itemId)?.after).toBeNull();
  expect(asked).toEqual([]);
  const checked = (await briefsHistory(W, live([7], "2026-12-08"))).briefs;
  expect(checked.find((h) => h.itemId === a.itemId)?.after).toBe(7);
  expect(asked).toContainEqual({ startDate: "2026-11-07", endDate: "2026-12-04" });
  expect(checked.find((h) => h.itemId === w.itemId)?.after).toBeNull();
  expect((await briefsHistory(W, live(null, "2026-12-08"))).briefs.find((h) => h.itemId === a.itemId)?.after).toBeNull();
});
