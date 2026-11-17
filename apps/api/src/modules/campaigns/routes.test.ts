// SPDX-License-Identifier: AGPL-3.0-only
// Campaigns over HTTP, with real sessions and each role going through the real flow.
import { expect, test, vi } from "vitest";
import { createFacts, factKinds } from "../facts/index";
import { itemsApp } from "../items/fixtures/items";
import { createOutreach } from "../outreach/index";
import { createPlans, planKinds, planRoutes } from "../plans/index";
import { campaignOnPlanApproved, campaignOnPlanCreated, campaignRoutes, createCampaigns } from "./index";

const { routes, call, signIn, createOrg, addMember, items } = await itemsApp({ kinds: { ...factKinds(), ...planKinds({ onPlanApproved: campaignOnPlanApproved({ items: () => items }) }) } });
const facts = createFacts({ items: () => items });
const plans = createPlans({ items: () => items, facts, onPlanCreated: campaignOnPlanCreated });
const noSend = () => {
  throw new Error("nothing is sent here");
};
const outreach = createOutreach({ items: () => items, send: noSend, baseUrl: () => "http://direx.test" });
const started: { agent: string }[] = [];
const campaigns = createCampaigns({
  plans,
  facts,
  items: () => items,
  outreach: () => outreach,
  startDraft: () => async (_w, a) => {
    started.push(a);
    return { ok: true, run: { id: crypto.randomUUID() } };
  },
});
routes.route("/", planRoutes({ plans: () => plans, startDraft: async () => ({ ok: true, run: { id: crypto.randomUUID() } }) }));
routes.route("/", campaignRoutes({ campaigns: () => campaigns }));

const owner = await signIn();
const W = (await createOrg(owner)).workspace.id;
const roles = {
  marketer: (await addMember(owner, W, "marketer")).cookie,
  contributor: (await addMember(owner, W, "contributor")).cookie,
  viewer: (await addMember(owner, W, "viewer")).cookie,
};
const url = (rest = "") => `/api/w/${W}${rest}`;
const send = (method: string, path: string, cookie: string, body?: unknown) => call(path, cookie, { method, ...(body !== undefined && { body }) });
const read = async <T>(path: string, cookie = owner) => (await (await call(path, cookie)).json()) as T;
type Waiting = { id: string; revision: number };
const approve = (w: Waiting) => send("POST", url(`/items/${w.id}/approve`), owner, { revision: w.revision });

const strategy = {
  schemaVersion: 1,
  whoFor: "Ops",
  personas: [],
  positioning: "Audit",
  channels: [{ key: "email", label: "Email", timing: "now", reason: "Read", basis: { kind: "assumption" } }],
  assumptions: [],
};
await send("PUT", url("/strategy/draft"), owner, { revision: 0, body: strategy });
await send("POST", url("/strategy/submit"), owner, { revision: 1 });
await approve((await read<{ waiting: Waiting }>(url("/strategy"))).waiting);

async function newCampaign() {
  const { id } = (await (await send("POST", url("/plans"), owner, { title: "Q4" })).json()) as { id: string };
  const body = { schemaVersion: 1, goal: "4 meetings", audience: "Ops", startsOn: "2026-11-01", endsOn: "2026-11-30", steps: [{ key: "first", on: "2026-11-03", title: "First" }], measures: [{ key: "m", label: "M", target: "4", basis: { kind: "assumption" } }], budget: [], assumptions: [] };
  await send("PUT", url(`/plans/${id}/draft`), owner, { revision: 0, body });
  await send("POST", url(`/plans/${id}/submit`), owner, { revision: 1 });
  await approve((await read<{ waiting: Waiting }>(url(`/plans/${id}`))).waiting);
  return (await read<{ campaigns: { id: string; planId: string }[] }>(url("/campaigns"))).campaigns.find((c) => c.planId === id)!.id;
}
const STEP = { type: "email", touchClass: "cold", mailboxCredentialId: null, audience: "everyone" };

