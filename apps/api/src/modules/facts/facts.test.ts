// SPDX-License-Identifier: AGPL-3.0-only
// Facts, proposals and contradictions through the module's entry point and real Items.
import { expect, test } from "vitest";
import { itemsWorld, person } from "../items/fixtures/items";
import { warn } from "../items/index";
import { createFacts, factKinds } from "./index";

const world = await itemsWorld({ kinds: factKinds() });
const { W, items, who } = world;
const facts = createFacts({ items: () => items });
const site = { kind: "website" as const, label: "/services" };
const me = { kind: "person" as const, label: "Sam" };
const set = (field: "tone" | "price" | "claim" | "never_say", value: string, subject?: string) =>
  facts.set(W, { field, subject, value, source: me, confidence: "high", actor: person });
const ok = <T extends { ok: boolean }>(r: T) => {
  if (!r.ok) throw new Error(JSON.stringify(r));
  return r as Extract<T, { ok: true }>;
};
const propose = async (field: "tone" | "price" | "claim", value: string, subject?: string, extra: { confidence?: "low" | "medium" | "high"; untrustedInput?: boolean } = {}) =>
  ok(await facts.propose(W, { field, subject, value, source: site, confidence: "high", actor: { system: "test" }, ...extra })).item!;
const liveOf = async (id: string) => (await facts.list(W)).find((f) => f.id === id);

test("setting a slot again adds a version under one id, and every version stays readable", async () => {
  const a = ok(await set("tone", "Plain and direct."));
  expect(a.version).toBe(1);
  const b = ok(await set("tone", "Plain, direct, short."));
  expect(b).toMatchObject({ id: a.id, version: 2 });
  const history = await facts.history(W, a.id);
  expect(history.map((v) => [v.version, v.value, v.actorUserId])).toEqual([
    [1, "Plain and direct.", person.userId],
    [2, "Plain, direct, short.", person.userId],
  ]);
  expect(history[0]!.source).toEqual(me);
  expect(history[0]!.digest).not.toBe(history[1]!.digest);
});

test("a stale edit is refused, and a blank value is too", async () => {
  const a = ok(await set("price", "$1", "stale"));
  await set("price", "$2", "stale");
  expect(await facts.set(W, { field: "price", subject: "stale", value: "$3", source: me, confidence: "high", actor: person, expectedVersion: a.version })).toEqual({ ok: false, reason: "stale_version" });
  expect(await set("price", "   ", "x")).toEqual({ ok: false, reason: "blank_value" });
});

test("saving the words already there adds no version, and a value over the cap is refused", async () => {
  const a = ok(await set("never_say", "cheap"));
  expect(ok(await set("never_say", " cheap "))).toEqual({ ok: true, id: a.id, version: 1 });
  expect((await facts.history(W, a.id)).map((v) => v.version)).toEqual([1]);
  // The same words from another person do add one, so History says who added it.
  expect(ok(await facts.set(W, { field: "never_say", value: "cheap", source: { kind: "person", label: "Ana" }, confidence: "high", actor: person })).version).toBe(2);
  const long = "x".repeat(1001);
  expect(await set("claim", long)).toEqual({ ok: false, reason: "value_too_long" });
  expect(await facts.propose(W, { field: "claim", value: long, source: me, confidence: "high", actor: person })).toEqual({ ok: false, reason: "value_too_long" });
  expect(ok(await set("claim", "y".repeat(1000))).version).toBe(1);
});

test("a retired slot can be filled again, by a new fact", async () => {
  const a = ok(await set("price", "$5", "reborn"));
  expect((await facts.retire(W, a.id, person)).ok).toBe(true);
  expect(await liveOf(a.id)).toBeUndefined();
  const b = ok(await set("price", "$6", "reborn"));
  expect(b.id).not.toBe(a.id);
  expect(await facts.retire(W, a.id, person)).toEqual({ ok: false, reason: "not_found" });
});

