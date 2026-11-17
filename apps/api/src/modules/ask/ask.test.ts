// SPDX-License-Identifier: AGPL-3.0-only
// Ask from a message to its stored reply, through the real agents, facts and items modules. The model
// isn't called: each reply is handed to the sink as the run's propose would hand it.
import type { PgBoss } from "pg-boss";
import { expect, test } from "vitest";
import { createAgents, type Sink } from "../agents/index";
import { createFacts, factKinds } from "../facts/index";
import { itemsWorld, person } from "../items/fixtures/items";
import { routesFor } from "../models/index";
import type { Offered } from "../next-steps/index";
import { createAsk, historyOf } from "./application/messages";
import { askKinds } from "./application/reschedule";
import { askStartJob, askStartKinds } from "./application/starts";
import { askAgent } from "./definitions/ask";
import { appClient } from "../../../../../test/db";
import { can } from "../identity/index";
import { z } from "zod";
import type { AskStart, WorkReport } from "../agents/index";

// Fake starts, as owning modules export them; each records how it was called.
const calls: { start: string; args: unknown; by: unknown }[] = [];
let basis = "b1";
let refuse: string | null = null;
let startReply: { ok: true; work: { kind: string; id: string } } | { ok: false; why: string } = { ok: true, work: { kind: "agent_run", id: "run-1" } };
let throws = false;
let report: WorkReport = { state: "running", itemIds: [] };
const fakeStart = (id: string, area: AskStart["area"], args: z.ZodType): AskStart => ({
  id,
  definition: `${id}_definition`,
  area,
  says: id,
  args,
  permission: "item.edit",
  check: async () => (refuse ? { ok: false, why: refuse } : { ok: true, title: `Do ${id}`, basis }),
  start: async (_w, a, by) => {
    if (throws) throw new Error("start blew up");
    calls.push({ start: id, args: a, by });
    return startReply;
  },
  report: async () => report,
});
const starts: AskStart[] = [fakeStart("draft_plan", null, z.strictObject({ planId: z.uuid() })), fakeStart("write_brief", "seo", z.strictObject({ page: z.string(), query: z.string() }))];
const jobs: unknown[] = [];
const jobBoss = { send: async (_q: string, payload: unknown) => void jobs.push(payload) } as unknown as PgBoss;

const world = await itemsWorld({ kinds: { ...factKinds(), ...askKinds({ items: () => world.items, now: () => world.clock.at }), ...askStartKinds({ starts: () => starts, boss: jobBoss, now: () => world.clock.at }) }, mayGrant: async () => true });
const { W, items, newPost, hours, who } = world;
const facts = createFacts({ items: () => items });
const agents = createAgents({
  boss: { send: async () => {} } as unknown as PgBoss,
  deployment: "self_host",
  routes: routesFor("self_host"),
  models: () => ({ generate: async () => ({ ok: false, reason: "not_called" }) as never }),
  sinks: {},
  definitions: { [askAgent.id]: askAgent as never },
  addWarning: async () => {},
  context: async () => [],
  notify: async () => {},
});
const asked: { link: string; onlyArea?: string | undefined }[] = [];
let offered: Offered = { why: "plan_not_approved" };
const rewrites: { itemId: string; instruction: string; userId: string; tainted?: boolean | undefined }[] = [];
let rewrite: { ok: true; runId: string } | { ok: false; reason: string } = { ok: true, runId: crypto.randomUUID() };
const ask = createAsk({
  agents: () => agents,
  items: () => items,
  nextSteps: () => ({ offerAsked: async (_w, a) => (asked.push(a), offered) }),
  facts: () => facts,
  campaigns: () => ({ rewrite: async (_w, itemId, a) => (rewrites.push({ itemId, ...a }), rewrite) }),
  starts: () => starts,
  // The ledger's test clock, so "past" means past for the schedule too.
  now: () => world.clock.at,
  timeZone: async () => "Europe/Berlin",
});
const me = person.userId;

