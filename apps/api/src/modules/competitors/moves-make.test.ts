// SPDX-License-Identifier: AGPL-3.0-only
// Counter-moves against the test database: labels stored, then one Item per event, with no model.
import { expect, test } from "vitest";
import { createFacts, factKinds } from "../facts/index";
import { itemsWorld, person } from "../items/fixtures/items";
import { pageParts } from "../seo/index";
import { competitorKinds, createCompetitors, createLabels, createMoves, createSnapshots, type ReadPage } from "./index";

type Read = Awaited<ReturnType<ReadPage>>;
const clock = { at: new Date("2026-11-09T07:00:00Z") };
const nextWeek = () => (clock.at = new Date(clock.at.getTime() + 7 * 86_400_000));
const pages = new Map<string, Read>();
const serve = (url: string, html: string) => pages.set(url, { ok: true, url, finalUrl: url, ...pageParts(html), html, text: "", truncated: false, readAt: clock.at });
const readPage: ReadPage = async (url) => pages.get(url) ?? { ok: false, reason: "failed" };
const log = (...lines: string[]) => `<article>${lines.map((l) => `<p>${l}</p>`).join("")}</article>`;
const LOG = "https://double.example/changelog";
const PRICE = "https://double.example/pricing";
const HOME = "https://double.example/";

const world = await itemsWorld({ kinds: { ...factKinds(), ...competitorKinds() } });
const { W, items, who } = world;
const facts = createFacts({ items: () => items });
const moves = createMoves({ facts: () => facts, items: () => items, now: () => clock.at });
const labels = createLabels({ now: () => clock.at, moves: () => moves });
const snapshots = createSnapshots({ readPage, now: () => clock.at });
const competitors = createCompetitors({ readPage: async () => ({ ok: false, reason: "failed" }) });

type Kind = "fact_update" | "comparison_page" | "post";
const answer = (changeId: string, kind: Kind, sameAs: string | null = null) => ({ changeId, label: "answer" as const, kind, sameAs, reason: `Worth a ${kind}` });
const noise = (changeId: string) => ({ changeId, label: "noise" as const, kind: null, sameAs: null, reason: "Noise" });
const changes = async () => (await labels.pending(W, clock.at)).changes;
const lineOf = (c: Awaited<ReturnType<typeof changes>>[number]) => ("added" in c.detail ? c.detail.added[0] : "part" in c.detail ? c.detail.after : "rewritten");

test("one Item per event: a Fact proposal, a counter-move joined by its sightings, nothing for noise; a decided one takes no more", async () => {
  const added = await competitors.add(W, person.userId, { name: "Double", changelogUrl: LOG, pricingUrl: PRICE, landingUrl: HOME });
  if (!added.ok) throw new Error(added.reason);
  const double = added.competitor.id;
  serve(LOG, log("Teams connection"));
  serve(PRICE, "<h2>Core</h2><p>$10 per client</p>");
  serve(HOME, "<h1>Close faster</h1>");
  await snapshots.readWorkspace(W);

  // Week 2: A3 on the changelog, A6 on pricing, and D1's headline as a sighting of A3.
  nextWeek();
  serve(LOG, log("Autoclose: AI agents reconcile accounts", "Teams connection"));
  serve(PRICE, "<h2>Core</h2><p>$10 per client</p><h2>Enterprise</h2>");
  serve(HOME, "<h1>Your fully automated close is here.</h1>");
  await snapshots.readWorkspace(W);
  const week2 = await changes();
  const by = (line: string) => week2.find((c) => lineOf(c) === line)!.id;
  const [autoclose, enterprise, headline] = [by("Autoclose: AI agents reconcile accounts"), by("Enterprise"), by("Your fully automated close is here.")];

  // A failure making counter-moves keeps the labels; the next make() does the work.
  const failing = createLabels({ now: () => clock.at, moves: () => ({ make: async () => Promise.reject(new Error("down")) }) });
  expect(await failing.store(W, null, clock.at, [answer(autoclose, "comparison_page"), answer(enterprise, "fact_update"), answer(headline, "comparison_page", autoclose)])).toEqual({ ok: true, written: 3 });
  expect(await moves.make(W)).toEqual({ created: 2, joined: 1 });
  expect(await moves.make(W)).toEqual({ created: 0, joined: 0 });

  const itemOf = async (id: string) => (await snapshots.recentChanges(W, double)).find((c) => c.id === id)!.itemId!;
  const moveId = await itemOf(autoclose);
  expect(await itemOf(headline)).toBe(moveId);
  const move = (await items.detail(W, moveId))!;
  expect(move.item).toMatchObject({ kind: "competitor_move", state: "needs_approval", title: "Update your Double comparison page", workArea: "Brand", groupKey: `competitor_move:${autoclose}` });
  expect(move.content).toMatchObject({
    move: "comparison_page",
    competitor: { id: double, name: "Double" },
    target: null,
    reason: "Worth a comparison_page",
    brief: null,
    sightings: [
      { changeId: autoclose, source: "changelog", lines: ["Autoclose: AI agents reconcile accounts"], after: { url: LOG } },
      { changeId: headline, source: "landing", lines: ["headline: Your fully automated close is here."] },
    ],
  });

  const fact = (await items.detail(W, await itemOf(enterprise)))!;
  expect(fact.item.kind).toBe("fact_proposal");
  expect(fact.content).toMatchObject({ field: "competitor", value: "pricing page, read 16 Nov 2026: Enterprise", source: { kind: "website", label: "Double pricing page", url: PRICE } });

  // Week 3: B4 while A3's counter-move waits joins it; a noise Change makes nothing.
  nextWeek();
  serve(LOG, log("Match and split bank-feed transactions with Ask Double", "Autoclose: AI agents reconcile accounts", "Teams connection"));
  serve(HOME, "<h1>Your fully automated close is here, today.</h1>");
  await snapshots.readWorkspace(W);
  const week3 = await changes();
  const split = week3.find((c) => c.source === "changelog")!.id;
  const tweak = week3.find((c) => c.source === "landing")!.id;
  expect(await labels.store(W, null, clock.at, [answer(split, "comparison_page", autoclose), noise(tweak)])).toEqual({ ok: true, written: 2 });
  expect(await itemOf(split)).toBe(moveId);
  expect(await itemOf(tweak)).toBeNull();
  const joined = (await items.detail(W, moveId))!;
  expect((joined.content as { sightings: unknown[] }).sightings).toHaveLength(3);
  expect(joined.item.revision).toBeGreaterThan(move.item.revision);

  // Approving records the move; no Action, nothing sent.
  expect(await items.approve(W, moveId, joined.item.revision, who)).toMatchObject({ ok: true, item: { state: "applied" } });
  const decided = (await items.detail(W, moveId))!;
  expect(await items.actionIdOf(W, moveId)).toBeNull();

  // Week 4: another sighting of the decided event links to it and changes nothing.
  nextWeek();
  serve(LOG, log("Autoclose now in every plan", "Match and split bank-feed transactions with Ask Double", "Autoclose: AI agents reconcile accounts", "Teams connection"));
  await snapshots.readWorkspace(W);
  const [later] = await changes();
  expect(await labels.store(W, null, clock.at, [answer(later!.id, "comparison_page", split)])).toEqual({ ok: true, written: 1 });
  expect(await itemOf(later!.id)).toBe(moveId);
  const after = (await items.detail(W, moveId))!;
  expect(after.item).toMatchObject({ state: "applied", revision: decided.item.revision });
  expect((after.content as { sightings: unknown[] }).sightings).toHaveLength(3);
});
