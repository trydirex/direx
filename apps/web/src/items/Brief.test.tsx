// SPDX-License-Identifier: AGPL-3.0-only
import { afterEach, expect, test, vi } from "vitest";
import { cleanup, render, screen, within } from "@testing-library/react";
import { api } from "../client";
import { withQueries } from "../testing";
import type { Item } from "./actions";
import { BRIEF_LIMIT } from "./actions";
import { brief, CampaignsCard, ComingUp, MorningBrief, nextStep, sinceDay } from "./Brief";

const W = "00000000-0000-4000-8000-0000000000aa";
const NOW = new Date(2026, 10, 9, 8, 30);
const at = (day: number, hour = 10) => new Date(2026, 10, day, hour).toISOString();
const i = (state: Item["state"], when: string | null) => ({ state, at: when });

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

test("the brief counts yesterday's sends and today's sent, scheduled and held, by the browser's days", () => {
  const items = [i("sent", at(8)), i("sent", at(8, 23)), i("sent", at(7, 23)), i("sent", at(9, 7)), i("scheduled", at(9, 15)), i("scheduled", at(10, 0)), i("held", at(9)), i("needs_approval", at(9)), i("scheduled", null)];
  expect(brief(items, NOW)).toEqual({ sentYesterday: 2, sentToday: 1, scheduledToday: 1, heldToday: 1, capped: false });
  expect(brief(Array.from({ length: BRIEF_LIMIT }, () => i("sent", at(8))), NOW).capped).toBe(true);
});

test("replies count from yesterday, or from Friday on a Monday so the weekend shows", () => {
  expect(sinceDay(new Date(2026, 10, 10, 9))).toEqual({ from: new Date(2026, 10, 9), words: "since yesterday" });
  expect(sinceDay(NOW)).toEqual({ from: new Date(2026, 10, 6), words: "since Friday" });
});

function serve(items: unknown[], replies = { replies: 0, optedOut: 0 }) {
  return vi.spyOn(api, "GET").mockImplementation(((path: string) =>
    Promise.resolve({ data: path === "/api/w/{workspaceId}/outreach/reply-count" ? replies : { items, needsYouCount: 0 }, response: new Response(null, { status: 200 }) })) as never);
}

test("Home's brief says what goes out and is held today and the replies since Friday on a Monday, each a link", async () => {
  const get = serve([i("sent", at(8)), i("sent", at(8)), i("sent", at(9, 7)), i("scheduled", at(9, 15)), i("held", at(9, 11))], { replies: 5, optedOut: 1 });
  render(withQueries(<MorningBrief workspaceId={W} now={NOW} />));
  const card = within(await screen.findByRole("region", { name: "Today" }));
  expect(card.getByRole("link", { name: "2 going out today" }).getAttribute("href")).toBe(`/w/${W}/calendar?view=day`);
  expect(card.getByRole("link", { name: "1 held" }).getAttribute("href")).toBe(`/w/${W}/calendar?view=day`);
  expect(card.getByRole("link", { name: "See the week" }).getAttribute("href")).toBe(`/w/${W}/calendar`);
  expect((await card.findByRole("link", { name: "5 replies since Friday" })).getAttribute("href")).toBe(`/w/${W}/people`);
  expect(card.getByRole("link", { name: "1 asked to stop" })).toBeTruthy();
  expect(get).toHaveBeenCalledWith("/api/w/{workspaceId}/outreach/reply-count", { params: { path: { workspaceId: W }, query: { from: new Date(2026, 10, 6).toISOString(), to: new Date(2026, 10, 9, 8, 30).toISOString() } } });
  expect(get).toHaveBeenCalledWith("/api/w/{workspaceId}/items", { params: { path: { workspaceId: W }, query: { from: new Date(2026, 10, 8).toISOString(), to: new Date(2026, 10, 10).toISOString(), limit: BRIEF_LIMIT } } });
});

test("a quiet day says so plainly", async () => {
  serve([]);
  render(withQueries(<MorningBrief workspaceId={W} now={NOW} />));
  const card = within(await screen.findByRole("region", { name: "Today" }));
  expect(card.getByText("Nothing planned today.")).toBeTruthy();
  expect(card.queryByText(/held/)).toBeNull();
  // Replies show even at zero.
  expect(await card.findByText("0 replies since Friday")).toBeTruthy();
});