/** Why a run was cancelled, as its record says. */
async function cancelSource(runId: string) {
  const db = await appClient();
  try {
    await db.query("select set_config('app.workspace_id', $1, false)", [W]);
    return (await db.query("select source from agent_cancellations where run_id = $1", [runId])).rows[0]?.source as string | undefined;
  } finally {
    await db.end();
  }
}
const shown = async (messageId: string) => (await ask.list(W, me)).find((m) => m.id === messageId)!;
const reply = (runId: string, body: unknown, tainted = false) => ask.sink(W, { kind: "ask_reply", outputKey: "reply", body }, { runId, tainted } as Parameters<Sink>[2]);
/** Posts a message and finds the run it started, by its key. */
const posted = async (text: string, extra: { itemId?: string; agent?: string; looking?: Parameters<typeof ask.post>[2]["looking"] } = {}) => {
  const r = await ask.post(W, me, { text, ...extra });
  if (!r.ok) throw new Error(r.reason);
  const run = (await agents.list(W)).map((x) => x.run).find((x) => x.idempotencyKey === `ask:${r.id}`)!;
  return { id: r.id, run };
};

test("a message starts one Ask run as the person, keyed by the message, and shows as working", async () => {
  const { id, run } = await posted("What goes out this week?");
  expect(run).toMatchObject({ agent: "ask", trigger: "user_request", startedBy: me, status: "queued" });
  expect(await shown(id)).toMatchObject({ status: "working", reply: null, steps: [] });
});

test("a new message cancels the run still working on the last one, which then shows as stopped", async () => {
  const first = await posted("First question");
  const second = await posted("Second question");
  expect((await agents.get(W, first.run.id))!.run.status).toBe("cancelled");
  expect(second.run.status).toBe("queued");
  expect(await shown(first.id)).toMatchObject({ status: "stopped", reply: { kind: "cannot", text: "Stopped for your newer message." } });
  expect(await cancelSource(first.run.id)).toBe("queued_message");
});

test("two messages sent at once leave only the newer one's run going", async () => {
  // Settle what earlier tests left going, so only these two count.
  await posted("Clear the way");
  const [a, b] = await Promise.all([ask.post(W, me, { text: "Question A" }), ask.post(W, me, { text: "Question B" })]);
  if (!a.ok || !b.ok) throw new Error("not posted");
  const conversation = await ask.list(W, me);
  const live = conversation.filter((m) => m.status === "working");
  expect(live).toHaveLength(1);
  // The newer is the conversation's last message; the older was stopped for it.
  expect(live[0]!.id).toBe(conversation.at(-1)!.id);
  const older = conversation.at(-2)!;
  expect(older).toMatchObject({ status: "stopped", reply: { kind: "cannot", text: "Stopped for your newer message." } });
});

test("a run that stopped for want of a model says what to set up, not to ask again", async () => {
  const { id, run } = await posted("What is planned?");
  const real = await agents.get(W, run.id);
  const stopped = createAsk({
    agents: () => ({ ...agents, get: async () => ({ ...real!, run: { ...real!.run, status: "failed", statusReason: "no_connection" } }) }),
    items: () => items,
    nextSteps: () => undefined,
    facts: () => facts,
    now: () => world.clock.at,
  });
  expect((await stopped.list(W, me)).find((m) => m.id === id)).toMatchObject({ status: "stopped", reply: { text: expect.stringContaining("AI models page") } });
});

test("an answer is stored as the reply, and a cited id the Workspace doesn't hold is dropped", async () => {
  const item = await newPost({ title: "Launch post" });
  const { id, run } = await posted("What is waiting?");
  expect(await reply(run.id, { kind: "answer", text: "One post waits.", cites: [item.id, crypto.randomUUID()] })).toEqual({ ok: true, itemId: null });
  expect(await shown(id)).toMatchObject({ status: "done", reply: { kind: "answer", cites: [item.id] } });
  // The first reply stands.
  await reply(run.id, { kind: "answer", text: "Something else", cites: [] });
  expect((await shown(id)).reply).toMatchObject({ text: "One post waits." });
});

