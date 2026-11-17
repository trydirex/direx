// SPDX-License-Identifier: AGPL-3.0-only
// The weekly read against the test database, with pages served from a map and a clock moved by hand.
import { expect, test } from "vitest";
import { pageParts } from "../seo/index";
import { TEST_SECRET, testIdentity } from "../identity/test-auth";
import { createCompetitors, createSnapshots, type ReadPage } from "./index";

process.env.DIREX_AUTH_SECRET = TEST_SECRET;
type Read = Awaited<ReturnType<ReadPage>>;
const WEEK_MS = 7 * 86_400_000;
const clock = { at: new Date("2026-11-09T07:00:00Z") };
const nextWeek = () => (clock.at = new Date(clock.at.getTime() + WEEK_MS));
const pages = new Map<string, Read | Error>();
const serve = (url: string, html: string) => pages.set(url, { ok: true, url, finalUrl: url, ...pageParts(html), html, text: "", truncated: false, readAt: clock.at });
const readPage: ReadPage = async (url) => {
  const p = pages.get(url);
  if (p instanceof Error) throw p;
  return p ?? { ok: false, reason: "failed", detail: "http_error 404" };
};
const afterRead: string[] = [];
const snapshots = createSnapshots({ readPage, now: () => clock.at, afterRead: async (ws) => void afterRead.push(ws) });
const competitors = createCompetitors({ readPage: async () => ({ ok: false, reason: "failed" }) });

const { signIn, createOrg, call } = testIdentity();
async function workspace(name: string) {
  const cookie = await signIn();
  const W = (await createOrg(cookie, name)).workspace.id;
  const userId = ((await (await call("/api/me", cookie)).json()) as { user: { id: string } }).user.id;
  return { W, userId };
}
const { W, userId } = await workspace("Contoso");
async function competitor(name: string, urls: { changelogUrl?: string; pricingUrl?: string; landingUrl?: string }) {
  const r = await competitors.add(W, userId, { name, ...urls });
  if (!r.ok) throw new Error(r.reason);
  return r.competitor.id;
}
const changesOf = async (id: string) => (await snapshots.recentChanges(W, id)).map((c) => c.detail);
const readFor = async (id: string) => (await snapshots.lastReads(W)).filter((r) => r.competitorId === id);

const log = (...lines: string[]) => `<article>${lines.map((l) => `<p>${l}</p>`).join("")}</article>`;

test("a baseline makes no Change; next week's new line is one Change citing both reads; the same week twice adds nothing", async () => {
  const url = "https://double.example/changelog";
  serve(url, log("October 29, 2026", "Autoclose: AI agents reconcile accounts."));
  const id = await competitor("Double", { changelogUrl: url });
  await snapshots.readWorkspace(W);
  expect(await changesOf(id)).toEqual([]);

  nextWeek();
  serve(url, log("November 5, 2026", "Bank reconciliation now auto-matches transfers", "October 29, 2026", "Autoclose: AI agents reconcile accounts."));
  await snapshots.readWorkspace(W);
  await snapshots.readWorkspace(W);
  const changes = await snapshots.recentChanges(W, id);
  expect(changes.map((c) => c.detail)).toEqual([{ added: ["November 5, 2026", "Bank reconciliation now auto-matches transfers"] }]);
  expect(changes[0]!.beforeSnapshotId).not.toBe(changes[0]!.afterSnapshotId);
  expect(await readFor(id)).toMatchObject([{ source: "changelog", url, failure: null, readAt: clock.at }]);
});

test("a failed read keeps its reason, and the next good read compares with the last good one", async () => {
  const url = "https://xenett.example/announcements";
  serve(url, log("GL Rec, All Clients"));
  const id = await competitor("Xenett", { changelogUrl: url });
  await snapshots.readWorkspace(W);

  nextWeek();
  pages.set(url, { ok: false, reason: "robots_disallowed" });
  await snapshots.readWorkspace(W);
  expect(await readFor(id)).toMatchObject([{ failure: "robots_disallowed" }]);

  nextWeek();
  serve(url, log("Late Close Flag", "GL Rec, All Clients"));
  await snapshots.readWorkspace(W);
  expect(await changesOf(id)).toEqual([{ added: ["Late Close Flag"] }]);
  expect(await readFor(id)).toMatchObject([{ failure: null }]);
});

test("an edited URL starts again from a new baseline", async () => {
  serve("https://booke.example/old", log("Old page"));
  const id = await competitor("Booke AI", { changelogUrl: "https://booke.example/old" });
  await snapshots.readWorkspace(W);
  expect((await competitors.edit(W, id, { changelogUrl: "https://booke.example/new" })).ok).toBe(true);

  nextWeek();
  serve("https://booke.example/new", log("A different page entirely"));
  await snapshots.readWorkspace(W);
  expect(await changesOf(id)).toEqual([]);
});

test("pricing records added and removed lines; landing records each changed part, not a flip back", async () => {
  const pricing = "https://botkeeper.example/pricing";
  const landing = "https://botkeeper.example/";
  const hero = (headline: string) => `<head><title>Botkeeper</title></head><h1>${headline}</h1><p>For accounting firms.</p>`;
  serve(pricing, "<h3>Core</h3><div>$149 per license</div>");
  serve(landing, hero("AI Accounting"));
  const id = await competitor("Botkeeper", { pricingUrl: pricing, landingUrl: landing });
  await snapshots.readWorkspace(W);

  nextWeek();
  serve(pricing, "<h3>Core</h3><div>$159 per license</div><h3>Enterprise</h3>");
  serve(landing, hero("Bookkeeping, done for you"));
  await snapshots.readWorkspace(W);
  expect(await changesOf(id)).toEqual(
    expect.arrayContaining([
      { added: ["$159 per license", "Enterprise"], removed: ["$149 per license"] },
      { part: "headline", before: "AI Accounting", after: "Bookkeeping, done for you" },
    ]),
  );

  nextWeek();
  serve(landing, hero("AI Accounting"));
  await snapshots.readWorkspace(W);
  expect(await changesOf(id)).toHaveLength(2);
});

test("the weekly job reads every Workspace, and one that fails doesn't stop the next", async () => {
  const other = await workspace("Other");
  const broken = await workspace("Broken");
  pages.set("https://broken.example/", new Error("database went away"));
  serve("https://other.example/", "<h1>Other</h1>");
  for (const [ws, url] of [
    [broken, "https://broken.example/"],
    [other, "https://other.example/"],
  ] as const) {
    const r = await competitors.add(ws.W, ws.userId, { name: "C", landingUrl: url });
    expect(r.ok).toBe(true);
  }
  nextWeek();
  const errors: unknown[] = [];
  const original = console.error;
  console.error = (...a: unknown[]) => void errors.push(a);
  try {
    await snapshots.weekly();
  } finally {
    console.error = original;
  }
  expect(errors).toHaveLength(1);
  // The classifier is started for each Workspace read, and not for the one whose read threw.
  expect(afterRead).toEqual(expect.arrayContaining([other.W, W]));
  expect(afterRead).not.toContain(broken.W);
  expect(await snapshots.lastReads(other.W)).toMatchObject([{ source: "landing", failure: null }]);
  expect(await snapshots.lastReads(broken.W)).toEqual([]);
  // This Workspace was read too, and another Workspace's reads stay out of it.
  expect((await snapshots.lastReads(W)).every((r) => r.readAt.getTime() === clock.at.getTime())).toBe(true);
});
