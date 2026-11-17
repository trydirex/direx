// SPDX-License-Identifier: AGPL-3.0-only
// Agent lessons end to end, through the module's entry point, a real items module and real agent runs:
// proposing, accepting with step-up, the budget, retiring and rewriting at a version, turning one into
// a Fact. What a run carries is tested in the agents module, beside the runs.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, expect, test } from "vitest";
import { appClient } from "../../../../../test/db";
import { createFacts, factKinds } from "../facts/index";
import { itemsWorld, person } from "../items/fixtures/items";
import type { Items } from "../items/index";
import type { Models } from "../models/index";
import { lessonCheckOpen } from "./application/check";
import { createLessons, LESSON_BUDGET_CHARS, LESSON_FACT_KIND, LESSON_PROPOSAL_KIND, LESSONS_CHANGED } from "./index";

type Answer = { verdict: "clean" | "refused"; reasons: string[] } | "fails";
const state: { open: boolean; answer: Answer } = { open: true, answer: { verdict: "clean", reasons: [] } };
const generate = (async () =>
  state.answer === "fails"
    ? { ok: false, callId: null, refusal: "no_connection" }
    : { ok: true, callId: crypto.randomUUID(), routeHash: "r", output: { schemaVersion: 1, ...state.answer } }) as unknown as Models["generate"];
const suspended: { agent: string; reason: string }[] = [];
const warned: string[][] = [];
const late: { items?: Items } = {};
const now = () => new Date();
const lessons = createLessons({
  items: () => late.items!,
  generate: () => generate,
  checkOpen: () => state.open,
  suspendRules: async (_tx, agent, reason) => {
    suspended.push({ agent, reason });
    return 1;
  },
  warnDrafts: async (_ws, runIds) => void warned.push([...runIds]),
  applyFact: factKinds(now).fact_proposal!.apply,
  liveFacts: (workspaceId) => createFacts({ items: () => late.items!, now }).list(workspaceId),
  now,
});
const w = await itemsWorld({ kinds: lessons.kinds() });
// A second Workspace, made here so its job queue is stopped with the file.
const other = await itemsWorld({ kinds: {} });
late.items = w.items;
const { W, items } = w;
const who = { ...w.who, steppedUp: true };
const userId = person.userId;

let c: Awaited<ReturnType<typeof appClient>>;
beforeAll(async () => {
  c = await appClient();
  await c.query("select set_config('app.workspace_id', $1, false)", [W]);
});
afterAll(async () => {
  await c.end();
});

const propose = async (text: string, agent = "recipient_writer") => {
  const r = await lessons.propose(W, { agent, text, sourceRef: "campaign:c/s/p", definitionVersion: 3, userId });
  if (!r.ok) throw new Error(r.reason);
  return r.item;
};
const accepted = async (text: string, agent = "recipient_writer") => {
  const item = await propose(text, agent);
  const r = await items.approve(W, item.id, item.revision, who);
  if (!r.ok) throw new Error(r.reason);
  return (await lessons.list(W, agent)).find((l) => l.text === text)!;
};
const reset = () => {
  state.open = true;
  state.answer = { verdict: "clean", reasons: [] };
};

test("a typed lesson waits as one Item, used for nothing until someone who may grant rules accepts it with step-up", async () => {
  reset();
  const item = await propose("  First emails here\nrun under 90 words. ");
  expect(item.state).toBe("needs_approval");
  expect(await lessons.list(W, "recipient_writer")).not.toContainEqual(expect.objectContaining({ text: "First emails here run under 90 words." }));

  expect(await items.approve(W, item.id, item.revision, w.who)).toEqual({ ok: false, reason: "step_up_required" });
  const marketer = { ...who, may: (p: string) => p !== "rule.grant" };
  expect(await items.approve(W, item.id, item.revision, marketer)).toEqual({ ok: false, reason: "forbidden" });
  expect((await items.approveClean(W, [{ id: item.id, revision: item.revision }], who))[0]!.result).toEqual({ ok: false, reason: "one_at_a_time" });
  // So "Approve all clean" never counts it.
  expect((await items.view(W, item.id))!.clean).toBe(false);
  expect((await items.list(W, { needsYou: true, offset: 0, limit: 500 })).items.find((i) => i.id === item.id)!.clean).toBe(false);

  suspended.length = 0;
  expect((await items.approve(W, item.id, item.revision, who)).ok).toBe(true);
  const live = (await lessons.list(W, "recipient_writer")).find((l) => l.text === "First emails here run under 90 words.")!;
  expect(live).toMatchObject({ version: 1, definitionVersion: 3 });
  expect(suspended).toEqual([{ agent: "recipient_writer", reason: LESSONS_CHANGED }]);
  const { rows } = await c.query("select op, item_id, permission, person_id from agent_lesson_events where item_id = $1 order by at", [item.id]);
  expect(rows).toEqual([
    { op: "propose", item_id: item.id, permission: "rule.grant", person_id: userId },
    { op: "accept", item_id: item.id, permission: "rule.grant", person_id: userId },
  ]);
});

