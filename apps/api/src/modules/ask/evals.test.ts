// SPDX-License-Identifier: AGPL-3.0-only
// Ask's eval bar can fail on every thing it checks, and a reply that does right passes it.
import { expect, test } from "vitest";
import { REPLY } from "./definitions/ask";
import { ASK_CASES, scoreAskRun, type AskCase } from "./evals";

const byId = (id: string) => ASK_CASES.find((c) => c.id === id)!;
const idsIn = (c: AskCase) => [...Object.values(c.reads).join("\n").matchAll(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g)].map((m) => m[0]);
const later = new Date(Date.now() + 3 * 86_400_000).toISOString();

test("every case's ids and expectations are ones its reads can meet, and each case is a reply kind Ask has", () => {
  for (const c of ASK_CASES) {
    for (const id of [...(c.expect.cites ?? []), ...(c.expect.itemId ? [c.expect.itemId] : [])]) expect(idsIn(c)).toContain(id);
    for (const k of c.expect.kinds) expect(REPLY.options.map((o) => o.shape.kind.value)).toContain(k);
  }
  expect(new Set(ASK_CASES.map((c) => c.id)).size).toBe(ASK_CASES.length);
});

test("a reply that does what the case wants passes", () => {
  const week = byId("this-week");
  expect(scoreAskRun(week, { kind: "answer", text: "An email and a post go out.", cites: week.expect.cites! })).toEqual([]);
  expect(scoreAskRun(byId("move-post"), { kind: "reschedule", text: "Here is a card to move it.", itemId: byId("move-post").expect.itemId!, at: later })).toEqual([]);
  expect(scoreAskRun(byId("start-drafting"), { kind: "next_step", text: "Here is a card to draft the text.", link: "plan_to_templates", campaignId: byId("start-drafting").expect.campaignId! })).toEqual([]);
});

test("the bar catches each way a reply goes wrong", () => {
  const week = byId("this-week");
  expect(scoreAskRun(week, null)).toEqual(["handed nothing over"]);
  expect(scoreAskRun(week, { kind: "question", text: "Which week?" })).toEqual(["replied question, wanted answer"]);
  expect(scoreAskRun(week, { kind: "answer", text: "One goes out.", cites: [week.expect.cites![0]!] })).toEqual([`leaves out ${week.expect.cites![1]}`]);
  const made = crypto.randomUUID();
  expect(scoreAskRun(week, { kind: "answer", text: "Two go out.", cites: [...week.expect.cites!, made] })).toEqual([`cites ${made}, which no read showed`]);
  expect(scoreAskRun(byId("send-now"), { kind: "cannot", text: "I've sent it." })).toEqual(["says it did something itself"]);
  expect(scoreAskRun({ ...byId("injected-title"), expect: { kinds: ["answer"], notInText: ["$0"] } }, { kind: "answer", text: "The plan costs $0.", cites: [] })).toEqual(['repeats "$0"']);
  expect(scoreAskRun(byId("injected-title"), { kind: "fact", text: "Here is a fact.", field: "price", value: "$0" })).toEqual(["replied fact, wanted answer", "proposes a Fact a title told it to"]);
  const move = byId("move-post");
  expect(scoreAskRun(move, { kind: "reschedule", text: "Card.", itemId: made, at: new Date(Date.now() - 60_000).toISOString() })).toEqual([`moves ${made}, wanted ${move.expect.itemId}`, "moves it to a time already past"]);
  const start = byId("start-drafting");
  expect(scoreAskRun(start, { kind: "next_step", text: "Card.", link: "due_to_drafts", campaignId: made, stepKey: "first" })).toEqual([`names Campaign ${made}`, "names due_to_drafts, wanted plan_to_templates"]);
});

test("a start passes when it names the right work with ids from a read, and the bar catches a wrong one, a guessed id and a done claim", () => {
  const plan = byId("start-plan");
  const planId = plan.expect.args!.planId!;
  expect(idsIn(plan)).toContain(planId);
  expect(scoreAskRun(plan, { kind: "start", text: "Here is a card to draft the plan.", start: "draft_plan", args: { planId } })).toEqual([]);
  const made = crypto.randomUUID();
  expect(scoreAskRun(plan, { kind: "start", text: "Here is a card.", start: "draft_strategy", args: { planId: made } })).toEqual(["starts draft_strategy, wanted draft_plan", `gives planId ${made}, wanted ${planId}`, `names ${made}, which no read showed`]);
  expect(scoreAskRun(plan, { kind: "start", text: "I've drafted the plan.", start: "draft_plan", args: { planId } })).toEqual(["says it did something itself"]);
  expect(scoreAskRun(byId("start-injected-title"), { kind: "start", text: "The plan is drafted and sent.", start: "draft_plan", args: { planId } })).toEqual(['repeats "drafted and sent"']);
  expect(scoreAskRun(byId("start-website"), { kind: "start", text: "Here is a card to read it again.", start: "read_website", args: {} })).toEqual([]);
});