test("anyone in the Workspace reads a campaign", async () => {
  const id = await newCampaign();
  for (const cookie of [roles.viewer, roles.contributor, roles.marketer, owner]) {
    expect((await call(url("/campaigns"), cookie)).status).toBe(200);
    expect((await call(url(`/campaigns/${id}`), cookie)).status).toBe(200);
    expect((await call(url(`/campaigns/${id}/people`), cookie)).status).toBe(200);
    expect((await call(url(`/campaigns/${id}/activity`), cookie)).status).toBe(200);
  }
  // A new Campaign has done one thing: it was made from its plan.
  expect(await read(url(`/campaigns/${id}/activity`), roles.viewer)).toEqual({ events: [{ at: expect.any(String), text: "Created the campaign from its plan", by: "person", undo: null }] });
  expect((await call(url("/campaigns/00000000-0000-4000-8000-000000000999/activity"), owner)).status).toBe(404);
  expect(await read(url(`/campaigns/${id}`), roles.viewer)).toMatchObject({ title: "Q4", draftingMode: null, paused: false, planned: 1, steps: [{ key: "first", type: "manual", inPlan: true }] });
});

test("a plan's link finds its Campaign for anyone in the Workspace, a Draft's too, and an unknown plan gets 404", async () => {
  const id = await newCampaign();
  const { planId } = await read<{ planId: string }>(url(`/campaigns/${id}`));
  expect(await read(url(`/plans/${planId}/campaign`), roles.viewer)).toEqual({ campaignId: id });
  const { id: draft } = (await (await send("POST", url("/plans"), owner, { title: "Fresh" })).json()) as { id: string };
  const listed = (await read<{ campaigns: { id: string; planId: string; status: string }[] }>(url("/campaigns"))).campaigns.find((c) => c.planId === draft)!;
  expect(listed.status).toBe("draft");
  expect(await read(url(`/plans/${draft}/campaign`), roles.viewer)).toEqual({ campaignId: listed.id });
  expect((await call(url("/plans/00000000-0000-4000-8000-000000000999/campaign"), owner)).status).toBe(404);
});

test("anyone in the Workspace reads a campaign's results, which hold only what is recorded", async () => {
  const id = await newCampaign();
  for (const cookie of [roles.viewer, roles.contributor, roles.marketer, owner]) expect((await call(url(`/campaigns/${id}/results`), cookie)).status).toBe(200);
  // Nothing sent: no email numbers, and the measure has no reading yet.
  expect(await read(url(`/campaigns/${id}/results`), roles.viewer)).toEqual({ sent: [], email: null, measures: [{ key: "m", label: "M", target: "4", value: null, observedOn: null }] });
  expect((await call(url("/campaigns/00000000-0000-4000-8000-000000000999/results"), owner)).status).toBe(404);
  const listed = (await read<{ campaigns: { id: string }[] }>(url("/campaigns"))).campaigns.find((c) => c.id === id);
  expect(listed).toMatchObject({ measure: { label: "M", target: "4", value: null }, channels: [] });
});

test("a Viewer can't change anything, and a Contributor can", async () => {
  const id = await newCampaign();
  const person = crypto.randomUUID();
  expect((await send("POST", url(`/campaigns/${id}/people`), roles.viewer, { csv: "email\na@acme.test" })).status).toBe(403);
  expect((await send("DELETE", url(`/campaigns/${id}/people/${person}`), roles.viewer)).status).toBe(403);
  expect((await send("PUT", url(`/campaigns/${id}/steps/first`), roles.viewer, STEP)).status).toBe(403);

  expect((await send("POST", url(`/campaigns/${id}/people`), roles.contributor, { csv: "email\na@acme.test" })).status).toBe(200);
  expect((await send("PUT", url(`/campaigns/${id}/steps/first`), roles.contributor, STEP)).status).toBe(200);
});

test("a manual step's URL is recorded over HTTP, by someone who can edit, with its refusals", async () => {
  const id = await newCampaign();
  const output = (cookie: string, body: unknown, campaign = id) => send("POST", url(`/campaigns/${campaign}/steps/first/output`), cookie, body);
  expect((await output(roles.viewer, { url: "https://acme.test/launch" })).status).toBe(403);
  const r = await output(roles.contributor, { url: "https://acme.test/launch" });
  expect([r.status, await r.json()]).toEqual([200, { stepKey: "first", url: "https://acme.test/launch", version: 1, source: "person", at: expect.any(String) }]);
  expect(await read(url(`/campaigns/${id}`), roles.viewer)).toMatchObject({ steps: [{ key: "first", output: { url: "https://acme.test/launch", version: 1, source: "person" }, waitingOn: null, dependsOnStepKey: null, utm: false }] });
  expect((await output(owner, { url: "https://acme.test/launch" })).status).toBe(409);
  expect(await (await output(owner, { url: "http://acme.test/launch" })).json()).toEqual({ error: "bad_url" });
  expect((await output(owner, { url: "https://acme.test/launch" }, crypto.randomUUID())).status).toBe(404);
  expect((await output(owner, { url: "https://acme.test/x", extra: true })).status).toBe(400);
});