test("the lesson check can refuse, can be unreachable, and until its eval is on file nothing can be proposed", async () => {
  reset();
  state.answer = { verdict: "refused", reasons: ["names_person"] };
  expect(await lessons.propose(W, { agent: "recipient_writer", text: "Dana at Acme hates long emails.", sourceRef: null, definitionVersion: null, userId })).toEqual({ ok: false, reason: "lesson_check_refused", reasons: ["names_person"] });
  state.answer = { verdict: "refused", reasons: [] };
  expect(await lessons.propose(W, { agent: "recipient_writer", text: "A refusal with no reason.", sourceRef: null, definitionVersion: null, userId })).toMatchObject({ reason: "lesson_check_unavailable" });
  state.answer = "fails";
  expect(await lessons.propose(W, { agent: "recipient_writer", text: "The check can't run.", sourceRef: null, definitionVersion: null, userId })).toMatchObject({ reason: "lesson_check_unavailable" });
  reset();
  state.open = false;
  expect(await lessons.propose(W, { agent: "recipient_writer", text: "No eval yet.", sourceRef: null, definitionVersion: null, userId })).toEqual({ ok: false, reason: "lesson_check_unevaluated" });
  expect(await lessons.propose(W, { agent: "recipient_writer", text: "   ", sourceRef: null, definitionVersion: null, userId })).toEqual({ ok: false, reason: "lesson_empty" });
  // The shipped result is for the subscription, so self-host is open; cloud asks on Direx's key, which
  // has no result yet. With no result recorded at all, both stay closed.
  expect(lessonCheckOpen("self_host")).toBe(true);
  expect(lessonCheckOpen("cloud")).toBe(false);
  const empty = mkdtempSync(join(tmpdir(), "lesson-results-"));
  expect(lessonCheckOpen("self_host", empty)).toBe(false);
  expect(lessonCheckOpen("cloud", empty)).toBe(false);
});

test("an acceptance past the budget is refused, and two at once can't both get in", async () => {
  reset();
  const agent = "campaign_drafter";
  const big = (ch: string) => ch.repeat(299) + ".";
  const full = Math.floor(LESSON_BUDGET_CHARS / 300);
  for (let i = 0; i < full - 1; i++) await accepted(big(String.fromCharCode(97 + i)), agent);
  const a = await propose(big("x"), agent);
  const b = await propose(big("y"), agent);
  const results = await Promise.all([items.approve(W, a.id, a.revision, who), items.approve(W, b.id, b.revision, who)]);
  expect(results.filter((r) => r.ok)).toHaveLength(1);
  expect(results.find((r) => !r.ok)).toEqual({ ok: false, reason: "lesson_budget_full" });
  expect((await lessons.list(W, agent)).reduce((n, l) => n + l.text.length, 0)).toBeLessThanOrEqual(LESSON_BUDGET_CHARS);
});

