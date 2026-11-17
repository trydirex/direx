// SPDX-License-Identifier: AGPL-3.0-only
// The counter-post draft against the test database, with a fake agent start: who gets a run, what it is
// given, and which drafts reach the counter-move.
import { expect, test } from "vitest";
import { createFacts, factKinds } from "../facts/index";
import { itemsWorld, person } from "../items/fixtures/items";
import { pageParts } from "../seo/index";
import { competitorKinds, createCompetitors, createLabels, createMoves, createSnapshots, type ReadPage } from "./index";
import { REFUSED_NOTE, type PostInput } from "./application/moves";

type Read = Awaited<ReturnType<ReadPage>>;
const clock = { at: new Date("2026-11-09T07:00:00Z") };
const nextWeek = () => (clock.at = new Date(clock.at.getTime() + 7 * 86_400_000));
const pages = new Map<string, Read>();
const serve = (url: string, html: string) => pages.set(url, { ok: true, url, finalUrl: url, ...pageParts(html), html, text: pageParts(html).text, truncated: false, readAt: clock.at });
const readPage: ReadPage = async (url) => pages.get(url) ?? { ok: false, reason: "robots_disallowed" };
const log = (...lines: string[]) => `<article>${lines.map((l) => `<p>${l}</p>`).join("")}</article>`;

const world = await itemsWorld({ kinds: { ...factKinds(), ...competitorKinds() } });
const { W, items } = world;
const facts = createFacts({ items: () => items });
const started: { agent: string; input: PostInput }[] = [];
const answer = { current: "ok" as "ok" | "no_route" };
const moves = createMoves({
  facts: () => facts,
  items: () => items,
  now: () => clock.at,
  readPage,
  start: () => async (_ws, a) => (started.push({ agent: a.agent, input: a.input as PostInput }), answer.current === "ok" ? { ok: true as const, run: { id: crypto.randomUUID() } } : { ok: false as const, reason: "no_route" }),
});
const labels = createLabels({ now: () => clock.at, moves: () => moves });
const snapshots = createSnapshots({ readPage, now: () => clock.at });
const competitors = createCompetitors({ readPage: async () => ({ ok: false, reason: "failed" }) });

type Payload = { post: { text: string; facts: { id: string; text: string }[] } | null; postRunId: string | null; briefNote: string | null; brief: unknown };
const payloadOf = async (itemId: string) => (await items.detail(W, itemId))!.content as Payload;
const context = (runId: string, input: PostInput) => ({ runId, input, tainted: true, pagesRead: [], pages: [], producer: { agent: "counter_post", definitionVersion: 1, promptDigest: "d", routeHash: "r" } });
const draft = (body: object) => ({ kind: "draft", outputKey: "competitor_post", body: { schemaVersion: 1, text: "", theirs: [], citations: [], cantTell: null, steered: [], ...body } }) as never;
const add = async (name: string) => {
  const r = await competitors.add(W, person.userId, { name, changelogUrl: `https://${name.toLowerCase()}.example/log` });
  if (!r.ok) throw new Error(r.reason);
  return r.competitor.id;
};
/** Reads this week, then labels every new Change an answer for a post, sameAs `of` when given. */
const answerAll = async (of: Record<string, string> = {}) => {
  await snapshots.readWorkspace(W);
  const { changes } = await labels.pending(W, clock.at);
  const r = await labels.store(W, null, clock.at, changes.map((c) => ({ changeId: c.id, label: "answer" as const, kind: "post" as const, sameAs: of[c.competitor] ?? null, reason: "Parity headline" })));
  if (!r.ok) throw new Error(r.reason);
  return changes;
};
const itemFor = async (competitorId: string, changeId: string) => (await snapshots.recentChanges(W, competitorId)).find((c) => c.id === changeId)!.itemId!;