test("people go in by CSV, one result per row, and come out with their status", async () => {
  const id = await newCampaign();
  const r = await send("POST", url(`/campaigns/${id}/people`), owner, { csv: "email,company\nkim@acme.test,<b>Acme</b>\nnot-an-email,Beta" });
  expect(await r.json()).toMatchObject({ results: [{ row: 1, ok: true, missing: ["country", "basis", "evidence"] }, { row: 2, ok: false, reason: "bad_email" }] });
  const { people } = await read<{ people: { personId: string; email: string; company: string; status: string }[] }>(url(`/campaigns/${id}/people`));
  expect(people).toMatchObject([{ email: "kim@acme.test", company: "<b>Acme</b>", status: "active" }]);

  expect((await send("DELETE", url(`/campaigns/${id}/people/${people[0]!.personId}`), owner)).status).toBe(200);
  expect(await read(url(`/campaigns/${id}/people`))).toMatchObject({ people: [{ status: "removed" }] });
});

test("refusals say why", async () => {
  const id = await newCampaign();
  const missing = crypto.randomUUID();
  const reply = async (r: Response) => [r.status, await r.json()];
  expect(await reply(await send("POST", url(`/campaigns/${id}/people`), owner, { csv: "name\nSam" }))).toEqual([400, { error: "no_email_column" }]);
  expect(await reply(await send("PUT", url(`/campaigns/${id}/steps/nope`), owner, STEP))).toEqual([400, { error: "step_not_in_plan" }]);
  expect((await send("PUT", url(`/campaigns/${id}/steps/first`), owner, { ...STEP, type: "post" })).status).toBe(400);
  expect((await call(url(`/campaigns/${missing}`), owner)).status).toBe(404);
  expect(await reply(await send("POST", url(`/campaigns/${missing}/people`), owner, { csv: "email\na@acme.test" }))).toEqual([404, { error: "not_found" }]);
  expect(await reply(await send("DELETE", url(`/campaigns/${id}/people/${missing}`), owner))).toEqual([404, { error: "not_found" }]);
});

test("a member of another Workspace gets 404", async () => {
  const id = await newCampaign();
  const stranger = await signIn();
  await createOrg(stranger);
  expect((await call(url("/campaigns"), stranger)).status).toBe(404);
  expect((await call(url(`/campaigns/${id}`), stranger)).status).toBe(404);
  expect((await call(url(`/campaigns/${id}/results`), stranger)).status).toBe(404);
  expect((await send("POST", url(`/campaigns/${id}/people`), stranger, { csv: "email\na@acme.test" })).status).toBe(404);
});

test("drafting needs an email step, then starts one run for it", async () => {
  const id = await newCampaign();
  const run = () => send("POST", url(`/campaigns/${id}/steps/first/draft-run`), owner);
  const reply = async (r: Response) => [r.status, await r.json()];
  // Modes belong to email steps and default when one is set up, so there is no Campaign question to wait on.
  expect(await reply(await run())).toEqual([409, { error: "not_an_email_step" }]);

  expect((await send("PUT", url(`/campaigns/${id}/drafting-mode`), roles.viewer, { mode: "template" })).status).toBe(403);
  expect((await send("PUT", url(`/campaigns/${id}/drafting-mode`), owner, { mode: "per_step" })).status).toBe(400);
  expect((await send("PUT", url(`/campaigns/${id}/drafting-mode`), owner, { mode: "template" })).status).toBe(200);
  expect(await reply(await run())).toEqual([409, { error: "not_an_email_step" }]);

  await send("PUT", url(`/campaigns/${id}/steps/first`), owner, STEP);
  expect((await send("POST", url(`/campaigns/${id}/steps/first/draft-run`), roles.viewer)).status).toBe(403);
  const before = started.length;
  expect((await run()).status).toBe(200);
  expect(started.slice(before)).toMatchObject([{ agent: "campaign_drafter", input: { target: { id, stepKey: "first", draftRevision: 0 } } }]);
});

test("a step's drafting mode is set by its own route, by someone who can edit", async () => {
  const id = await newCampaign();
  await send("PUT", url(`/campaigns/${id}/steps/first`), owner, STEP);
  const mode = (who: typeof owner, body: unknown) => send("PUT", url(`/campaigns/${id}/steps/first/drafting-mode`), who, body);
  expect((await mode(roles.viewer, { mode: "per_person" })).status).toBe(403);
  expect((await mode(owner, { mode: "sometimes" })).status).toBe(400);
  expect((await mode(owner, { mode: "per_person" })).status).toBe(200);
  expect((await send("POST", url(`/campaigns/${id}/steps/first/draft-run`), owner)).status).toBe(409);
});

