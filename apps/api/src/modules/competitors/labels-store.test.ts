// SPDX-License-Identifier: AGPL-3.0-only
// What a classifier run is given and how its labels are stored, against the test database. The run
// itself is not here: these are the two ends the agent's sink will call.
import { expect, test } from "vitest";
import { pageParts } from "../seo/index";
import { TEST_SECRET, testIdentity } from "../identity/test-auth";
import { createCompetitors, createLabels, createSnapshots, type ReadPage } from "./index";

process.env.DIREX_AUTH_SECRET = TEST_SECRET;
type Read = Awaited<ReturnType<ReadPage>>;
const clock = { at: new Date("2026-11-09T07:00:00Z") };
const nextWeek = () => (clock.at = new Date(clock.at.getTime() + 7 * 86_400_000));
const pages = new Map<string, Read>();
const serve = (url: string, html: string) => pages.set(url, { ok: true, url, finalUrl: url, ...pageParts(html), html, text: "", truncated: false, readAt: clock.at });
const readPage: ReadPage = async (url) => pages.get(url) ?? { ok: false, reason: "failed" };
const snapshots = createSnapshots({ readPage, now: () => clock.at });
const labels = createLabels({ now: () => clock.at });
const competitors = createCompetitors({ readPage: async () => ({ ok: false, reason: "failed" }) });

const { signIn, createOrg, call } = testIdentity();
async function workspace(name: string) {
  const cookie = await signIn();
  const W = (await createOrg(cookie, name)).workspace.id;
  const userId = ((await (await call("/api/me", cookie)).json()) as { user: { id: string } }).user.id;
  return { W, userId };
}
const log = (...lines: string[]) => `<article>${lines.map((l) => `<p>${l}</p>`).join("")}</article>`;
const LOG = "https://double.example/changelog";
const HOME = "https://xenett.example/";

test("a run is given the unlabelled Changes and earlier answers; its labels are stored once, and only if they fit", async () => {
  const { W, userId } = await workspace("Contoso");
  const add = async (name: string, urls: object) => {
    const r = await competitors.add(W, userId, { name, ...urls });
    if (!r.ok) throw new Error(r.reason);
    return r.competitor.id;
  };
  const double = await add("Double", { changelogUrl: LOG });
  const xenett = await add("Xenett", { landingUrl: HOME });
  serve(LOG, log("Teams connection"));
  serve(HOME, "<h1>Close faster</h1>");
  await snapshots.readWorkspace(W);
  expect(await labels.pending(W)).toEqual({ changes: [], earlier: [] });

  nextWeek();
  serve(LOG, log("Autoclose: AI agents reconcile accounts", "Teams connection"));
  serve(HOME, "<h1>Practice management with the close built in</h1>");
  await snapshots.readWorkspace(W);
  const runAt = clock.at;
  const week2 = await labels.pending(W, runAt);
  // Both come from one read, so they share a time; their order between them is the ids'.
  const byName = (name: string) => week2.changes.find((c) => c.competitor === name)!;
  expect(week2.changes.map((c) => `${c.competitor} ${c.source}`).sort()).toEqual(["Double changelog", "Xenett landing"]);
  expect(byName("Double").detail).toEqual({ added: ["Autoclose: AI agents reconcile accounts"] });
  const [autoclose, headline] = [byName("Double").id, byName("Xenett").id];

  // A Change made after the run started waits for the next run.
  expect((await labels.pending(W, new Date(runAt.getTime() - 1))).changes).toEqual([]);

  const good = [
    { changeId: autoclose, label: "answer" as const, kind: "comparison_page" as const, sameAs: null, reason: "Autoclose prices reconciliation" },
    { changeId: headline, label: "noise" as const, kind: null, sameAs: null, reason: "Positioning reworded" },
  ];
  expect(await labels.store(W, null, runAt, [good[0]!])).toEqual({ ok: false, reason: `no label for ${headline}` });
  expect((await labels.pending(W, runAt)).changes).toHaveLength(2);
  expect(await labels.store(W, null, runAt, good)).toEqual({ ok: true, written: 2 });
  expect(await labels.store(W, null, runAt, good)).toEqual({ ok: false, reason: `labelled ${autoclose}, which it wasn't given` });

  // Another Workspace can't label these.
  const other = await workspace("Other");
  expect(await labels.store(other.W, null, runAt, good)).toEqual({ ok: false, reason: `labelled ${autoclose}, which it wasn't given` });

  nextWeek();
  serve(LOG, log("Match and split bank-feed transactions with Ask Double", "Autoclose: AI agents reconcile accounts", "Teams connection"));
  await snapshots.readWorkspace(W);
  const week3 = await labels.pending(W);
  expect(week3.earlier.map((a) => [a.id, a.competitorId, a.kind, a.reason])).toEqual([[autoclose, double, "comparison_page", "Autoclose prices reconciliation"]]);
  const [split] = week3.changes.map((c) => c.id) as [string];
  const sighting = { changeId: split, label: "answer" as const, kind: "comparison_page" as const, sameAs: autoclose, reason: "Part of Autoclose (D2)" };
  expect(await labels.store(W, null, clock.at, [{ ...sighting, sameAs: headline }])).toMatchObject({ ok: false });
  expect(await labels.store(W, crypto.randomUUID(), clock.at, [sighting])).toEqual({ ok: true, written: 1 });

  const shown = await snapshots.recentChanges(W, double);
  expect(shown.map((c) => [c.label, c.kind, c.sameAsChangeId])).toEqual([
    ["answer", "comparison_page", autoclose],
    ["answer", "comparison_page", null],
  ]);
  expect((await snapshots.recentChanges(W, xenett)).map((c) => c.label)).toEqual(["noise"]);
});