test("a post move gets one draft run; only a checked draft from the latest run reaches it, and a no-post gives its reason", async () => {
  const set = await facts.set(W, { field: "price", subject: "per company", value: "$15 per QuickBooks company per month", source: { kind: "person", label: "Sam" }, confidence: "high", actor: person });
  if (!set.ok) throw new Error("price");
  const price = (await facts.usableFacts(W)).find((f) => f.id === set.id)!;
  const xenett = await add("Xenett");
  serve("https://xenett.example/log", log("Old line"));
  await snapshots.readWorkspace(W);

  nextWeek();
  serve("https://xenett.example/log", log("GL Rec, All Clients: every account on one page", "Old line"));
  const [first] = await answerAll();
  const moveId = await itemFor(xenett, first!.id);
  expect(started).toHaveLength(1);
  const run = started[0]!;
  expect(run.agent).toBe("counter_post");
  expect(run.input.text).toContain('"GL Rec, All Clients: every account on one page"');
  expect(run.input.theirs).toEqual(["GL Rec, All Clients: every account on one page"]);
  const runId = (await payloadOf(moveId)).postRunId!;
  expect(runId).toEqual(expect.any(String));

  const good = { text: "Xenett puts every account on one page. Contoso does too, at $15 a company.", theirs: ["every account on one page"], citations: [{ factId: price.id, version: price.version }] };
  // A number nobody gave is refused, and the counter-move says a draft didn't pass.
  const refused = await moves.postSink(W, draft({ ...good, text: "Contoso does it for $12." }), context(runId, run.input));
  expect(refused).toMatchObject({ ok: false, code: expect.stringMatching(/^post_refused: "\$12"/) });
  expect((await payloadOf(moveId)).briefNote).toBe(REFUSED_NOTE);

  expect(await moves.postSink(W, draft(good), context(runId, run.input))).toEqual({ ok: true, itemId: moveId });
  expect(await payloadOf(moveId)).toMatchObject({ briefNote: null, brief: null, post: { text: good.text, facts: [{ id: price.id, text: "price (per company): $15 per QuickBooks company per month" }] } });
  // The same run again changes nothing.
  expect(await moves.postSink(W, draft({ cantTell: "x" }), context(runId, run.input))).toEqual({ ok: true, itemId: null });

  // Week 3: another sighting starts a fresh draft; the first run's late output is dropped.
  nextWeek();
  serve("https://xenett.example/log", log("GL Rec now flags stale reconciliations", "GL Rec, All Clients: every account on one page", "Old line"));
  await answerAll({ Xenett: first!.id });
  expect(started).toHaveLength(2);
  const again = await payloadOf(moveId);
  expect(again).toMatchObject({ post: null, briefNote: null });
  expect(again.postRunId).not.toBe(runId);
  expect(await moves.postSink(W, draft(good), context(runId, run.input))).toEqual({ ok: true, itemId: null });
  // A post of "" says why there's nothing worth posting, and that becomes the note.
  expect(await moves.postSink(W, draft({ cantTell: "A minor change; nothing to add." }), context(again.postRunId!, started[1]!.input))).toEqual({ ok: true, itemId: moveId });
  expect(await payloadOf(moveId)).toMatchObject({ post: { text: "" }, briefNote: "A minor change; nothing to add." });

  // Until the eval passes there's no route: a new counter-move holds the evidence only.
  answer.current = "no_route";
  const booke = await add("Booke");
  serve("https://booke.example/log", log("Old line"));
  await snapshots.readWorkspace(W);
  nextWeek();
  serve("https://booke.example/log", log("PDF statements import", "Old line"));
  const changes = await answerAll();
  const bookeItem = await itemFor(booke, changes.find((c) => c.competitor === "Booke")!.id);
  expect(await payloadOf(bookeItem)).toMatchObject({ post: null, postRunId: null, briefNote: null });

  expect(await moves.postSink(W, draft(good), { ...context(runId, run.input), input: { text: "x" } as never })).toEqual({ ok: false, code: "no_input" });
  expect(await moves.postSink(W, draft(good), context(runId, { ...run.input, itemId: set.id }))).toMatchObject({ ok: false });
});
