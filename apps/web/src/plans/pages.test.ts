// SPDX-License-Identifier: AGPL-3.0-only
// Smoke test for the plan screens: each role sees what it may do, in glossary terms, and each action
// calls its endpoint.
import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { createMemoryHistory, createRootRoute, createRouter, RouterContextProvider } from "@tanstack/react-router";
import { expect, test, vi } from "vitest";
import { api } from "../client";
import { buttons, withQueries, withoutButtons } from "../testing";
import type { Role } from "../items/actions";
import { addReading, createPlan, dismissOffer, draftOutcome, getOffer, takeOffer, markStep, missingWords, savePlan, saveStrategy, say, sayDraft, startPlanDraft, startStrategyDraft, submitPlan, submitStrategy, type Plan as Loaded, type PlanBody, type Strategy as LoadedStrategy, type StrategyBody, type Tracking } from "./actions";
import { KeptDraft } from "./Fields";
import { NewCampaign } from "./NewCampaign";
import { Plan } from "./Plan";
import { Strategy } from "./Strategy";

const W = "00000000-0000-4000-8000-0000000000aa";
const ID = "00000000-0000-4000-8000-0000000000bb";
const body: PlanBody = {
  schemaVersion: 1,
  goal: "4 meetings",
  audience: "Shopify ops leads",
  startsOn: "2026-11-01",
  endsOn: "2026-11-30",
  steps: [{ key: "first", on: "2026-11-03", title: "First email" }],
  measures: [{ key: "meetings", label: "Meetings", target: "4", basis: { kind: "assumption" } }],
  budget: [{ label: "Mailbox", amountCents: null, currency: "USD", billedBy: "your_account" }],
  assumptions: [{ text: "Which opening line works" }],
};
const tracking: Tracking = {
  planned: 1,
  done: 0,
  skipped: 0,
  steps: [{ ...body.steps[0]!, status: "open" }],
  measures: [{ ...body.measures[0]!, latest: { value: "2", observedOn: "2026-11-10", source: "person" } }],
};
const waiting = { id: ID, revision: 1, version: 2, warnings: ["Read this before approving"] };
const plan = (o: Partial<Loaded> = {}): Loaded =>
  ({ id: ID, title: "Q4", request: "Book 4 meetings", currentVersion: 1, archived: false, current: body, draft: body, draftRevision: 1, strategyVersion: 1, missing: [], waiting: null, tracking, notes: [], ...o }) as Loaded;
const strategyBody: StrategyBody = {
  schemaVersion: 1,
  whoFor: "Heads of ecommerce ops",
  personas: [],
  positioning: "The audit that finds the error",
  channels: [{ key: "email", label: "Cold email", timing: "now", reason: "Ops leads read email", basis: { kind: "assumption" } }],
  assumptions: [],
};
const strategy = (o: Partial<LoadedStrategy> = {}): LoadedStrategy => ({ id: ID, currentVersion: 1, current: strategyBody, draft: strategyBody, draftRevision: 1, missing: [], waiting: null, ...o }) as LoadedStrategy;
// Screens link with the router and load through the query layer, so each render gets both.
const router = createRouter({ routeTree: createRootRoute(), history: createMemoryHistory() });
const html = (el: Parameters<typeof renderToString>[0]) =>
  renderToString(withQueries(createElement(RouterContextProvider, { router, children: el })))
    .replaceAll("<!-- -->", "")
    .replaceAll("&#x27;", "'");
const planPage = (role: Role, o: Partial<Loaded> = {}) => html(createElement(Plan, { workspaceId: W, id: ID, role, initial: { plan: plan(o), facts: [] } }));
const strategyPage = (role: Role, o: Partial<LoadedStrategy> = {}) => html(createElement(Strategy, { workspaceId: W, role, facts: [], initial: strategy(o) }));