test("after the weekly read a run starts only for new Changes; the sink stores its labels once and refuses ones that don't fit", async () => {
  const { W, userId } = await workspace("Contoso");
  const r = await competitors.add(W, userId, { name: "Double", changelogUrl: "https://double.example/log" });
  if (!r.ok) throw new Error(r.reason);
  const started: { workspaceId: string; agent: string; input: { text: string; asOf: string } }[] = [];
  const answer = { current: { ok: true as const, run: { id: crypto.randomUUID() } } as { ok: true; run: { id: string } } | { ok: false; reason: string } };
  const withAgents = createLabels({ now: () => clock.at, start: () => async (workspaceId, a) => (started.push({ workspaceId, agent: a.agent, input: a.input }), answer.current) });
  const weekly = createSnapshots({ readPage, now: () => clock.at, afterRead: (ws) => withAgents.classify(ws) });

  clock.at = new Date("2026-12-07T07:00:00Z");
  serve("https://double.example/log", log("Teams connection"));
  await weekly.readWorkspace(W);
  expect(await withAgents.classify(W)).toEqual({ skipped: "nothing_new" });
  expect(await createLabels().classify(W)).toEqual({ skipped: "nothing_new" });

  nextWeek();
  serve("https://double.example/log", log("Autoclose: AI agents reconcile accounts", "Teams connection"));
  await weekly.readWorkspace(W);
  // Until the eval passes the agent has no route, and the Changes wait.
  answer.current = { ok: false, reason: "no_route" };
  expect(await withAgents.classify(W)).toEqual({ skipped: "no_route" });
  expect(await createLabels({ now: () => clock.at }).classify(W)).toEqual({ skipped: "no_agents" });
  answer.current = { ok: true, run: { id: crypto.randomUUID() } };
  expect(await withAgents.classify(W)).toEqual({ started: answer.current.run.id });
  const run = started.at(-1)!;
  expect(run).toMatchObject({ workspaceId: W, agent: "change_classifier", input: { asOf: clock.at.toISOString() } });
  expect(run.input.text).toContain('Lines added:\n  "Autoclose: AI agents reconcile accounts"');
  expect(run.input.text).not.toContain("Teams connection");

  const [change] = (await withAgents.pending(W)).changes;
  const context = { runId: crypto.randomUUID(), input: run.input, tainted: true, pagesRead: [], pages: [], producer: { agent: "change_classifier", definitionVersion: 1, promptDigest: "d", routeHash: "r" } };
  const body = (labels: object[]) => ({ kind: "draft", outputKey: "competitor_labels", body: { schemaVersion: 1, labels, steered: [] } }) as never;
  const good = { changeId: change!.id, label: "answer", kind: "comparison_page", sameAs: null, reason: "Autoclose prices reconciliation" };
  expect(await withAgents.sink(W, body([{ ...good, changeId: "made-up" }]), context)).toEqual({ ok: false, code: "labels_refused: labelled made-up, which it wasn't given" });
  expect(await withAgents.sink(W, body([good]), { ...context, input: { text: "x" } })).toEqual({ ok: false, code: "no_input" });
  expect(await withAgents.sink(W, body([good]), context)).toEqual({ ok: true, itemId: null });
  // A retry of the same run is done already; nothing is written twice.
  expect(await withAgents.sink(W, body([good]), context)).toEqual({ ok: true, itemId: null });
  expect((await snapshots.recentChanges(W, r.competitor.id)).map((c) => [c.label, c.runId])).toEqual([["answer", context.runId]]);
  expect(await withAgents.classify(W)).toEqual({ skipped: "nothing_new" });
});