test("a proposal for an empty slot is an Item and no fact; accepting it makes the fact", async () => {
  const i = await propose("price", "$7", "add me");
  expect(i).toMatchObject({ kind: "fact_proposal", state: "needs_approval", clean: true });
  expect((await facts.list(W)).some((f) => f.subject === "add me")).toBe(false);
  const r = ok(await items.approve(W, i.id, i.revision, who));
  expect(r.item.state).toBe("applied");
  const fact = (await facts.list(W)).find((f) => f.subject === "add me")!;
  expect(fact).toMatchObject({ value: "$7", currentVersion: 1, source: site, usable: true });
  const [first] = await facts.history(W, fact.id);
  expect(first!.actorUserId).toBe(person.userId);
});

test("an added Fact can be undone, which retires it, until someone edits it", async () => {
  const mayAll = { userId: person.userId, may: () => true };
  const i = await propose("price", "$8", "undo me");
  // Nothing to undo before it's approved.
  expect(await items.undo(W, i.id, mayAll)).toMatchObject({ ok: false, reason: "wrong_state" });
  ok(await items.approve(W, i.id, i.revision, who));
  expect((await items.detail(W, i.id))!.undo).toEqual({ ok: true });
  // A Fact Undo takes the approve permission, as Brand's Remove does.
  expect(await items.undo(W, i.id, { userId: person.userId, may: (p) => p !== "item.approve" })).toMatchObject({ ok: false, reason: "forbidden" });
  const fact = (await facts.list(W)).find((f) => f.subject === "undo me")!;
  expect(ok(await items.undo(W, i.id, mayAll)).item.state).toBe("applied");
  expect(await liveOf(fact.id)).toBeUndefined();
  // Retired, not deleted: its history is still there.
  expect((await facts.history(W, fact.id)).map((v) => v.value)).toEqual(["$8"]);
  const shown = (await items.detail(W, i.id))!;
  expect(shown.timeline.at(-1)).toMatchObject({ reason: "Undone", actor: { kind: "person", id: person.userId } });
  expect(shown.undo).toEqual({ ok: false, reason: "edited_since" });
  expect(await items.undo(W, i.id, mayAll)).toMatchObject({ ok: false, reason: "edited_since" });

  const edited = await propose("price", "$9", "edited");
  ok(await items.approve(W, edited.id, edited.revision, who));
  ok(await set("price", "$10", "edited"));
  // Someone changed it since, so undoing would throw their words away.
  expect((await items.detail(W, edited.id))!.undo).toEqual({ ok: false, reason: "edited_since" });
  expect(await items.undo(W, edited.id, mayAll)).toMatchObject({ ok: false, reason: "edited_since" });
  expect((await facts.list(W)).find((f) => f.subject === "edited")).toMatchObject({ value: "$10" });
});

test("dismissing a proposal creates nothing", async () => {
  const i = await propose("price", "$8", "dismiss me");
  ok(await items.cancel(W, i.id, person));
  expect((await facts.list(W)).some((f) => f.subject === "dismiss me")).toBe(false);
});

test("the same words create nothing, and asking twice makes one Item", async () => {
  await set("price", "$9", "same");
  expect((await facts.propose(W, { field: "price", subject: "same", value: " $9 ", source: site, confidence: "high", actor: { system: "t" } }))).toEqual({ ok: true, item: null });
  const a = await propose("price", "$10", "twice");
  const b = await propose("price", "$10", "twice");
  expect(b.id).toBe(a.id);
});

test("reading a description again in new words makes no contradiction and no second Item; a different one, or a person's edit, still does", async () => {
  const read = (value: string, source: typeof site | typeof me = site) => facts.propose(W, { field: "who_buys", value, source, confidence: "high", actor: { system: "t" } });
  const waiting = ok(await read("Small charities in the UK")).item!;
  expect(ok(await read("Small UK charities")).item!.id).toBe(waiting.id);
  ok(await items.approve(W, waiting.id, waiting.revision, who));
  expect(await read("UK small charities")).toEqual({ ok: true, item: null });
  const conflict = ok(await read("Restaurants in France")).item!;
  expect(conflict.kind).toBe("fact_conflict");
  // Another read in other words joins the decision already waiting; a person's edit is its own.
  const latest = ok(await read("Accountants. Trusted by 500+ firms")).item!;
  expect(latest.id).toBe(conflict.id);
  // It shows the newer finding, not the one it was opened with, and choosing it uses those words.
  expect(latest.warnings.map((w) => w.text).join()).toContain('"Accountants. Trusted by 500+ firms"');
  expect(latest.warnings.map((w) => w.text).join()).not.toContain("Restaurants in France");
  expect(latest.revision).toBeGreaterThan(conflict.revision);
  const mine = ok(await read("Small charities across the UK", me)).item!;
  expect(mine).toMatchObject({ kind: "fact_conflict" });
  expect(mine.id).not.toBe(conflict.id);
  ok(await items.cancel(W, mine.id, person));
  ok(await items.approve(W, latest.id, latest.revision, who, "use_new"));
  expect((await facts.list(W)).find((f) => f.field === "who_buys")!.value).toBe("Accountants. Trusted by 500+ firms");
});