test("a plan shows planned, done and achieved, and says where each number came from", () => {
  const page = planPage("marketer");
  for (const word of ["Planned 1, done 0, skipped 0", "Meetings (50%)", "assumption", "entered by a person", "isn't a promise", "Your account"]) expect(page).toContain(word);
  // An editor reads the plan once, in its editor (D5); someone who can't edit gets the read-only copy.
  expect(page).not.toContain("Goal: 4 meetings");
  const viewer = planPage("viewer");
  for (const word of ["Goal: 4 meetings", "isn't a promise", "(your account)"]) expect(viewer).toContain(word);
});

test("a budget reads as money, and a currency code Intl doesn't know keeps its code", () => {
  const current = { ...plan().current!, budget: [{ label: "Ads", amountCents: 40000, currency: "USD", billedBy: "direx" as const }, { label: "Other", amountCents: 1250, currency: "ZZZZ", billedBy: "direx" as const }] };
  const page = planPage("viewer", { current });
  expect(page).toMatch(/Ads: about (US)?\$400\.00/);
  expect(page).toContain("Other: about 12.50 ZZZZ");
});

test("a reading from Direx doesn't claim someone entered it", () => {
  const measures = [{ ...tracking.measures[0]!, latest: { value: "3", observedOn: "2026-11-10", source: "system" as const } }];
  expect(planPage("viewer", { tracking: { ...tracking, measures } })).toContain(", from Direx");
});

test("redrafting an approved plan warns that it replaces the steps, and a first draft doesn't", () => {
  expect(planPage("marketer")).toContain("Redrafting writes a whole new plan");
  expect(planPage("marketer", { current: null, currentVersion: null })).not.toContain("Redrafting writes a whole new plan");
});

test("a Marketer may approve, a Contributor may write but not approve, a Viewer only reads", () => {
  const w = { waiting };
  expect(planPage("marketer", w)).toContain("Approve version 2");
  expect(planPage("marketer", w)).toContain("Each draft still comes to you");
  const contributor = planPage("contributor", w);
  expect(contributor).not.toContain("Approve version 2");
  expect(contributor).toContain("Send for sign-off");
  const viewer = planPage("viewer", w);
  for (const word of ["Approve version", "Send for sign-off", "Add reading", "<select", "<form"]) expect(viewer).not.toContain(word);
  expect(viewer).toContain("Read this before approving");
});

test("what moved under a plan shows as a note", () => {
  const page = planPage("viewer", { notes: [{ kind: "strategy_changed" }, { kind: "fact_changed", factId: ID }] });
  expect(page).toContain("The Strategy has changed");
  expect(page).toContain("A brand fact this plan relies on has changed");
});

test("the Strategy shows its channels with what they rest on, and its roles", () => {
  expect(strategyPage("viewer")).toContain("Ops leads read email");
  expect(strategyPage("viewer")).toContain("assumption");
  expect(strategyPage("viewer")).not.toContain("Edit Strategy");
  expect(strategyPage("contributor", { waiting })).toContain("Edit Strategy");
  expect(strategyPage("contributor", { waiting })).not.toContain("Approve version");
  expect(strategyPage("owner", { waiting })).toContain("Approve version 2");
  expect(strategyPage("viewer", { current: null, currentVersion: null })).toContain("No Strategy yet.");
});

test("a new campaign asks for the Strategy first when none is approved, and points to Brand for it", () => {
  const page = (s: LoadedStrategy) => html(createElement(NewCampaign, { workspaceId: W, initial: { strategy: s } }));
  expect(page(strategy({ current: null, currentVersion: null }))).toContain("approve that first");
  const ready = page(strategy());
  expect(ready).not.toContain("approve that first");
  expect(ready).toContain("Write it myself");
  expect(ready).toContain("Draft plan");
  expect(page(strategy({ current: null, currentVersion: null }))).toContain(`/w/${W}/brand`);
  expect(page(strategy({ current: null, currentVersion: null }))).not.toContain("Draft plan");
});