test("rewrite and retire bind the version read, and neither versions nor events can be changed", async () => {
  reset();
  const l = await accepted("Our posts sound plain and friendly.", "social_drafter");
  suspended.length = 0;
  expect(await lessons.rewrite(W, { lessonId: l.id, version: l.version, text: "Our posts sound plain, friendly and short.", userId })).toEqual({ ok: true, version: 2 });
  expect(await lessons.retire(W, { lessonId: l.id, version: 1, userId })).toEqual({ ok: false, reason: "target_changed" });
  expect(await lessons.rewrite(W, { lessonId: l.id, version: 1, text: "Too late.", userId })).toEqual({ ok: false, reason: "target_changed" });
  expect(await lessons.retire(W, { lessonId: crypto.randomUUID(), version: 1, userId })).toEqual({ ok: false, reason: "not_found" });
  expect(await lessons.retire(W, { lessonId: l.id, version: 2, userId })).toEqual({ ok: true });
  expect(suspended.map((s) => s.agent)).toEqual(["social_drafter", "social_drafter"]);
  expect((await lessons.list(W, "social_drafter")).some((x) => x.id === l.id)).toBe(false);
  await expect(c.query("update agent_lesson_versions set text = 'x' where lesson_id = $1", [l.id])).rejects.toThrow(/permission denied/);
  await expect(c.query("delete from agent_lesson_events where lesson_id = $1", [l.id])).rejects.toThrow(/permission denied/);
  await expect(c.query("delete from agent_lessons where id = $1", [l.id])).rejects.toThrow(/permission denied/);
});

test("a lesson turned into a Fact is cancelled when the Fact is accepted, and not before", async () => {
  reset();
  const l = await accepted("We never lead with price for enterprise accounts.", "recipient_writer");
  const r = await lessons.toFact(W, { lessonId: l.id, version: l.version, field: "never_say", sourceLabel: "Our sales lead", userId });
  if (!r.ok) throw new Error(r.reason);
  expect(r.item.kind).toBe(LESSON_FACT_KIND);
  expect((await lessons.list(W)).some((x) => x.id === l.id)).toBe(true);
  expect(await lessons.toFact(W, { lessonId: l.id, version: 9, field: "never_say", sourceLabel: "x", userId })).toEqual({ ok: false, reason: "target_changed" });
  expect((await items.approve(W, r.item.id, r.item.revision, who)).ok).toBe(true);
  expect((await lessons.list(W)).some((x) => x.id === l.id)).toBe(false);
  const { rows } = await c.query("select value from fact_versions where value = $1", [l.text]);
  expect(rows).toHaveLength(1);
  expect(await lessons.toFact(W, { lessonId: l.id, version: l.version, field: "never_say", sourceLabel: "x", userId })).toEqual({ ok: false, reason: "not_found" });
});

test("a Fact whose lesson moved first is refused and the lesson stays", async () => {
  reset();
  const l = await accepted("Newsletters open with one customer story.", "campaign_drafter");
  const r = await lessons.toFact(W, { lessonId: l.id, version: l.version, field: "tone", sourceLabel: "Editor", userId });
  if (!r.ok) throw new Error(r.reason);
  await lessons.rewrite(W, { lessonId: l.id, version: l.version, text: "Newsletters open with a customer story.", userId });
  expect(await items.approve(W, r.item.id, r.item.revision, who)).toEqual({ ok: false, reason: "target_changed" });
  expect((await lessons.list(W)).some((x) => x.id === l.id)).toBe(true);
});

test("a lesson can't be offered into a Brand slot that already holds a Fact", async () => {
  reset();
  const first = await accepted("Our voice is warm and plain.", "social_drafter");
  const r = await lessons.toFact(W, { lessonId: first.id, version: first.version, field: "tone", sourceLabel: "Editor", userId });
  if (!r.ok) throw new Error(r.reason);
  expect((await items.approve(W, r.item.id, r.item.revision, who)).ok).toBe(true);
  const second = await accepted("Our voice is dry and short.", "social_drafter");
  expect(await lessons.toFact(W, { lessonId: second.id, version: second.version, field: "tone", sourceLabel: "Editor", userId })).toEqual({ ok: false, reason: "fact_slot_filled" });
  expect((await lessons.list(W)).some((x) => x.id === second.id)).toBe(true);
});

test("another Workspace sees none of these lessons", async () => {
  expect(await lessons.list(other.W)).toEqual([]);
  expect((await lessons.list(W)).length).toBeGreaterThan(0);
  expect(LESSON_PROPOSAL_KIND).toBe("lesson_proposal");
});