test("low confidence or untrusted content isn't clean, so bulk approve refuses it", async () => {
  const low = await propose("price", "$11", "low", { confidence: "low" });
  const untrusted = await propose("price", "$12", "untrusted", { untrustedInput: true });
  const r = await items.approveClean(W, [low, untrusted].map((i) => ({ id: i.id, revision: i.revision })), who);
  expect(r.map((x) => (x.result.ok ? "ok" : x.result.reason))).toEqual(["not_clean", "not_clean"]);
  expect(ok(await items.approve(W, low.id, low.revision, who)).item.state).toBe("applied");
});

test("a proposal for a slot filled since is refused, and nothing changes", async () => {
  const i = await propose("price", "$13", "race");
  await set("price", "$14", "race");
  expect(await items.approve(W, i.id, i.revision, who)).toEqual({ ok: false, reason: "target_changed" });
  expect((await items.view(W, i.id))!.state).toBe("needs_approval");
  expect((await facts.list(W)).find((f) => f.subject === "race")!.value).toBe("$14");
});

test("different words make a contradiction: the fact stands but nothing may rely on it", async () => {
  const f = ok(await set("price", "$4,500", "conflict"));
  const i = await propose("price", "$3,900", "conflict");
  expect(i).toMatchObject({ kind: "fact_conflict", clean: false });
  expect(i.warnings.map((w) => w.text).join()).toContain('"$4,500"');
  expect(i.warnings.map((w) => w.text).join()).toContain('"$3,900"');
  expect(await liveOf(f.id)).toMatchObject({ value: "$4,500", usable: false });
  expect((await facts.usableFacts(W)).some((u) => u.id === f.id)).toBe(false);
  expect(await facts.checkCitation(W, f.id, 1)).toBe("needs_decision");
  expect(await items.approve(W, i.id, i.revision, who)).toEqual({ ok: false, reason: "choice_required" });
  expect(await items.approve(W, i.id, i.revision, who, "maybe")).toEqual({ ok: false, reason: "choice_required" });
  ok(await items.cancel(W, i.id, person));
  expect(await liveOf(f.id)).toMatchObject({ value: "$4,500", usable: true });
  expect(await facts.checkCitation(W, f.id, 1)).toBe("ok");
});

test("deciding a contradiction: keep, use the new value, or remove", async () => {
  const contest = async (subject: string) => {
    const f = ok(await set("price", "old", subject));
    return { f, i: await propose("price", "new", subject) };
  };
  const keep = await contest("keep");
  expect(ok(await items.approve(W, keep.i.id, 1, who, "keep")).item.state).toBe("applied");
  expect(await liveOf(keep.f.id)).toMatchObject({ value: "old", currentVersion: 1, usable: true });

  const use = await contest("use");
  ok(await items.approve(W, use.i.id, 1, who, "use_new"));
  expect(await liveOf(use.f.id)).toMatchObject({ value: "new", currentVersion: 2, source: site, usable: true });
  expect(await facts.checkCitation(W, use.f.id, 1)).toBe("stale");
  expect(await facts.checkCitation(W, use.f.id, 2)).toBe("ok");

  const gone = await contest("gone");
  ok(await items.approve(W, gone.i.id, 1, who, "remove"));
  expect(await liveOf(gone.f.id)).toBeUndefined();
  expect(await facts.checkCitation(W, gone.f.id, 1)).toBe("retired");
  expect((await facts.history(W, gone.f.id)).map((v) => v.value)).toEqual(["old"]);
});

