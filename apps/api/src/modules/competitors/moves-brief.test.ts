// SPDX-License-Identifier: AGPL-3.0-only
// The comparison-page draft against the test database, with a fake agent start: who gets a run, what
// it is given, and which drafts reach the counter-move.
import { expect, test } from "vitest";
import { createFacts, factKinds } from "../facts/index";
import { itemsWorld, person } from "../items/fixtures/items";
import { pageParts } from "../seo/index";
import { competitorKinds, createCompetitors, createLabels, createMoves, createSnapshots, type ReadPage } from "./index";
import { noPageNote, REFUSED_NOTE, type BriefInput } from "./application/moves";

type Read = Awaited<ReturnType<ReadPage>>;
const clock = { at: new Date("2026-11-09T07:00:00Z") };
const nextWeek = () => (clock.at = new Date(clock.at.getTime() + 7 * 86_400_000));
const pages = new Map<string, Read>();
const serve = (url: string, html: string) => pages.set(url, { ok: true, url, finalUrl: url, ...pageParts(html), html, text: pageParts(html).text, truncated: false, readAt: clock.at });
const readPage: ReadPage = async (url) => pages.get(url) ?? { ok: false, reason: "robots_disallowed" };
const log = (...lines: string[]) => `<article>${lines.map((l) => `<p>${l}</p>`).join("")}</article>`;
const VS = "https://contoso.example/vs-double";

const world = await itemsWorld({ kinds: { ...factKinds(), ...competitorKinds() } });
const { W, items, who } = world;
const facts = createFacts({ items: () => items });
const started: { agent: string; input: BriefInput }[] = [];
const answer = { current: "ok" as "ok" | "no_route" };
const moves = createMoves({
  facts: () => facts,
  items: () => items,
  now: () => clock.at,
  readPage,
  start: () => async (_ws, a) => (started.push({ agent: a.agent, input: a.input as BriefInput }), answer.current === "ok" ? { ok: true as const, run: { id: crypto.randomUUID() } } : { ok: false as const, reason: "no_route" }),
});
const labels = createLabels({ now: () => clock.at, moves: () => moves });
const snapshots = createSnapshots({ readPage, now: () => clock.at });
const competitors = createCompetitors({ readPage: async () => ({ ok: false, reason: "failed" }) });

type Payload = { brief: { edits: unknown[]; markdown: string } | null; briefRunId: string | null; briefNote: string | null; sightings: unknown[] };
const payloadOf = async (itemId: string) => (await items.detail(W, itemId))!.content as Payload;
const context = (runId: string, input: BriefInput) => ({ runId, input, tainted: true, pagesRead: [], pages: [], producer: { agent: "comparison_brief", definitionVersion: 1, promptDigest: "d", routeHash: "r" } });
const draft = (edits: object[]) => ({ kind: "draft", outputKey: "competitor_brief", body: { schemaVersion: 1, edits, cantTell: null, steered: [] } }) as never;
const add = async (name: string, urls: object) => {
  const r = await competitors.add(W, person.userId, { name, ...urls });
  if (!r.ok) throw new Error(r.reason);
  return r.competitor.id;
};
/** Reads this week, then labels every new Change an answer for a comparison page, sameAs `of` when given. */
const answerAll = async (of: Record<string, string> = {}) => {
  await snapshots.readWorkspace(W);
  const { changes } = await labels.pending(W, clock.at);
  const r = await labels.store(W, null, clock.at, changes.map((c) => ({ changeId: c.id, label: "answer" as const, kind: "comparison_page" as const, sameAs: of[c.competitor] ?? null, reason: "Price of reconciliation" })));
  if (!r.ok) throw new Error(r.reason);
  return changes;
};
const itemFor = async (competitorId: string, changeId: string) => (await snapshots.recentChanges(W, competitorId)).find((c) => c.id === changeId)!.itemId!;