test("drafting is offered only with something to draft from, and says it writes nothing", () => {
  expect(planPage("marketer", { current: null, draft: null })).toContain("Draft it for me");
  expect(planPage("marketer")).toContain("Redraft");
  expect(planPage("marketer", { request: null })).not.toContain("Redraft");
  expect(planPage("viewer")).not.toContain("Redraft");
  expect(withoutButtons(planPage("marketer", { current: null, draft: null, notice: undefined } as never))).not.toContain("role=\"status\"");
  const running = html(createElement(Plan, { workspaceId: W, id: ID, role: "marketer", runId: ID, initial: { plan: plan(), facts: [] } }));
  expect(running).toContain("Nothing is sent");
  const refused = html(createElement(Plan, { workspaceId: W, id: ID, role: "marketer", notice: "no_route", initial: { plan: plan(), facts: [] } }));
  expect(refused).toContain("write this one yourself");
  const page = (s: LoadedStrategy) => html(createElement(NewCampaign, { workspaceId: W, initial: { strategy: s } }));
  expect(page(strategy())).toContain("Draft plan");
  expect(page(strategy({ current: null, currentVersion: null }))).not.toContain("Draft plan");
  expect(strategyPage("marketer")).toContain("Draft it for me");
  expect(strategyPage("viewer")).not.toContain("Draft it for me");
});

test("what became of a run reads as words, and never as if it decided anything", () => {
  const run = (o: object) => ({ status: "succeeded", statusReason: null, proposals: [{ kind: "plan_proposal", itemId: null, rejectionCode: null, incomplete: false }], ...o }) as Parameters<typeof draftOutcome>[0];
  expect(draftOutcome(run({}))).toContain("Nothing happens until you submit it");
  expect(draftOutcome(run({ proposals: [{ kind: "plan_proposal", itemId: null, rejectionCode: "target_changed", incomplete: false }] }))).toContain("your version stayed");
  expect(draftOutcome(run({ status: "failed", statusReason: "invalid_output" }))).toContain("Nothing changed");
  expect(sayDraft("no_route")).toContain("write this one yourself");
  expect(sayDraft("disabled")).toContain("turned off");
});

test("the pages use glossary words", () => {
  expect(planPage("owner", { waiting }).replace(/<[^>]+>/g, " ")).not.toMatch(/\b(tenant|failed|kpi|recipient|contact)\b/i);
});

test("a refusal reads as words", () => {
  expect(say("no_strategy")).toContain("Strategy first");
  expect(say(`citation_not_ok:${ID}`)).toContain("A brand fact this relies on");
  expect(missingWords([{ path: "goal", message: "Invalid" }, { path: "endsOn", message: "plan_dates_out_of_range" }])).toBe("goal, dates up to 45 days apart, ending after they start");
});

test("each action calls its endpoint", async () => {
  const post = vi.spyOn(api, "POST").mockResolvedValue({ data: { id: ID }, error: undefined } as never);
  const put = vi.spyOn(api, "PUT").mockResolvedValue({ data: { revision: 2, missing: [] }, error: undefined } as never);
  const all = { path: { workspaceId: W } };
  const one = { path: { workspaceId: W, id: ID } };
  expect(await saveStrategy(W, 1, strategyBody)).toEqual({ revision: 2, error: null });
  expect(put).toHaveBeenLastCalledWith("/api/w/{workspaceId}/strategy/draft", { params: all, body: { revision: 1, body: strategyBody } });
  await submitStrategy(W, 2);
  expect(post).toHaveBeenLastCalledWith("/api/w/{workspaceId}/strategy/submit", { params: all, body: { revision: 2 } });
  expect(await createPlan(W, { title: "Q4" })).toEqual({ id: ID });
  expect(post).toHaveBeenLastCalledWith("/api/w/{workspaceId}/plans", { params: all, body: { title: "Q4" } });
  await savePlan(W, ID, 1, body);
  expect(put).toHaveBeenLastCalledWith("/api/w/{workspaceId}/plans/{id}/draft", { params: one, body: { revision: 1, body } });
  await submitPlan(W, ID, 2);
  expect(post).toHaveBeenLastCalledWith("/api/w/{workspaceId}/plans/{id}/submit", { params: one, body: { revision: 2 } });
  await markStep(W, ID, "first", "done");
  expect(post).toHaveBeenLastCalledWith("/api/w/{workspaceId}/plans/{id}/steps/{key}/progress", { params: { path: { workspaceId: W, id: ID, key: "first" } }, body: { status: "done" } });
  await addReading(W, ID, "meetings", { value: "2", observedOn: "2026-11-10" });
  expect(post).toHaveBeenLastCalledWith("/api/w/{workspaceId}/plans/{id}/measures/{key}/readings", { params: { path: { workspaceId: W, id: ID, key: "meetings" } }, body: { value: "2", observedOn: "2026-11-10" } });
  post.mockResolvedValue({ data: { runId: ID }, error: undefined } as never);
  expect(await startPlanDraft(W, ID)).toEqual({ runId: ID, error: null });
  expect(post).toHaveBeenLastCalledWith("/api/w/{workspaceId}/plans/{id}/draft-run", { params: one });
  expect(await startStrategyDraft(W, "Sell audits")).toEqual({ runId: ID, error: null });
  expect(post).toHaveBeenLastCalledWith("/api/w/{workspaceId}/strategy/draft-run", { params: all, body: { request: "Sell audits" } });
  vi.restoreAllMocks();
});