test("a day the plan fills with nothing drafted says so, not that nothing is planned", async () => {
  const step = (on: string, stepKey: string) => ({ campaignId: "c1", campaign: "Launch", stepKey, title: "First email", on });
  answer({
    "/api/w/{workspaceId}/items": { items: [], needsYouCount: 0 },
    "/api/w/{workspaceId}/outreach/reply-count": { replies: 0, optedOut: 0 },
    "/api/w/{workspaceId}/campaign-steps": { steps: [step("2026-11-09", "a"), step("2026-11-09", "b"), step("2026-11-10", "c")] },
  });
  render(withQueries(<MorningBrief workspaceId={W} now={NOW} />));
  const card = within(await screen.findByRole("region", { name: "Today" }));
  expect((await card.findByRole("link", { name: "2 steps planned today, nothing drafted yet" })).getAttribute("href")).toBe(`/w/${W}/calendar?view=day`);
  expect(card.queryByText("Nothing planned today.")).toBeNull();
});

/** Answers each path from `data`; anything else is refused. */
function answer(data: Record<string, unknown>) {
  return vi.spyOn(api, "GET").mockImplementation(((path: string) =>
    Promise.resolve(path in data ? { data: data[path], response: new Response(null, { status: 200 }) } : { error: { error: "not_found" }, response: new Response(null, { status: 404 }) })) as never);
}
test("a week's number shows with the reason behind it only when Direx can name one", async () => {
  answer({
    "/api/w/{workspaceId}/items": { items: [], needsYouCount: 0 },
    "/api/w/{workspaceId}/outreach/reply-count": { replies: 5, optedOut: 0 },
    "/api/w/{workspaceId}/outreach/results": {
      results: [
        { key: "replies", label: "Replies to outreach, last 7 days", now: 5, before: 2, why: "Most replies answered the Café intro email." },
        { key: "opt_outs", label: "Asked to stop, last 7 days", now: 1, before: 0, why: null },
      ],
    },
  });
  render(withQueries(<MorningBrief workspaceId={W} now={NOW} />));
  const why = within(await screen.findByRole("list", { name: "Why" }));
  expect(why.getByRole("listitem").textContent).toBe("Replies to outreach, last 7 days: 5, against 2 the week before. Most replies answered the Café intro email.");
  expect(why.queryByText(/Asked to stop/)).toBeNull();
});

const campaign = (o: Record<string, unknown>) => ({ id: crypto.randomUUID(), planId: "p", title: "Spring", ownerUserId: "u", draftingMode: null, paused: false, status: "running", changesWaiting: false, goal: null, startsOn: null, endsOn: null, planned: 0, done: 0, sent: 0, replied: 0, needApproval: 0, measure: null, channels: [], ...o });

test("How your campaigns are doing shows running and starting Campaigns with their measure or steps, and Search clicks", async () => {
  answer({
    "/api/w/{workspaceId}/campaigns": { campaigns: [campaign({ title: "Spring", measure: { label: "Signups", target: "200", value: "142" }, sent: 40, replied: 3 }), campaign({ title: "Webinar", status: "scheduled", startsOn: "2026-11-16", planned: 4, done: 1 }), campaign({ title: "Baseline", measure: { label: "Engagement", target: "Record the baseline first", value: null }, planned: 2 }), campaign({ title: "Old", status: "ended" })] },
    "/api/w/{workspaceId}/seo/search-console": { connected: true, siteUrl: "https://acme.test/", properties: null, refusal: null },
    "/api/w/{workspaceId}/seo/search-console/summary": { clicks: 120, impressions: 900, startDate: "2026-10-10", endDate: "2026-11-06", previous: { clicks: 100, impressions: 800, startDate: "2026-09-12", endDate: "2026-10-09" } },
  });
  render(withQueries(<CampaignsCard workspaceId={W} />));
  const card = within(await screen.findByRole("region", { name: "How your campaigns are doing" }));
  expect((await card.findByRole("link", { name: "Spring" })).getAttribute("href")).toMatch(new RegExp(`^/w/${W}/campaigns/`));
  expect(card.getByText("40 sent · 3 replied")).toBeTruthy();
  expect(card.getByText("142 / 200 Signups (71%)")).toBeTruthy();
  expect(card.getByText("Starts Mon 16 Nov · 1 of 4 steps done")).toBeTruthy();
  // A target written as a sentence has no bar; the card shows the steps instead.
  expect(card.getByText("0 of 2 steps done")).toBeTruthy();
  expect(card.queryByText(/Record the baseline/)).toBeNull();
  expect(card.queryByText("Old")).toBeNull();
  expect(await card.findByText("Search: 120 clicks, +20% vs previous 28 days")).toBeTruthy();
  expect(card.getByRole("link", { name: "See campaigns" }).getAttribute("href")).toBe(`/w/${W}/campaigns`);
});

