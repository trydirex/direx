// SPDX-License-Identifier: AGPL-3.0-only
// Campaigns over HTTP, with real sessions and each role going through the real flow.
import { expect, test, vi } from "vitest";
import { appClient } from "../../../../../test/db";
import { createFacts, factKinds } from "../facts/index";
import { itemsApp } from "../items/fixtures/items";
import { createOutreach } from "../outreach/index";
import { createPlans, planKinds, planRoutes } from "../plans/index";
import { setTimeZone } from "../schedule/index";
import { campaignOnPlanApproved, campaignOnPlanCreated, campaignRoutes, createCampaigns } from "./index";

const { routes, call, signIn, createOrg, addMember, items } = await itemsApp({ kinds: { ...factKinds(), ...planKinds({ onPlanApproved: campaignOnPlanApproved({ items: () => items }) }) } });
const facts = createFacts({ items: () => items });
const plans = createPlans({ items: () => items, facts, onPlanCreated: campaignOnPlanCreated });
const noSend = () => {
  throw new Error("nothing is sent here");
};
const outreach = createOutreach({ items: () => items, send: noSend, baseUrl: () => "http://direx.test" });
const started: { agent: string }[] = [];
const now = vi.fn(() => new Date());
const campaigns = createCampaigns({
  now,
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
  // Nothing sent: no email numbers, the measure has no reading yet, and a step not set up counts nothing.
  expect(await read(url(`/campaigns/${id}/results`), roles.viewer)).toEqual({
    sent: [],
    email: null,
    measures: [{ key: "m", label: "M", target: "4", value: null, observedOn: null }],
    steps: [{ stepKey: "first", title: "First", kind: "manual", channel: null, sent: null, replied: null, interested: null }],
  });
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

test("meetings and deals are marked and undone over HTTP by someone who can edit; a Viewer gets 403 on both", async () => {
  const id = await newCampaign();
  const added = (await (await send("POST", url(`/campaigns/${id}/people`), owner, { csv: "email\nmark@acme.test\nkim@acme.test" })).json()) as { results: { personId: string }[] };
  const [sam, kim] = added.results.map((r) => r.personId) as [string, string];
  const mark = (cookie: string, body: unknown, campaign = id) => send("POST", url(`/campaigns/${campaign}/outcomes`), cookie, body);
  const undo = (cookie: string, markId: string, campaign = id) => send("POST", url(`/campaigns/${campaign}/outcomes/${markId}/undo`), cookie);
  const outcomesOf = async (personId: string) => (await read<{ people: { personId: string; outcomes: unknown[] }[] }>(url(`/campaigns/${id}/people`), roles.viewer)).people.find((p) => p.personId === personId)!.outcomes;
  const rows = async () => {
    const db = await appClient();
    await db.query("select set_config('app.workspace_id', $1, false)", [W]);
    const { rows } = await db.query<{ id: string; voids: string | null }>("select id, voids from campaign_outcomes where campaign_id = $1", [id]);
    await db.end();
    return rows;
  };

  expect((await mark(roles.viewer, { personId: sam, kind: "meeting", on: "2026-11-01" })).status).toBe(403);
  const r = await mark(roles.contributor, { personId: sam, kind: "meeting", on: "2026-11-02" });
  const meeting = (await r.json()) as { id: string };
  expect([r.status, meeting]).toEqual([200, { id: expect.any(String), kind: "meeting", on: "2026-11-02" }]);
  const deal = await (await mark(owner, { personId: sam, kind: "deal", on: "2026-11-03" })).json();
  expect(await outcomesOf(sam)).toEqual([meeting, deal]);
  expect(await outcomesOf(kim)).toEqual([]);

  // Refused: a future day, a Person not in the Campaign, an unknown Campaign, and a body that isn't the shape.
  expect([(await mark(owner, { personId: kim, kind: "meeting", on: "2999-01-01" })).status, await (await mark(owner, { personId: kim, kind: "meeting", on: "2999-01-01" })).json()]).toEqual([400, { error: "future_date" }]);
  expect(await (await mark(owner, { personId: crypto.randomUUID(), kind: "meeting", on: "2026-11-01" })).json()).toEqual({ error: "not_in_campaign" });
  expect(await (await mark(owner, { personId: kim, kind: "meeting", on: "2026-11-01" }, crypto.randomUUID())).json()).toEqual({ error: "not_found" });
  expect((await mark(owner, { personId: kim, kind: "call", on: "2026-11-01" })).status).toBe(400);
  expect((await mark(owner, { personId: kim, kind: "deal", on: "2026-11-01", extra: true })).status).toBe(400);

  // An undo adds a row and deletes nothing; the mark stops showing. It can't be undone twice, nor can the undo row.
  expect((await undo(roles.viewer, meeting.id)).status).toBe(403);
  expect((await undo(roles.contributor, meeting.id)).status).toBe(200);
  const after = await rows();
  expect(after).toHaveLength(3);
  expect(after.filter((x) => x.voids === meeting.id)).toHaveLength(1);
  expect(await outcomesOf(sam)).toEqual([deal]);
  const second = await undo(owner, meeting.id);
  expect([second.status, await second.json()]).toEqual([409, { error: "already_undone" }]);
  expect(await (await undo(owner, after.find((x) => x.voids === meeting.id)!.id)).json()).toEqual({ error: "mark_not_found" });
  expect((await undo(owner, crypto.randomUUID())).status).toBe(404);
  expect(await (await undo(owner, meeting.id, crypto.randomUUID())).json()).toEqual({ error: "not_found" });
  expect(await rows()).toHaveLength(3);

  // Another Workspace's members never see the mark and can't undo or add to it.
  const other = (await createOrg(owner)).workspace.id;
  const elsewhere = `/api/w/${other}/campaigns/${id}`;
  expect(await read(`${elsewhere}/people`)).toEqual({ people: [], next: null });
  expect((await send("POST", `${elsewhere}/outcomes/${(deal as { id: string }).id}/undo`, owner)).status).toBe(404);
  expect((await send("POST", `${elsewhere}/outcomes`, owner, { personId: sam, kind: "deal", on: "2026-11-01" })).status).toBe(404);
  expect(await outcomesOf(sam)).toEqual([deal]);
});

test("a Viewer reads a Campaign's overlaps, every kind even with no outcome; another Workspace's Campaign is not found", async () => {
  const id = await newCampaign();
  const empty = { rows: [], people: [], more: 0 };
  expect(await read(url(`/campaigns/${id}/overlaps`), roles.viewer)).toEqual({ kinds: [{ kind: "interested", ...empty }, { kind: "meeting", ...empty }, { kind: "deal", ...empty }], hasPosts: false });
  const other = (await createOrg(owner)).workspace.id;
  expect((await call(`/api/w/${other}/campaigns/${id}/overlaps`, owner)).status).toBe(404);
});

test("outcomes accept today and refuse tomorrow in the Workspace's time zone at the UTC date boundary", async () => {
  const id = await newCampaign();
  const added = await (await send("POST", url(`/campaigns/${id}/people`), owner, { csv: "email\nboundary@acme.test" })).json() as { results: { personId: string }[] };
  const personId = added.results[0]!.personId;
  await setTimeZone(W, "America/Los_Angeles");
  // UTC is November 3, but Los Angeles is still on November 2.
  now.mockReturnValue(new Date("2026-11-03T01:00:00Z"));
  try {
    const today = await send("POST", url(`/campaigns/${id}/outcomes`), owner, { personId, kind: "meeting", on: "2026-11-02" });
    expect([today.status, await today.json()]).toEqual([200, { id: expect.any(String), kind: "meeting", on: "2026-11-02" }]);
    const tomorrow = await send("POST", url(`/campaigns/${id}/outcomes`), owner, { personId, kind: "deal", on: "2026-11-03" });
    expect([tomorrow.status, await tomorrow.json()]).toEqual([400, { error: "future_date" }]);
  } finally {
    now.mockImplementation(() => new Date());
    await setTimeZone(W, "UTC");
  }
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
    // The long step-up window (ADR 0037 rule 004).
    vi.setSystemTime(Date.now() + 61 * 60_000);
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

// The write-up, set up in the database as its sink would leave it.
async function inW<T>(text: string, params: unknown[]) {
  const db = await appClient();
  try {
    await db.query("select set_config('app.workspace_id', $1, false)", [W]);
    return (await db.query(text, params)).rows as T[];
  } finally {
    await db.end();
  }
}

test("anyone in the Workspace reads the write-up: null before, then its cited readings, corrected once one isn't its Measure's newest; another Workspace gets 404", async () => {
  const id = await newCampaign();
  const { planId } = await read<{ planId: string }>(url(`/campaigns/${id}`));
  const writeUp = url(`/campaigns/${id}/write-up`);
  expect(await read(writeUp, roles.viewer)).toEqual({ writeUp: null });

  await send("POST", url(`/plans/${planId}/measures/m/readings`), owner, { value: "3", observedOn: "2026-11-20" });
  const r = (await inW<{ id: string }>("select id from plan_measure_readings where plan_id = $1", [planId]))[0]!.id;
  const suggestion = { assumption: "Ops leads answer one email.", because: "Direx counted 3 meetings.", readingIds: [r], outcome: "added" };
  await inW("insert into campaign_write_ups (workspace_id, campaign_id, status, paragraph, cites, suggestions, created_at, written_at) values ($1, $2, 'written', 'Q4 booked 3 meetings.', $3, $4, now(), '2026-12-02T09:00:00Z')", [W, id, JSON.stringify([r]), JSON.stringify([suggestion])]);
  const cite = { readingId: r, label: "M", value: "3", source: "person", observedOn: "2026-11-20" };
  const written = { status: "written", paragraph: "Q4 booked 3 meetings.", cites: [cite], suggestions: [suggestion], failure: null, itemId: null, writtenAt: "2026-12-02T09:00:00.000Z", corrected: false };
  for (const cookie of [roles.viewer, roles.contributor, roles.marketer, owner]) expect(await read(writeUp, cookie)).toEqual({ writeUp: written });

  // A newer reading for the cited Measure: the cite still shows what was written from, and says it was corrected.
  await send("POST", url(`/plans/${planId}/measures/m/readings`), owner, { value: "4", observedOn: "2026-11-25" });
  expect(await read(writeUp)).toEqual({ writeUp: { ...written, corrected: true } });
  // A cited reading that no longer resolves is left out, and counts as corrected too.
  await inW("update campaign_write_ups set cites = $2 where campaign_id = $1", [id, JSON.stringify([crypto.randomUUID()])]);
  expect(await read(writeUp)).toEqual({ writeUp: { ...written, cites: [], corrected: true } });

  const other = (await createOrg(owner)).workspace.id;
  expect((await call(`/api/w/${other}/campaigns/${id}/write-up`, owner)).status).toBe(404);
  expect((await call(url("/campaigns/00000000-0000-4000-8000-000000000999/write-up"), owner)).status).toBe(404);
});

test("Write it again restarts a written or failed write-up of an Ended Campaign with one run, keeping the paragraph; with its refusals", async () => {
  const id = await newCampaign();
  const again = async (cookie = owner, path = url(`/campaigns/${id}/write-up`)) => {
    const r = await send("POST", path, cookie);
    return [r.status, await r.json()];
  };
  const row = async () => (await inW<{ status: string; paragraph: string | null; failure: string | null; run_id: string | null }>("select status, paragraph, failure, run_id from campaign_write_ups where campaign_id = $1", [id]))[0]!;
  const runs = () => started.filter((s) => s.agent === "campaign_writer").length;
  expect(await again()).toEqual([404, { error: "not_found" }]);
  expect(await campaigns.startWriteUp(W, id)).toBe(true);
  const firstRun = (await row()).run_id;
  const before = runs();
  // The plan ends on November 30, so the Campaign is Ended in January.
  now.mockReturnValue(new Date("2027-01-04T12:00:00Z"));
  try {
    expect(await again()).toEqual([409, { error: "writing" }]);
    await inW("update campaign_write_ups set status = 'written', paragraph = 'Q4 sent 1 email.', written_at = now() where campaign_id = $1", [id]);
    expect(await again(roles.viewer)).toEqual([403, expect.anything()]);
    const other = (await createOrg(owner)).workspace.id;
    expect(await again(owner, `/api/w/${other}/campaigns/${id}/write-up`)).toEqual([404, { error: "not_found" }]);
    expect(runs()).toBe(before);

    const writing = { status: "writing", paragraph: "Q4 sent 1 email.", failure: null, cites: [], suggestions: [], itemId: null, writtenAt: expect.any(String), corrected: false };
    expect(await again(roles.marketer)).toEqual([202, { writeUp: writing }]);
    expect(runs()).toBe(before + 1);
    const secondRun = (await row()).run_id;
    expect(secondRun).not.toBeNull();
    expect(secondRun).not.toBe(firstRun);

    await inW("update campaign_write_ups set status = 'failed', failure = 'number_not_in_brief:7' where campaign_id = $1", [id]);
    expect(await again()).toEqual([202, { writeUp: writing }]);
    expect(await row()).toMatchObject({ status: "writing", paragraph: "Q4 sent 1 email.", failure: null });
    expect(runs()).toBe(before + 2);

    // Before the end, it isn't Ended.
    await inW("update campaign_write_ups set status = 'failed', failure = 'number_not_in_brief:7' where campaign_id = $1", [id]);
    now.mockReturnValue(new Date("2026-11-15T12:00:00Z"));
    expect(await again()).toEqual([409, { error: "not_ended" }]);
    expect(runs()).toBe(before + 2);
  } finally {
    now.mockImplementation(() => new Date());
  }
});