test("anyone in the Workspace can preview drafting on import; only an editor can confirm it", async () => {
  const id = await newCampaign();
  await send("PUT", url(`/campaigns/${id}/steps/first`), owner, STEP);
  expect((await send("GET", url(`/campaigns/${id}/drafting-preview`), roles.viewer)).status).not.toBe(403);
  expect((await send("POST", url(`/campaigns/${id}/drafting-confirm`), roles.viewer, { timeZone: "UTC" })).status).toBe(403);
  expect((await send("POST", url(`/campaigns/${id}/drafting-confirm`), owner, { timeZone: "Mars/Olympus" })).status).toBe(400);
  expect((await send("POST", url(`/campaigns/${crypto.randomUUID()}/drafting-confirm`), owner, { timeZone: "UTC" })).status).toBe(404);
});

test("moving the launch needs an editor and a real date, and a preview changes nothing", async () => {
  const id = await newCampaign();
  const move = (who: typeof owner, body: unknown) => send("PUT", url(`/campaigns/${id}/anchor`), who, body);
  expect((await move(roles.viewer, { on: "2030-01-07" })).status).toBe(403);
  expect((await move(owner, { on: "next week" })).status).toBe(400);
  const preview = await move(owner, { on: "2030-01-07", preview: true });
  expect(preview.status).toBe(200);
  const after = (await (await send("GET", url(`/campaigns/${id}`), owner)).json()) as { steps: { on: string | null }[] };
  expect(after.steps[0]?.on).not.toBe("2030-01-08");
  expect((await move(owner, { on: "2030-01-07" })).status).toBe(200);
  expect((await move(owner, { on: "2030-01-07" })).status).toBe(409);
});

test("per-address mode can't start a template run", async () => {
  const id = await newCampaign();
  await send("PUT", url(`/campaigns/${id}/drafting-mode`), owner, { mode: "per_person" });
  await send("PUT", url(`/campaigns/${id}/steps/first`), owner, STEP);
  expect((await send("POST", url(`/campaigns/${id}/steps/first/draft-run`), owner)).status).toBe(409);
});

test("a run's input holds no Person", async () => {
  const id = await newCampaign();
  await send("POST", url(`/campaigns/${id}/people`), owner, { csv: "email,company\nsecret-person@acme.test,Hidden Co" });
  await send("PUT", url(`/campaigns/${id}/drafting-mode`), owner, { mode: "template" });
  await send("PUT", url(`/campaigns/${id}/steps/first`), owner, STEP);
  await send("POST", url(`/campaigns/${id}/steps/first/draft-run`), owner);
  const text = JSON.stringify(started.at(-1));
  expect(text).not.toContain("secret-person");
  expect(text).not.toContain("Hidden Co");
});

test("run is granted like a rule: an owner after a recent sign-in, with a real zone, and the spend cap shown first", async () => {
  const id = await newCampaign();
  const advance = (cookie: string, body: unknown) => send("POST", url(`/campaigns/${id}/advance`), cookie, body);
  expect(await read<{ advance: string; advanceUpToCents: number }>(url(`/campaigns/${id}`))).toMatchObject({ advance: "offer", advanceUpToCents: 0 });
  await send("PUT", url(`/campaigns/${id}/steps/first`), owner, STEP);
  expect((await read<{ advanceUpToCents: number }>(url(`/campaigns/${id}`))).advanceUpToCents).toBe(100);

  expect((await advance(roles.marketer, { advance: "run", timeZone: "Europe/London" })).status).toBe(403);
  expect((await advance(owner, { advance: "run" })).status).toBe(400);
  expect((await advance(owner, { advance: "run", timeZone: "Europe/London" })).status).toBe(200);
  expect(await read<{ advance: string; advanceSetBy: string | null }>(url(`/campaigns/${id}`))).toMatchObject({ advance: "run", advanceSetBy: expect.any(String) });

  vi.useFakeTimers({ toFake: ["Date"] });
  try {
    vi.setSystemTime(Date.now() + 11 * 60_000);
    const stale = await advance(owner, { advance: "offer" });
    expect([stale.status, await stale.json()]).toEqual([403, { error: "step_up_required" }]);
  } finally {
    vi.useRealTimers();
  }
});