test("a question or a cannot is stored as the reply and creates no Item", async () => {
  const count = async () => (await items.list(W, { offset: 0, limit: 500 })).items.length;
  const before = await count();
  const q = await posted("Move it");
  expect(await reply(q.run.id, { kind: "question", text: "Which post do you mean?" })).toEqual({ ok: true, itemId: null });
  const c = await posted("Send it now");
  expect(await reply(c.run.id, { kind: "cannot", text: "Direx never sends on its own." })).toEqual({ ok: true, itemId: null });
  expect(await count()).toBe(before);
  expect((await shown(q.id)).reply).toMatchObject({ kind: "question", text: "Which post do you mean?" });
});

test("a reply keeps what its run read, once each and only the reads that came back", async () => {
  const reads = [
    { kind: "tool_call", name: "read_schedule", outcome: "ok" },
    { kind: "tool_call", name: "read_schedule", outcome: "ok" },
    { kind: "tool_call", name: "read_needs_you", outcome: "ok" },
    { kind: "tool_call", name: "read_campaign", outcome: "failed:bad_input" },
    { kind: "tool_call", name: "propose", outcome: "ok" },
  ];
  const reading = createAsk({ agents: () => ({ ...agents, get: async (w, id) => (await agents.get(w, id)) && { ...(await agents.get(w, id))!, events: reads as never } }), items: () => items, nextSteps: () => undefined, facts: () => facts, now: () => world.clock.at });
  const { id, run } = await posted("What goes out this week?");
  await reading.sink(W, { kind: "ask_reply", outputKey: "reply", body: { kind: "answer", text: "Two posts.", cites: [] } }, { runId: run.id, tainted: false } as Parameters<Sink>[2]);
  expect((await shown(id)).reply).toEqual({ kind: "answer", text: "Two posts.", cites: [], looked: ["the schedule", "what needs you"] });
});

test("a next step becomes a card, and Ask says so only when the card exists", async () => {
  const step = { kind: "next_step", text: "Here is a card to draft the steps.", link: "plan_to_templates", campaignId: crypto.randomUUID() };
  const card = crypto.randomUUID();
  const made = await posted("Draft the steps");
  offered = { itemId: card };
  expect(await reply(made.run.id, step)).toEqual({ ok: true, itemId: card });
  expect((await shown(made.id)).reply).toMatchObject({ kind: "next_step", itemId: card });

  const none = await posted("Draft the steps again");
  offered = { why: "plan_not_approved" };
  await reply(none.run.id, step);
  expect((await shown(none.id)).reply).toEqual({ kind: "cannot", text: "That work can't start: the Campaign's plan isn't approved yet. No card was made." });
});