test("a comparison page gets one draft run; only a draft that passes the checks reaches the counter-move, and only the latest run's", async () => {
  const price = await facts.set(W, { field: "price", subject: "per company", value: "$15 per QuickBooks company per month", source: { kind: "person", label: "Sam" }, confidence: "high", actor: person });
  if (!price.ok) throw new Error("price");
  const double = await add("Double", { changelogUrl: "https://double.example/log", comparisonUrl: VS });
  const xenett = await add("Xenett", { changelogUrl: "https://xenett.example/log" });
  const botkeeper = await add("Botkeeper", { changelogUrl: "https://botkeeper.example/log", comparisonUrl: "https://contoso.example/vs-botkeeper" });
  const known = await facts.propose(W, { field: "competitor", subject: "Double", value: "pricing page, read 9 Nov 2026: Scale $50 per client", source: { kind: "website", label: "Double pricing page" }, confidence: "high", actor: { system: "test" } });
  if (!known.ok || !known.item) throw new Error("fact");
  await items.approve(W, known.item.id, known.item.revision, who);
  serve(VS, "<title>Contoso vs Double</title><h2>Pricing</h2><p>Double charges $10 to $50 per client, and AI usage is extra.</p>");
  for (const u of ["https://double.example/log", "https://xenett.example/log", "https://botkeeper.example/log"]) serve(u, log("Old line"));
  await snapshots.readWorkspace(W);

  nextWeek();
  serve("https://double.example/log", log("Autoclose: $500/month firm-wide add-on", "Old line"));
  serve("https://xenett.example/log", log("GL Rec, All Clients", "Old line"));
  serve("https://botkeeper.example/log", log("Accounts Page beta", "Old line"));
  // Botkeeper's page can't be read; Xenett has none.
  answer.current = "ok";
  const week2 = await answerAll();
  const id = (name: string) => week2.find((c) => c.competitor === name)!.id;
  const [moveId, xenettId, botkeeperId] = [await itemFor(double, id("Double")), await itemFor(xenett, id("Xenett")), await itemFor(botkeeper, id("Botkeeper"))];

  expect(await payloadOf(xenettId)).toMatchObject({ briefNote: noPageNote("Xenett"), briefRunId: null });
  expect(await payloadOf(botkeeperId)).toMatchObject({ briefNote: "Couldn't read your comparison page: robots_disallowed", briefRunId: null });
  expect(started).toHaveLength(1);
  const run = started[0]!;
  expect(run.agent).toBe("comparison_brief");
  expect(run.input.text).toContain('"Autoclose: $500/month firm-wide add-on"');
  expect(run.input.text).toContain("On file about Double: pricing page, read 9 Nov 2026: Scale $50 per client");
  expect(run.input.text).toContain("Double charges $10 to $50 per client");
  expect(run.input.theirs).toEqual(["Autoclose: $500/month firm-wide add-on", "pricing page, read 9 Nov 2026: Scale $50 per client"]);
  const first = (await payloadOf(moveId)).briefRunId!;
  expect(first).toEqual(expect.any(String));

  // A number the edit doesn't cite is refused, and the counter-move says a draft didn't pass.
  const edit = { where: "Pricing", quote: "Double charges $10 to $50 per client", problem: "Misses the add-on.", fix: "Add a line.", newText: ["Autoclose is a $500/month add-on; Contoso is $15 per company."], theirs: ["$500/month firm-wide add-on"], ours: [price.id] };
  const refused = await moves.briefSink(W, draft([{ ...edit, newText: ["Autoclose is $450 a month."] }]), context(first, run.input));
  expect(refused).toMatchObject({ ok: false, code: expect.stringMatching(/^brief_refused: Pricing: "\$450"/) });
  expect((await payloadOf(moveId)).briefNote).toBe(REFUSED_NOTE);

  expect(await moves.briefSink(W, draft([edit]), context(first, run.input))).toEqual({ ok: true, itemId: moveId });
  const drafted = await payloadOf(moveId);
  expect(drafted).toMatchObject({ briefNote: null, brief: { edits: [edit] } });
  expect(drafted.brief!.markdown).toContain(VS);
  // The same run again changes nothing.
  expect(await moves.briefSink(W, draft([]), context(first, run.input))).toEqual({ ok: true, itemId: null });

  // Week 3: another sighting starts a fresh draft over both; the first run's late output is dropped.
  nextWeek();
  serve("https://double.example/log", log("Match and split with Ask Double", "Autoclose: $500/month firm-wide add-on", "Old line"));
  await answerAll({ Double: id("Double") });
  expect(started).toHaveLength(2);
  expect(started[1]!.input.theirs).toContain("Match and split with Ask Double");
  const second = await payloadOf(moveId);
  expect(second).toMatchObject({ brief: null, briefNote: null });
  expect(second.briefRunId).not.toBe(first);
  expect(await moves.briefSink(W, draft([edit]), context(first, run.input))).toEqual({ ok: true, itemId: null });
  expect((await payloadOf(moveId)).brief).toBeNull();
  expect(await moves.briefSink(W, draft([]), context(second.briefRunId!, started[1]!.input))).toEqual({ ok: true, itemId: moveId });
  expect((await payloadOf(moveId)).brief).toMatchObject({ edits: [] });

  // Until the eval passes there's no route: the counter-move stays evidence only, with no note.
  answer.current = "no_route";
  nextWeek();
  serve("https://botkeeper.example/log", log("Accounts Page GA", "Accounts Page beta", "Old line"));
  serve("https://contoso.example/vs-botkeeper", "<h2>Features</h2><p>Botkeeper has no accounts hub.</p>");
  const [ga] = await answerAll();
  expect(started).toHaveLength(3);
  const gaItem = await itemFor(botkeeper, ga!.id);
  expect(gaItem).not.toBe(botkeeperId);
  expect(await payloadOf(gaItem)).toMatchObject({ brief: null, briefRunId: null, briefNote: null });

  // A run for an Item that isn't a counter-move, or with no input, is refused.
  expect(await moves.briefSink(W, draft([]), context(first, { ...run.input, itemId: known.item.id }))).toEqual({ ok: false, code: "no_item" });
  expect(await moves.briefSink(W, draft([]), { ...context(first, run.input), input: { text: "x" } as never })).toEqual({ ok: false, code: "no_input" });
});