test("each campaign says its one next thing: drafts waiting first, then this week's steps with nothing drafted", async () => {
  expect(nextStep({ needApproval: 3 }, 2)).toEqual({ text: "3 waiting for your approval", to: "review" });
  expect(nextStep({ needApproval: 0 }, 1)).toEqual({ text: "1 step this week with nothing drafted", to: "campaign" });
  expect(nextStep({ needApproval: 0 }, 0)).toBeNull();
  const spring = campaign({ title: "Spring", needApproval: 2 });
  const webinar = campaign({ title: "Webinar" });
  answer({
    "/api/w/{workspaceId}/campaigns": { campaigns: [spring, webinar, campaign({ title: "Quiet" })] },
    "/api/w/{workspaceId}/campaign-steps": { steps: [{ campaignId: webinar.id, campaign: "Webinar", stepKey: "s1", title: "Invite", on: "2026-11-10" }, { campaignId: webinar.id, campaign: "Webinar", stepKey: "s2", title: "Reminder", on: "2026-11-12" }] },
  });
  render(withQueries(<CampaignsCard workspaceId={W} now={NOW} />));
  const card = within(await screen.findByRole("region", { name: "How your campaigns are doing" }));
  expect((await card.findByRole("link", { name: "Next: 2 waiting for your approval" })).getAttribute("href")).toBe(`/w/${W}/review`);
  expect((await card.findByRole("link", { name: "Next: 2 steps this week with nothing drafted" })).getAttribute("href")).toBe(`/w/${W}/campaigns/${webinar.id}`);
  expect(card.getAllByRole("link", { name: /^Next:/ })).toHaveLength(2);
});

test("with no campaign running, the card says how it fills", async () => {
  answer({ "/api/w/{workspaceId}/campaigns": { campaigns: [campaign({ status: "draft" })] } });
  render(withQueries(<CampaignsCard workspaceId={W} />));
  expect(await screen.findByText("No campaign is running. Start one and its results show here.")).toBeTruthy();
  expect(screen.getByRole("link", { name: "Open Campaigns" }).getAttribute("href")).toBe(`/w/${W}/campaigns`);
});

test("This week lists scheduled, held and waiting work and launches by day, and says when there is none", async () => {
  const item = (o: Partial<Item>) => ({ id: crypto.randomUUID(), kind: "action", state: "scheduled", reason: null, reasonCode: null, revision: 1, title: "A post", workArea: "social", channel: "x", groupKey: null, groupLabel: null, at: at(9, 15), warnings: [], clean: true, movable: true, decideBy: null, snoozedUntil: null, createdAt: at(8), ...o });
  answer({
    "/api/w/{workspaceId}/items": { items: [item({ title: "Launch post" }), item({ title: "To Kim", state: "held", at: at(11) }), item({ title: "Waiting", state: "needs_approval" })], nextCursor: null, needsYouCount: 0 },
    "/api/w/{workspaceId}/campaign-launches": { launches: [{ campaignId: "c1", title: "Webinar", on: "2026-11-10" }] },
  });
  render(withQueries(<ComingUp workspaceId={W} now={NOW} />));
  const card = within(await screen.findByRole("region", { name: "This week" }));
  expect(await card.findByRole("heading", { name: "Today" })).toBeTruthy();
  expect(card.getByText(/^Launch post, /)).toBeTruthy();
  expect(card.getByRole("heading", { name: "Tomorrow" })).toBeTruthy();
  expect(card.getByText("Webinar starts")).toBeTruthy();
  expect(card.getByText("Held")).toBeTruthy();
  expect(card.getByText(/^Waiting, /)).toBeTruthy();
  expect(card.getByRole("link", { name: "Open the Calendar" }).getAttribute("href")).toBe(`/w/${W}/calendar`);
  cleanup();
  answer({ "/api/w/{workspaceId}/items": { items: [], nextCursor: null, needsYouCount: 0 }, "/api/w/{workspaceId}/campaign-launches": { launches: [] } });
  render(withQueries(<ComingUp workspaceId={W} now={NOW} />));
  expect(await screen.findByText("Nothing scheduled this week.")).toBeTruthy();
});

test("a step the plan puts in the week with nothing drafted shows as an empty slot on its day", async () => {
  const get = answer({
    "/api/w/{workspaceId}/items": { items: [], nextCursor: null, needsYouCount: 0 },
    "/api/w/{workspaceId}/campaign-launches": { launches: [] },
    "/api/w/{workspaceId}/campaign-steps": { steps: [{ campaignId: "c1", campaign: "Spring", stepKey: "s2", title: "Reminder email", on: "2026-11-11" }] },
  });
  render(withQueries(<ComingUp workspaceId={W} now={NOW} />));
  const card = within(await screen.findByRole("region", { name: "This week" }));
  expect(await card.findByText("Spring: Reminder email")).toBeTruthy();
  expect(card.getByText("Planned, nothing drafted yet")).toBeTruthy();
  expect(card.queryByText("Nothing scheduled this week.")).toBeNull();
  expect(get).toHaveBeenCalledWith("/api/w/{workspaceId}/campaign-steps", { params: { path: { workspaceId: W }, query: { from: "2026-11-09", to: "2026-11-15" } } });
});