test("a named Agent that doesn't do the work gets cannot, naming who does, and nothing is rerouted", async () => {
  const { id, run } = await posted("Draft the steps", { agent: "social" });
  offered = { otherArea: "outreach" };
  await reply(run.id, { kind: "next_step", text: "Card.", link: "plan_to_templates", campaignId: crypto.randomUUID() });
  expect(asked.at(-1)).toMatchObject({ onlyArea: "social" });
  expect((await shown(id)).reply).toMatchObject({ kind: "cannot", text: expect.stringMatching(/^@social doesn't do that work; it belongs to outreach/) });
});

test("a fact becomes a Brand proposal from Ask, and Ask doesn't claim one for what Brand already says", async () => {
  const value = `We never discount ${crypto.randomUUID()}`;
  const { id, run } = await posted("We never discount");
  const r = await reply(run.id, { kind: "fact", text: "Here is a fact for Brand.", field: "claim", value }, true);
  if (!r.ok || !r.itemId) throw new Error("no fact Item");
  expect(await items.view(W, r.itemId)).toMatchObject({ state: "needs_approval" });
  expect((await shown(id)).reply).toMatchObject({ kind: "fact", itemId: r.itemId });
  const said = `Founded in 2019 ${crypto.randomUUID()}`;
  await facts.set(W, { field: "claim", value: said, source: { kind: "person", label: "Sam" }, confidence: "high", actor: person });
  const again = await posted("We were founded in 2019");
  await reply(again.run.id, { kind: "fact", text: "Again.", field: "claim", value: said });
  expect((await shown(again.id)).reply).toEqual({ kind: "cannot", text: "Brand already says that." });
});

test("a person reads only their own conversation, and can't attach an Item the Workspace doesn't hold", async () => {
  const mine = await posted("Mine");
  const other = crypto.randomUUID();
  expect((await ask.list(W, other)).map((m) => m.id)).not.toContain(mine.id);
  expect(await ask.post(W, me, { text: "About this", itemId: crypto.randomUUID() })).toEqual({ ok: false, reason: "not_found" });
});

test("an attached Item rides on the run as data with its revision as the target", async () => {
  const item = await newPost({ title: "Spring sale" });
  const { run } = await posted("Make it shorter", { itemId: item.id });
  expect(run.input).toMatchObject({ target: { id: item.id, draftRevision: item.revision }, attached: { id: item.id, text: expect.stringContaining("Spring sale") } });
});

test("every run is told the date and time in the Workspace's time zone, with its offset, as a trusted brief line", async () => {
  const { run } = await posted("When does the sale post go out?");
  const at = new Intl.DateTimeFormat("en-GB", { timeZone: "Europe/Berlin", weekday: "short", day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit", timeZoneName: "longOffset" }).format(world.clock.at);
  expect((run.input as { brief: unknown[] }).brief).toEqual([{ kind: "date", refId: "now", version: null, text: `Now is ${at}, in the Workspace's time zone, Europe/Berlin.` }]);
  expect(at).toMatch(/GMT\+0[12]:00$/);
});

test("a run that can't start leaves a reply saying so, and a reply for no message is refused", async () => {
  await agents.changeSettings(W, "ask", { enabled: false }, me);
  const r = await ask.post(W, me, { text: "Anyone there?" });
  if (!r.ok) throw new Error(r.reason);
  expect((await shown(r.id)).reply).toEqual({ kind: "cannot", text: "Ask can't run right now (disabled)." });
  await agents.changeSettings(W, "ask", { enabled: true }, me);
  expect(await reply(crypto.randomUUID(), { kind: "question", text: "Which one?" })).toEqual({ ok: false, code: "no_message" });
});

test("the screen the person has open rides before their words, written by Direx from its name", async () => {
  const campaignId = crypto.randomUUID();
  const onCampaign = await posted("Draft the text for this campaign", { looking: { screen: "campaigns", campaignId } });
  expect((onCampaign.run.input as { request: string }).request).toBe(`The person is looking at: the Campaign ${campaignId}.\n\nThe person's message:\nDraft the text for this campaign`);
  const onCalendar = await posted("What goes out here?", { looking: { screen: "calendar" } });
  expect((onCalendar.run.input as { request: string }).request).toMatch(/^The person is looking at: the Calendar\.\n\nThe person's message:/);
  // Removed from the panel, or sent from Home: no line at all.
  const plain = await posted("What goes out this week?");
  expect((plain.run.input as { request: string }).request).toBe("The person's message:\nWhat goes out this week?");
  // Nothing the screen line holds is kept with the message.
  expect(await shown(onCampaign.id)).toMatchObject({ text: "Draft the text for this campaign", itemId: null, agent: null });
});

test("a move becomes a reschedule card; approving it moves the Item as the Calendar would, as the approver", async () => {
  const post = await newPost({ plannedAt: hours(24), title: "Spring post" });
  const to = hours(48);
  const { id, run } = await posted("Move the spring post to Thursday");
  const r = await reply(run.id, { kind: "reschedule", text: "Here is a card to move it.", itemId: post.id, at: to.toISOString() }, true);
  if (!r.ok || !r.itemId) throw new Error("no reschedule card");
  const card = (await items.view(W, r.itemId))!;
  // The card proposes a time; it has none of its own, so the Calendar and schedule never show it as going out.
  expect(card.at).toBeNull();
  expect(card).toMatchObject({ kind: "reschedule", state: "needs_approval", warnings: [expect.objectContaining({ code: "untrusted_source" })] });
  // The card names the time in the Workspace's zone, as the Calendar shows it.
  expect(card.title).toContain(new Intl.DateTimeFormat("en-GB", { timeZone: "Europe/Berlin", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", timeZoneName: "short" }).format(to));
  expect((await shown(id)).reply).toMatchObject({ kind: "reschedule", itemId: card.id });
  expect(await items.approve(W, card.id, card.revision, who)).toMatchObject({ ok: true });
  expect((await items.view(W, post.id))!.at).toEqual(to);
  expect((await items.view(W, card.id))!.state).toBe("applied");
});

test("an approved move can be undone while the Item is still where it put it, as a Calendar move", async () => {
  const mayAll = { userId: me, may: () => true };
  const card = async (target: string, at: Date) => {
    const { run } = await posted("Move it");
    const r = await reply(run.id, { kind: "reschedule", text: "Card.", itemId: target, at: at.toISOString() });
    if (!r.ok || !r.itemId) throw new Error("no reschedule card");
    const c = (await items.view(W, r.itemId))!;
    expect(await items.approve(W, c.id, c.revision, who)).toMatchObject({ ok: true });
    return c.id;
  };
  const post = await newPost({ plannedAt: hours(24), title: "Undo post" });
  const moved = await card(post.id, hours(48));
  expect((await items.detail(W, moved))!.undo).toEqual({ ok: true });
  // A move Undo takes the Calendar's permission, so someone who can't edit gets no Undo.
  expect(await items.undo(W, moved, { userId: me, may: (p) => p !== "item.edit" })).toMatchObject({ ok: false, reason: "forbidden" });
  expect(await items.undo(W, moved, mayAll)).toMatchObject({ ok: true, item: { state: "applied" } });
  expect((await items.view(W, post.id))!.at).toEqual(hours(24));
  const shown = (await items.detail(W, moved))!;
  expect(shown.timeline.at(-1)).toMatchObject({ reason: "Undone", actor: { kind: "person", id: me } });
  // Back where it was, so the card's move no longer stands and there is nothing left to undo.
  expect(shown.undo).toEqual({ ok: false, reason: "moved_since" });

  // Moved again by someone since: undoing would overwrite their move.
  const again = await card(post.id, hours(72));
  expect(await items.moveItem(W, post.id, hours(96), { userId: me })).toMatchObject({ ok: true });
  expect(await items.undo(W, again, mayAll)).toMatchObject({ ok: false, reason: "moved_since" });
  expect((await items.view(W, post.id))!.at).toEqual(hours(96));

  // It had no time before, so there is no time to go back to.
  const unplanned = await newPost({ plannedAt: null });
  expect((await items.detail(W, await card(unplanned.id, hours(30))))!.undo).toEqual({ ok: false, reason: "no_old_time" });
});

test("a move to a past time, of an Item that isn't there, is refused before any card", async () => {
  const post = await newPost({ plannedAt: hours(24) });
  const past = await posted("Move it to yesterday");
  await reply(past.run.id, { kind: "reschedule", text: "Card.", itemId: post.id, at: hours(-24).toISOString() });
  expect((await shown(past.id)).reply).toEqual({ kind: "cannot", text: "That time has already passed, so nothing was proposed." });
  const gone = await posted("Move the other one");
  await reply(gone.run.id, { kind: "reschedule", text: "Card.", itemId: crypto.randomUUID(), at: hours(48).toISOString() });
  expect((await shown(gone.id)).reply).toEqual({ kind: "cannot", text: "That Item isn't there, so nothing was proposed." });
});

test("a rewrite works only on the Item the person asked about, and says so when its email can't be rewritten", async () => {
  const loose = await posted("Make it shorter");
  await reply(loose.run.id, { kind: "rewrite", text: "Rewriting.", instruction: "Shorter" });
  expect((await shown(loose.id)).reply).toEqual({ kind: "cannot", text: "Open Ask from the email you want rewritten, then ask again." });

  const post = await newPost({ title: "Spring email" });
  const asked = await posted("Make it shorter", { itemId: post.id });
  rewrite = { ok: true, runId: crypto.randomUUID() };
  expect(await reply(asked.run.id, { kind: "rewrite", text: "A shorter version will wait for your approval.", instruction: "Shorter" })).toEqual({ ok: true, itemId: post.id });
  expect(rewrites.at(-1)).toMatchObject({ itemId: post.id, instruction: "Shorter", userId: me, tainted: false });
  // The words before the rewrite are kept on the reply, so the card can show what changed once it lands.
  expect((await shown(asked.id)).reply).toMatchObject({ kind: "rewrite", itemId: post.id, before: { text: "hello" } });

  const templated = await posted("Make it shorter", { itemId: post.id });
  rewrite = { ok: false, reason: "from_template" };
  await reply(templated.run.id, { kind: "rewrite", text: "Rewriting.", instruction: "Shorter" });
  expect((await shown(templated.id)).reply).toEqual({ kind: "cannot", text: "This email comes from its step's text, so edit that text on the Campaign instead." });

  // A rewrite asked for by a run that read untrusted text starts its run tainted too.
  const untrusted = await posted("Make it shorter", { itemId: post.id });
  rewrite = { ok: true, runId: crypto.randomUUID() };
  await reply(untrusted.run.id, { kind: "rewrite", text: "A shorter version will wait for your approval.", instruction: "Shorter" }, true);
  expect(rewrites.at(-1)).toMatchObject({ itemId: post.id, tainted: true });

  const named = await posted("Make it shorter", { itemId: post.id, agent: "outreach" });
  await reply(named.run.id, { kind: "rewrite", text: "Rewriting.", instruction: "Shorter" });
  expect((await shown(named.id)).reply).toMatchObject({ kind: "cannot", text: expect.stringMatching(/^@outreach doesn't write this/) });
});

test("until its evals pass, a message is kept with a reply saying Ask is off, and no run starts", async () => {
  const off = createAsk({ agents: () => agents, items: () => items, nextSteps: () => undefined, facts: () => facts, now: () => world.clock.at, ready: () => false });
  const before = (await agents.list(W)).length;
  const r = await off.post(W, me, { text: "What goes out this week?" });
  if (!r.ok) throw new Error(r.reason);
  expect((await off.list(W, me)).find((m) => m.id === r.id)).toMatchObject({ status: "done", reply: { kind: "cannot", text: "Ask is off until Direx finishes checking it on the model it would use. The rest of Direx works as usual." } });
  expect((await agents.list(W)).length).toBe(before);
  // And the panel can say so before anyone types.
  expect(off.on()).toBe(false);
  expect(ask.on()).toBe(true);
});

test("a follow-up carries the last few answered exchanges, recent ones only, cut short", async () => {
  const at = world.clock.at.getTime();
  const row = (text: string, minutesAgo: number, reply: unknown) => ({ id: crypto.randomUUID(), workspaceId: W, userId: me, text, itemId: null, agent: null, runId: null, reply, createdAt: new Date(at - minutesAgo * 60_000), seq: 0 });
  const h = historyOf(
    [
      row("Long ago", 60 * 24, { kind: "answer", text: "Old", cites: [] }),
      row("Move the spring post", 5, { kind: "question", text: "Which post do you mean?" }),
      row("Still working", 1, null),
      row("x".repeat(900), 1, { kind: "cannot", text: "No." }),
    ],
    world.clock.at,
  );
  expect(h).toContain("Person: Move the spring post\nAsk (question): Which post do you mean?");
  expect(h).not.toContain("Long ago");
  expect(h).not.toContain("Still working");
  expect(h).toContain(`Person: ${"x".repeat(500)}\nAsk (cannot): No.`);
  expect(historyOf([], world.clock.at)).toBeNull();

  // And the run gets it: the earlier question and its answer ride with the next message.
  const first = await posted("Move the spring post");
  await reply(first.run.id, { kind: "question", text: "Which post do you mean?" });
  const next = await posted("The one on Friday");
  expect((next.run.input as { history?: string }).history).toContain("Ask (question): Which post do you mean?");
});

test("the runs of one agent list on their own, so Ask's runs don't crowd out the Brand page's reads", async () => {
  await posted("One more question");
  expect((await agents.list(W, "ask")).length).toBeGreaterThan(0);
  expect(await agents.list(W, "brand_reader")).toEqual([]);
  expect((await agents.list(W)).length).toBeGreaterThan(0);
});

const PLAN = "00000000-0000-4000-8000-0000000000a1";
const doneLine = async (id: string) => {
  const m = await shown(id);
  return m.status === "done" ? m.done : undefined;
};
const startReplyOf = async (text: string, body: Record<string, unknown>, extra: { agent?: string } = {}, tainted = false) => {
  const m = await posted(text, extra);
  await reply(m.run.id, { kind: "start", text: "Here is a card to start it.", ...body }, tainted);
  return { id: m.id, stored: (await shown(m.id)).reply as { kind: string; text: string; itemId?: string } };
};

test("a start becomes an ask_start Item for its own Agent, and every reason it can't start is cannot with no Item", async () => {
  basis = "b1";
  refuse = null;
  const made = await startReplyOf("Draft the Spring plan", { start: "draft_plan", args: { planId: PLAN } });
  expect(made.stored).toMatchObject({ kind: "start", itemId: expect.any(String) });
  const item = (await items.detail(W, made.stored.itemId!))!;
  expect(item.item).toMatchObject({ kind: "ask_start", title: "Do draft_plan", state: "needs_approval" });
  expect(item.content).toEqual({ start: "draft_plan", args: { planId: PLAN }, basis: "b1", tainted: false, messageId: made.id });

  expect((await startReplyOf("Pick clips", { start: "pick_clips", args: { mediaId: PLAN } })).stored).toEqual({ kind: "cannot", text: "That work can't start: that work doesn't run on this server. No card was made." });
  expect((await startReplyOf("Draft it", { start: "draft_plan", args: { planId: "not-an-id" } })).stored.kind).toBe("cannot");
  expect((await startReplyOf("Draft it", { start: "draft_plan", args: { planId: PLAN } }, { agent: "social" })).stored.text).toBe("@social doesn't do that work, and no Agent does. Ask again without naming one.");
  expect((await startReplyOf("Brief it", { start: "write_brief", args: { page: "https://shop.test/", query: "audits" } }, { agent: "outreach" })).stored.text).toMatch(/^@outreach doesn't do that work; it belongs to seo\./);
  expect((await startReplyOf("Brief it", { start: "write_brief", args: { page: "https://shop.test/", query: "audits" } }, { agent: "seo" })).stored.kind).toBe("start");
  refuse = "no_strategy";
  expect((await startReplyOf("Draft it", { start: "draft_plan", args: { planId: PLAN } })).stored.text).toBe("That work can't start: there's no approved Strategy saying who the business is for yet. No card was made.");
  refuse = null;
  const tainted = await startReplyOf("Draft it", { start: "draft_plan", args: { planId: PLAN } }, {}, true);
  const warned = (await items.detail(W, tainted.stored.itemId!))!;
  expect(warned.item.warnings.map((w) => w.code)).toContain("untrusted_source");
  expect(warned.content).toMatchObject({ tainted: true });
});

test("accepting a start needs its button's permission and the same basis, records it and queues one job, never by grant or in bulk", async () => {
  basis = "b1";
  refuse = null;
  const made = await startReplyOf("Draft the Spring plan", { start: "draft_plan", args: { planId: PLAN } });
  const id = made.stored.itemId!;
  const asRole = (role: "contributor" | "viewer") => ({ ...who, may: (p: string) => can(role, p as "item.edit") });
  expect(await items.approve(W, id, 1, asRole("viewer"))).toEqual({ ok: false, reason: "forbidden" });
  expect(await items.applyByGrant(W, id, { userId: person.userId, as: "advance" })).toEqual({ ok: false, reason: "forbidden" });
  expect(await items.approveClean(W, [{ id, revision: 1 }], who)).toEqual([{ id, result: { ok: false, reason: "one_at_a_time" } }]);
  basis = "b2";
  expect(await items.approve(W, id, 1, asRole("contributor"))).toEqual({ ok: false, reason: "moved_on" });
  expect(jobs).toHaveLength(0);
  basis = "b1";
  // A Contributor may press the plan's own draft button, so they may accept the same work here.
  expect((await items.approve(W, id, 1, asRole("contributor"))).ok).toBe(true);
  expect(jobs).toEqual([{ workspaceId: W, itemId: id, userId: person.userId }]);
  const db = await appClient();
  await db.query("select set_config('app.workspace_id', $1, false)", [W]);
  expect((await db.query("select message_id, work_kind, refused from ask_starts where item_id = $1", [id])).rows).toEqual([{ message_id: made.id, work_kind: null, refused: null }]);
  await db.end();
  expect((await doneLine(made.id))).toEqual({ state: "running", text: "Working on it.", itemIds: [] });
});

test("the start job runs the owner's start once with the Item as its key, and the done line says only what records say", async () => {
  basis = "b1";
  refuse = null;
  const run = askStartJob({ starts: () => starts, items: () => items });
  const accept = async (tainted = false) => {
    const made = await startReplyOf("Draft the Spring plan", { start: "draft_plan", args: { planId: PLAN } }, {}, tainted);
    const id = made.stored.itemId!;
    expect((await items.approve(W, id, 1, who)).ok).toBe(true);
    return { messageId: made.id, itemId: id, job: { workspaceId: W, itemId: id, userId: person.userId } };
  };

  const a = await accept(true);
  calls.length = 0;
  startReply = { ok: true, work: { kind: "agent_run", id: "run-1" } };
  await run(a.job, false);
  await run(a.job, false);
  expect(calls).toEqual([{ start: "draft_plan", args: { planId: PLAN }, by: { userId: person.userId, key: a.itemId, tainted: true } }]);
  report = { state: "running", itemIds: [] };
  expect((await doneLine(a.messageId))).toEqual({ state: "running", text: "Working on it.", itemIds: [] });
  const made = crypto.randomUUID();
  report = { state: "done", itemIds: [made] };
  expect((await doneLine(a.messageId))).toEqual({ state: "done", text: "Done.", itemIds: [made] });
  report = { state: "failed", itemIds: [] };
  expect((await doneLine(a.messageId))).toEqual({ state: "failed", text: "It stopped before it finished.", itemIds: [] });

  const b = await accept();
  startReply = { ok: false, why: "not_a_candidate" };
  await run(b.job, false);
  expect((await doneLine(b.messageId))).toEqual({ state: "refused", text: "It didn't start: that page and search aren't worth a brief now.", itemIds: [] });

  const c = await accept();
  throws = true;
  await expect(run(c.job, false)).rejects.toThrow("start blew up");
  await run(c.job, true);
  throws = false;
  expect((await doneLine(c.messageId))).toEqual({ state: "refused", text: "It didn't start: it failed to start.", itemIds: [] });
  startReply = { ok: true, work: { kind: "agent_run", id: "run-1" } };
  report = { state: "running", itemIds: [] };
});