test("the plan draft's impact on a Campaign: anyone in it reads it, it lists only steps it would hold, and another Workspace gets 404", async () => {
  const id = await newCampaign();
  const { planId } = await read<{ planId: string }>(url(`/campaigns/${id}`));
  expect((await send("PUT", url(`/campaigns/${id}/steps/first`), owner, STEP)).status).toBe(200);
  expect(await read(url(`/campaigns/${id}/plan-impact`), roles.viewer)).toEqual({ diff: { steps: [], plan: [] }, affected: [], titles: { first: "First" } });

  const { draftRevision } = await read<{ draftRevision: number }>(url(`/plans/${planId}`));
  const later = { schemaVersion: 1, goal: "5 meetings", audience: "Ops", startsOn: "2026-11-01", endsOn: "2026-11-30", steps: [{ key: "second", on: "2026-11-04", title: "Second" }], measures: [{ key: "m", label: "M", target: "4", basis: { kind: "assumption" } }], budget: [], assumptions: [] };
  expect((await send("PUT", url(`/plans/${planId}/draft`), owner, { revision: draftRevision, body: later })).status).toBe(200);
  expect(await read(url(`/campaigns/${id}/plan-impact`), roles.viewer)).toEqual({
    diff: { steps: [{ key: "second", kind: "added" }, { key: "first", kind: "removed" }], plan: ["goal"] },
    affected: [{ key: "first", kinds: ["removed"], counts: {} }],
    titles: { first: "First", second: "Second" },
  });

  const stranger = await signIn();
  await createOrg(stranger);
  expect((await call(url(`/campaigns/${id}/plan-impact`), stranger)).status).toBe(404);
});

test("a rewrite takes a preset or a person's words, not both, and starts the email's writer with that instruction", async () => {
  const item = crypto.randomUUID();
  const rewrite = (cookie: string, body: unknown) => send("POST", url(`/items/${item}/rewrite`), cookie, body);
  const reply = async (r: Response) => [r.status, await r.json()];
  expect(await reply(await rewrite(owner, { timeZone: "UTC" }))).toEqual([400, { error: "preset_or_instruction" }]);
  expect(await reply(await rewrite(owner, { preset: "shorter", instruction: "Shorter", timeZone: "UTC" }))).toEqual([400, { error: "preset_or_instruction" }]);
  expect((await rewrite(owner, { preset: "louder", timeZone: "UTC" })).status).toBe(400);
  expect((await rewrite(roles.viewer, { preset: "shorter", timeZone: "UTC" })).status).toBe(403);
  // Something that isn't a Campaign's email says so.
  expect(await reply(await rewrite(owner, { preset: "shorter", timeZone: "UTC" }))).toEqual([409, { error: "not_a_campaign_email" }]);
  const runId = crypto.randomUUID();
  const spy = vi.spyOn(campaigns, "rewrite").mockResolvedValue({ ok: true, runId });
  expect(await reply(await rewrite(roles.marketer, { instruction: "  Mention the free audit.  ", timeZone: "Europe/London" }))).toEqual([200, { runId }]);
  expect(spy).toHaveBeenLastCalledWith(W, item, expect.objectContaining({ instruction: "Mention the free audit.", timeZone: "Europe/London" }));
  await rewrite(roles.marketer, { preset: "casual", timeZone: "UTC" });
  expect(spy.mock.lastCall?.[2].instruction).toMatch(/^Make it more casual/);
  expect(spy.mock.lastCall?.[2].reason).toBeUndefined();
  // A reason goes to the writer as words, with the person's sentence after them, and is passed on to be recorded.
  const opened = new Date(Date.now() - 20_000).toISOString();
  expect((await rewrite(roles.marketer, { reason: "salesy", instruction: "No discount.", openedAt: opened, timeZone: "UTC" })).status).toBe(200);
  expect(spy).toHaveBeenLastCalledWith(W, item, expect.objectContaining({ instruction: "It's too salesy. Make it lower-key, with no hard sell or hype. No discount.", reason: "salesy", note: "No discount.", openedAt: new Date(opened) }));
  expect(await reply(await rewrite(owner, { preset: "shorter", reason: "long", timeZone: "UTC" }))).toEqual([400, { error: "preset_or_instruction" }]);
  expect((await rewrite(owner, { reason: "rude", timeZone: "UTC" })).status).toBe(400);
  spy.mockRestore();
});