test("a plan that wrote email templates shows each one collapsed, and its approve button says how many it approves", () => {
  const steps = [
    { key: "first", on: "2026-11-03", title: "First email", template: { subject: "Month-end in a day", text: "Hi {{firstName}}", citations: [] } },
    { key: "post", on: "2026-11-04", title: "Launch post" },
  ];
  const html = planPage("marketer", { waiting, draft: { ...body, steps } });
  expect(html).toContain("Approve plan and 1 email template");
  expect(html).toContain("<summary>Email: Month-end in a day</summary>");
  expect(planPage("marketer", { waiting })).toContain("Approve version 2");
});

test("a kept draft shows what Direx wrote and its cost, and only someone who may save can use or dismiss it", async () => {
  const offer = { runId: ID, outputKey: "plan", kind: "plan_proposal", body: { goal: "Kept goal" }, at: "2026-11-08T10:00:00.000Z", costMicros: "120000", subscription: false };
  const kept = (edit: boolean) =>
    renderToString(withQueries(createElement(KeptDraft, { workspaceId: W, target: { target: "plan", id: ID }, revision: 2, edit, onDone: () => {}, initial: offer, preview: (b) => (b as { goal: string }).goal })));
  expect(kept(true)).toContain("Direx&#x27;s draft arrived after your edit");
  expect(kept(true)).toContain("Kept goal");
  expect(kept(true)).toContain("0.12");
  expect(kept(true)).toContain("Use Direx&#x27;s draft");
  expect(kept(false)).not.toContain("Dismiss");
  expect(withoutButtons(renderToString(withQueries(createElement(KeptDraft, { workspaceId: W, target: { target: "strategy" }, revision: 0, edit: true, onDone: () => {}, preview: () => "x" }))))).not.toContain("Direx&#x27;s draft");
  expect(draftOutcome({ status: "succeeded", statusReason: null, proposals: [{ kind: "plan_proposal", itemId: null, rejectionCode: "target_changed", incomplete: false }] } as never)).toContain("kept on this page");

  const get = vi.spyOn(api, "GET").mockResolvedValue({ data: offer, error: undefined } as never);
  const post = vi.spyOn(api, "POST").mockResolvedValue({ data: { ok: true }, error: undefined } as never);
  expect(await getOffer(W, { target: "step", id: ID, stepKey: "first" })).toEqual(offer);
  expect(get).toHaveBeenCalledWith("/api/w/{workspaceId}/drafts/offer", { params: { path: { workspaceId: W }, query: { target: "step", id: ID, stepKey: "first" } } });
  expect(await takeOffer(W, offer, 2)).toBeNull();
  expect(post).toHaveBeenCalledWith("/api/w/{workspaceId}/drafts/offer/{runId}/{outputKey}/use", { params: { path: { workspaceId: W, runId: ID, outputKey: "plan" } }, body: { revision: 2 } });
  post.mockResolvedValue({ data: undefined, error: { error: "offer_closed" } } as never);
  expect(await dismissOffer(W, offer)).toBe("offer_closed");
  get.mockRestore();
  post.mockRestore();
});