test("a contradiction over a version that has moved is refused", async () => {
  const f = ok(await set("price", "a", "moved"));
  const i = await propose("price", "b", "moved");
  await set("price", "c", "moved");
  expect(await items.approve(W, i.id, 1, who, "use_new")).toEqual({ ok: false, reason: "target_changed" });
  expect(await liveOf(f.id)).toMatchObject({ value: "c" });
});

test("two values racing for one slot end with one live fact", async () => {
  const results = await Promise.all(["a", "b", "c", "d", "e"].map((v) => set("price", v, "racing")));
  const live = (await facts.list(W)).filter((f) => f.subject === "racing");
  expect(live).toHaveLength(1);
  const won = results.filter((r) => r.ok);
  expect(new Set(won.map((r) => r.ok && r.id)).size).toBe(1);
  expect(await facts.history(W, live[0]!.id)).toHaveLength(won.length);
});

test("usable facts cite an id, version and digest, and leave out banned phrases", async () => {
  const f = ok(await set("claim", "Saved Acme 120 hours"));
  const banned = ok(await set("never_say", "Guaranteed ROI"));
  const u = await facts.usableFacts(W);
  expect(u.find((x) => x.id === f.id)).toMatchObject({ version: 1, field: "claim", value: "Saved Acme 120 hours", digest: expect.stringMatching(/^[0-9a-f]{64}$/) });
  expect(u.some((x) => x.id === banned.id)).toBe(false);
  expect(await facts.checkCitation(W, crypto.randomUUID(), 1)).toBe("missing");
});

test("a competitor fact is a proposal like any other, a second update for that competitor is a contradiction, and no draft may cite it", async () => {
  const page = { kind: "website" as const, label: "Double pricing page", url: "https://double.example/pricing", retrievedAt: "2026-11-16T07:00:00.000Z" };
  const competitor = async (value: string) => ok(await facts.propose(W, { field: "competitor", subject: "Double", value, source: page, confidence: "high", actor: { system: "competitors" } })).item!;
  const first = await competitor("pricing page, read 16 Nov: Enterprise, contact sales");
  expect(first.kind).toBe("fact_proposal");
  ok(await items.approve(W, first.id, first.revision, who));
  const live = (await facts.list(W)).find((f) => f.field === "competitor")!;
  expect(live).toMatchObject({ subject: "double", source: page });
  expect((await competitor("pricing page, read 23 Nov: Autoclose $500 a month")).kind).toBe("fact_conflict");
  expect((await facts.usableFacts(W)).some((u) => u.id === live.id)).toBe(false);
});

test("a banned phrase is found while live, and stops matching once retired", async () => {
  const f = ok(await set("never_say", "best in class"));
  expect(await facts.bannedClaimsIn(W, "We are BEST in class.")).toContain("best in class");
  await facts.retire(W, f.id, person);
  expect(await facts.bannedClaimsIn(W, "We are BEST in class.")).not.toContain("best in class");
});

test("with takeOver off, a slot with a proposal waiting is left as it was and named", async () => {
  const waiting = await propose("price", "$10", "door slot");
  const outside = { kind: "document" as const, label: 'External token "Zapier"' };
  const by = { system: "external_token:00000000-0000-4000-8000-000000000001" };
  for (const value of ["$11", "$10"])
    expect(await facts.propose(W, { field: "price", subject: "door slot", value, source: outside, confidence: "medium", actor: by, takeOver: false })).toEqual({ ok: false, reason: "already_waiting", itemId: waiting.id });
  expect((await items.view(W, waiting.id))!.title).toBe(waiting.title);
});

test("extra warnings land on the Item with their own codes", async () => {
  const note = warn("untrusted_source", 'Sent through the External token "Zapier". Direx hasn\'t checked it.');
  const r = ok(await facts.propose(W, { field: "claim", subject: "door claim", value: "Ships in a day", source: { kind: "document", label: 'External token "Zapier"' }, confidence: "medium", actor: { system: "external_token:x" }, warnings: [note] }));
  expect(r.item!.warnings).toContainEqual(note);
});
