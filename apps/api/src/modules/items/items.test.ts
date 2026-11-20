// SPDX-License-Identifier: AGPL-3.0-only
// Creating, revising and listing Items, through the module's entry point and a real ledger.
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "vitest";
import { appClient } from "../../../../../test/db";
import { encodeListCursor, orderOf, parseListCursor } from "./domain/list-cursor";
import { POST, actionIdOf, itemsWorld, person } from "./fixtures/items";

const w = await itemsWorld({ kinds: { fact_edit: { permission: "item.approve", apply: async () => ({ ok: true }) } } });
const { W, items, ledger, clock, hours, newPost, submit, who } = w;
const needsYou = async () => (await items.list(W, { needsYou: true, limit: 100 })).items.map((i) => i.id);

test("creating twice with one idempotency key gives one Action and one Item, and a retry heals a lost Item", async () => {
  const key = crypto.randomUUID();
  const make = () =>
    items.createActionItem(W, { idempotencyKey: key, capability: POST, dedupe: "blind", spec: { body: "x" }, actor: person, details: { title: "T", warnings: [] } });
  // The crash: the Action exists and its Item doesn't.
  await ledger.createAction(W, { idempotencyKey: key, capability: POST, dedupe: "blind", spec: { body: "x" }, actor: person });
  const a = await make();
  const b = await make();
  expect(b.id).toBe(a.id);
  expect(a.state).toBe("draft");
});

test("an Action and its Item commit together: an Item that can't be written leaves no Action", async () => {
  const key = crypto.randomUUID();
  const action = { idempotencyKey: key, capability: POST, dedupe: "blind" as const, spec: { body: "x" }, actor: person };
  // A warning with no text fails the Item's own check, after the Action row was written.
  await expect(items.createActionItem(W, { ...action, details: { title: "T", warnings: [{ code: "unspecified" } as never] } })).rejects.toThrow();
  const again = await ledger.createAction(W, action);
  expect(again.created).toBe(true);
});

test("a revision that can't describe its Item leaves the Action on its old version", async () => {
  const i = await newPost();
  const actionId = await actionIdOf(W, i.id);
  await expect(items.reviseActionItem(W, i.id, { spec: { body: "edited" }, actor: person, details: { warnings: [{ code: "unspecified" } as never] } })).rejects.toThrow();
  expect((await ledger.getAction(W, actionId))!.draftVersion).toBe(1);
  expect((await items.view(W, i.id))!.clean).toBe(true);
});

test("a revision racing an approval of the same Item never deadlocks, and the new words always need a new yes", async () => {
  for (let round = 0; round < 20; round++) {
    const i = await submit(await newPost());
    const [revised] = await Promise.all([
      items.reviseActionItem(W, i.id, { spec: { body: `edit ${round}` }, actor: person, details: { warnings: [] } }),
      items.approve(W, i.id, i.revision, who),
    ]);
    expect(revised.ok).toBe(true);
    // Approved first, the revision voids the approval; revised first, the approval names an old version.
    expect(await items.view(W, i.id)).toMatchObject({ state: "needs_approval", revision: 2, clean: true });
  }
});

test("the state shown follows the ledger with no write to the Item", async () => {
  const i = await submit(await newPost());
  expect(i.state).toBe("needs_approval");
  const approved = await items.approve(W, i.id, i.revision, who);
  expect(approved.ok && approved.item.state).toBe("scheduled");
  const actionId = await actionIdOf(W, i.id);
  await ledger.run(W, actionId);
  expect((await items.view(W, i.id))!.state).toBe("sent");
});

test("a revision not yet described isn't clean and can't be approved; revising again levels it", async () => {
  const i = await submit(await newPost());
  const actionId = await actionIdOf(W, i.id);
  await ledger.reviseAction(W, actionId, { spec: { body: "edited" }, actor: person });
  const lagging = (await items.view(W, i.id))!;
  expect(lagging).toMatchObject({ clean: false, revision: 2 });
  expect(await items.approve(W, i.id, 2, who)).toEqual({ ok: false, reason: "details_stale" });
  const r = await items.reviseActionItem(W, i.id, { spec: { body: "again" }, actor: person, details: { warnings: [] } });
  expect(r.ok && r.item).toMatchObject({ clean: true, revision: 3 });
  expect((await items.approve(W, i.id, 3, who)).ok).toBe(true);
});

test("no production code creates or revises an Action around its Item", () => {
  const direct = /\.(createAction|reviseAction)\(/;
  expect(direct.test("await ledger.createAction(w, {})")).toBe(true);
  const src = join(import.meta.dirname, "../..");
  const offenders = readdirSync(src, { recursive: true, encoding: "utf8" })
    .filter((f) => f.endsWith(".ts") && !/\.test\.ts$|test-effects\.ts$|(^|\/)fixtures\//.test(f))
    .filter((f) => !/^modules\/(ledger|items)\//.test(f))
    .filter((f) => direct.test(readFileSync(join(src, f), "utf8")));
  expect(offenders).toEqual([]);
});

test("Needs you holds what needs a person, oldest decide-by first, and the count matches", async () => {
  const fresh = await itemsWorld();
  const list = () => fresh.items.list(fresh.W, { needsYou: true, limit: 100 });
  const draft = await fresh.newPost();
  const later = await fresh.submit(await fresh.newPost());
  const soon = await fresh.submit(await fresh.newPost());
  const none = await fresh.submit(await fresh.newPost());
  const scheduled = await fresh.submit(await fresh.newPost());
  await fresh.items.approve(fresh.W, scheduled.id, 1, fresh.who);
  await fresh.items.setTriage(fresh.W, later.id, { decideBy: fresh.hours(48) });
  await fresh.items.setTriage(fresh.W, soon.id, { decideBy: fresh.hours(1) });
  const r = await list();
  expect(r.items.map((i) => i.id)).toEqual([soon.id, later.id, none.id]);
  expect(r.needsYouCount).toBe(3);
  expect(r.items.map((i) => i.id)).not.toContain(draft.id);
});

test("a Held Item with a retry pending stays out of Needs you until the retries run out", async () => {
  const fresh = await itemsWorld({ postSteps: { steps: ["refused_retryable"] } });
  const i = await fresh.submit(await fresh.newPost());
  await fresh.items.approve(fresh.W, i.id, 1, fresh.who);
  const actionId = await actionIdOf(fresh.W, i.id);
  const ids = async () => (await fresh.items.list(fresh.W, { needsYou: true, limit: 10 })).items.map((x) => x.id);
  await fresh.ledger.run(fresh.W, actionId);
  expect((await fresh.items.view(fresh.W, i.id))!.state).toBe("held");
  expect(await ids()).toEqual([]);
  for (let n = 0; n < 5; n++) {
    fresh.clock.at = new Date(fresh.clock.at.getTime() + 3_600_000);
    await fresh.ledger.run(fresh.W, actionId);
  }
  expect((await fresh.items.view(fresh.W, i.id))!.reasonCode).toBe("provider_rejected");
  expect(await ids()).toEqual([i.id]);
});

test("snooze hides an Item until its time and stops no expiry", async () => {
  const i = await submit(await newPost());
  const until = hours(24);
  await items.setTriage(W, i.id, { snoozedUntil: until });
  expect(await needsYou()).not.toContain(i.id);
  const started = clock.at;
  clock.at = new Date(until.getTime() + 1);
  expect(await needsYou()).toContain(i.id);
  const actionId = await actionIdOf(W, i.id);
  clock.at = new Date(started.getTime() + 14 * 24 * 3_600_000);
  await ledger.run(W, actionId);
  expect((await items.view(W, i.id))!).toMatchObject({ state: "held", reasonCode: "approval_expired", reason: "approval expired" });
  clock.at = started;
});

test("a non-Action Item keeps its own triage and history", async () => {
  const r = await items.createItem(W, { kind: "fact_edit", payload: { fact: "x" }, actor: person, details: { title: "Add this?", warnings: [] } });
  if (!r.ok) throw new Error(r.reason);
  await items.setTriage(W, r.item.id, { snoozedUntil: hours(1) });
  expect((await items.view(W, r.item.id))!.snoozedUntil).toEqual(hours(1));
  const d = await items.detail(W, r.item.id);
  expect(d).toMatchObject({ content: { fact: "x" }, timeline: [{ from: null, to: "needs_approval", actor: { kind: "person" } }] });
  expect(await items.createItem(W, { kind: "nope", payload: {}, actor: person, details: { title: "x", warnings: [] } })).toEqual({ ok: false, reason: "unknown_kind" });
});

test("the Calendar query uses the time shown, and an Item with no time isn't on it", async () => {
  const fresh = await itemsWorld();
  const week = { from: fresh.hours(0), to: fresh.hours(7 * 24), limit: 100 };
  const planned = await fresh.submit(await fresh.newPost({ plannedAt: fresh.hours(48) }));
  await fresh.newPost();
  await fresh.newPost({ plannedAt: fresh.hours(10 * 24) });
  expect((await fresh.items.list(fresh.W, week)).items.map((i) => i.id)).toEqual([planned.id]);
  await fresh.items.approve(fresh.W, planned.id, 1, fresh.who);
  expect((await fresh.items.list(fresh.W, week)).items[0]).toMatchObject({ state: "scheduled", at: fresh.hours(48) });
});

/** Every id a filter reaches, `size` at a time, passing each page's cursor back. */
async function pageThrough(world: Awaited<ReturnType<typeof itemsWorld>>, f: { needsYou?: boolean; from?: Date; to?: Date }, size: number, between?: () => Promise<void>) {
  const ids: string[] = [];
  let cursor: string | null = null;
  do {
    const after = cursor === null ? undefined : (parseListCursor(cursor, orderOf(f)) ?? undefined);
    const page = await world.items.list(world.W, { ...f, after, limit: size });
    ids.push(...page.items.map((i) => i.id));
    cursor = page.nextCursor;
    await between?.();
  } while (cursor);
  return ids;
}

test("paging newest first reaches every Item once, even made in one instant and changing state between pages", async () => {
  const fresh = await itemsWorld();
  // The clock stands still, so all five share one creation time and only the id orders them.
  const made: Awaited<ReturnType<typeof fresh.newPost>>[] = [];
  for (let n = 0; n < 5; n++) made.push(await fresh.newPost());
  const whole = (await fresh.items.list(fresh.W, { limit: 100 })).items.map((i) => i.id);
  expect([...whole].sort()).toEqual(made.map((i) => i.id).sort());
  let moved = 0;
  const paged = await pageThrough(fresh, {}, 2, async () => {
    // An Item leaving the draft state between pages shifts no other row.
    if (moved < made.length) await fresh.submit(made[moved++]!);
  });
  expect(paged).toEqual(whole);
  expect((await fresh.items.list(fresh.W, { limit: 5 })).nextCursor).not.toBeNull();
  expect((await fresh.items.list(fresh.W, { limit: 6 })).nextCursor).toBeNull();
});

test("paging Needs you keeps the soonest deadline first and the ones with none last, across page edges", async () => {
  const fresh = await itemsWorld();
  const later = await fresh.submit(await fresh.newPost());
  const none = [await fresh.submit(await fresh.newPost()), await fresh.submit(await fresh.newPost())];
  const soon = await fresh.submit(await fresh.newPost());
  await fresh.items.setTriage(fresh.W, later.id, { decideBy: fresh.hours(48) });
  await fresh.items.setTriage(fresh.W, soon.id, { decideBy: fresh.hours(1) });
  const whole = (await fresh.items.list(fresh.W, { needsYou: true, limit: 100 })).items.map((i) => i.id);
  expect(whole.slice(0, 2)).toEqual([soon.id, later.id]);
  expect(whole.slice(2).sort()).toEqual(none.map((i) => i.id).sort());
  expect(await pageThrough(fresh, { needsYou: true }, 1)).toEqual(whole);
});

test("paging the Calendar's range by the time shown gives the same Items as one read", async () => {
  const fresh = await itemsWorld();
  for (const h of [30, 5, 30, 70]) await fresh.newPost({ plannedAt: fresh.hours(h) });
  const range = { from: fresh.hours(0), to: fresh.hours(7 * 24) };
  const whole = (await fresh.items.list(fresh.W, { ...range, limit: 100 })).items.map((i) => i.id);
  expect(whole).toHaveLength(4);
  expect(await pageThrough(fresh, range, 1)).toEqual(whole);
});

test("the list filters by states, channel, type, Campaign and words, and the filters combine", async () => {
  const fresh = await itemsWorld({ kinds: { fact_edit: { permission: "item.approve", apply: async () => ({ ok: true }) } } });
  const action = (details: { title: string; channel: string; workArea: string; groupKey?: string; groupLabel?: string }) =>
    fresh.items.createActionItem(fresh.W, { idempotencyKey: crypto.randomUUID(), capability: POST, dedupe: "blind", spec: { body: "x" }, actor: person, details: { ...details, warnings: [] } });
  const email = await action({ title: "Email to Dana", channel: "email", workArea: "outreach", groupKey: "campaign:c1:step:s1", groupLabel: "Spring launch" });
  const post = await fresh.submit(await action({ title: "100% off_sale", channel: "linkedin", workArea: "social", groupKey: "campaign:c1x:step:s1", groupLabel: "Other" }));
  const fact = await fresh.items.createItem(fresh.W, { kind: "fact_edit", payload: {}, actor: person, details: { title: "Add this fact", warnings: [], groupKey: "campaign:c1" } });
  if (!fact.ok) throw new Error(fact.reason);
  const ids = async (f: Omit<Parameters<typeof fresh.items.list>[1], "limit">) => (await fresh.items.list(fresh.W, { ...f, limit: 100 })).items.map((i) => i.id).sort();
  const of = (...xs: { id: string }[]) => xs.map((x) => x.id).sort();

  expect(await ids({ state: ["draft", "needs_approval"] })).toEqual(of(email, post, fact.item));
  expect(await ids({ state: "draft" })).toEqual(of(email));
  expect(await ids({ channels: ["email", "linkedin"] })).toEqual(of(email, post));
  // An Action by its work area, anything else by its kind.
  expect(await ids({ types: ["social", "fact_edit"] })).toEqual(of(post, fact.item));
  expect(await ids({ types: ["action"] })).toEqual([]);
  // A Campaign's own group and its steps, never a Campaign whose id only starts the same.
  expect(await ids({ campaign: "c1" })).toEqual(of(email, fact.item));
  // Words match the title or the group label, case aside, and % and _ are only characters.
  expect(await ids({ q: "spring" })).toEqual(of(email));
  expect(await ids({ q: "100% off_" })).toEqual(of(post));
  expect(await ids({ q: "0%" })).toEqual(of(post));
  expect(await ids({ q: "%" })).toEqual(of(post));
  expect(await ids({ q: "_" })).toEqual(of(post));
  expect(await ids({ campaign: "c1", state: "needs_approval", q: "fact" })).toEqual(of(fact.item));
  expect(await ids({ campaign: "c1", channels: ["linkedin"] })).toEqual([]);
});

test("a list cursor pages only the order that made it, and only as it was made", async () => {
  const id = crypto.randomUUID();
  const at = "2026-11-19T09:00:00.123456Z";
  const newest = encodeListCursor({ order: "newest", key: [at], id });
  expect(parseListCursor(newest, "newest")).toEqual({ order: "newest", key: [at], id });
  expect(parseListCursor(newest, "time")).toBeNull();
  expect(parseListCursor(encodeListCursor({ order: "needs_you", key: [null, at], id }), "needs_you")).toEqual({ order: "needs_you", key: [null, at], id });
  // Only a needs-you deadline may be missing, and every time keeps its microseconds.
  expect(parseListCursor(encodeListCursor({ order: "newest", key: [null], id }), "newest")).toBeNull();
  expect(parseListCursor(encodeListCursor({ order: "newest", key: ["2026-11-19T09:00:00.123Z"], id }), "newest")).toBeNull();
  expect(parseListCursor(encodeListCursor({ order: "newest", key: [at], id: "1 or 1=1" }), "newest")).toBeNull();
  expect(parseListCursor(encodeListCursor({ order: "newest", key: [at, at], id }), "newest")).toBeNull();
  for (const bad of ["500", "", "not base64 at all!", Buffer.from("[\"newest\"").toString("base64url"), `${newest}=`])
    expect(parseListCursor(bad, "newest")).toBeNull();
});

test("creating with replace cancels the one still waiting in its group, and leaves other groups and decided ones alone", async () => {
  const make = (groupKey?: string) => items.createItem(W, { kind: "fact_edit", payload: {}, actor: person, details: { title: "Next", warnings: [], ...(groupKey && { groupKey }) }, replace: true });
  const group = `g:${crypto.randomUUID()}`;
  const first = await make(group);
  const other = await make(`g:${crypto.randomUUID()}`);
  if (!first.ok || !other.ok) throw new Error("not made");
  const decided = await make(group);
  if (!decided.ok) throw new Error("not made");
  expect((await items.approve(W, decided.item.id, decided.item.revision, who)).ok).toBe(true);
  const second = await make(group);
  if (!second.ok) throw new Error("not made");
  expect((await items.detail(W, first.item.id))?.item.state).toBe("cancelled");
  expect((await items.detail(W, decided.item.id))?.item.state).toBe("applied");
  expect((await items.detail(W, other.item.id))?.item.state).toBe("needs_approval");
  expect((await items.detail(W, second.item.id))?.item.state).toBe("needs_approval");
  expect(await make()).toEqual({ ok: false, reason: "group_key_required" });
});

test("settling a group keeps one waiting Item: the same title changes nothing, a new one replaces it, none closes it", async () => {
  const group = `g:${crypto.randomUUID()}`;
  const settle = (title: string | null) => items.settleGroup(W, { kind: "fact_edit", groupKey: group, actor: person, next: title === null ? null : { payload: {}, details: { title, warnings: [] } } });
  const live = async () => (await items.list(W, { needsYou: true, limit: 500 })).items.filter((i) => i.groupKey === group).map((i) => i.title);
  expect(await settle("3 waiting")).toEqual({ ok: true, changed: true });
  expect(await settle("3 waiting")).toEqual({ ok: true, changed: false });
  expect(await live()).toEqual(["3 waiting"]);
  expect(await settle("1 waiting")).toEqual({ ok: true, changed: true });
  expect(await live()).toEqual(["1 waiting"]);
  expect(await settle(null)).toEqual({ ok: true, changed: true });
  expect(await live()).toEqual([]);
  expect(await settle(null)).toEqual({ ok: true, changed: false });
  expect(await items.settleGroup(W, { kind: "nope", groupKey: group, actor: person, next: null })).toEqual({ ok: false, reason: "unknown_kind" });
});

test("settling a group with the same words still moves the date it's due by", async () => {
  const group = `g:${crypto.randomUUID()}`;
  const settle = (decideBy: Date) => items.settleGroup(W, { kind: "fact_edit", groupKey: group, actor: person, next: { payload: {}, details: { title: "2 waiting", warnings: [] }, decideBy } });
  await settle(new Date("2026-11-09T09:00:00Z"));
  await settle(new Date("2026-11-12T09:00:00Z"));
  const [live] = (await items.list(W, { needsYou: true, limit: 500 })).items.filter((i) => i.groupKey === group);
  expect((await items.view(W, live!.id))!.decideBy).toEqual(new Date("2026-11-12T09:00:00Z"));
});

test("an Item shows what it was written from: its Run, the plan, Tone and Lessons that Run read, its Campaign step and the Facts it cites", async () => {
  const [campaignId, planId, factId, runId] = [crypto.randomUUID(), crypto.randomUUID(), crypto.randomUUID(), crypto.randomUUID()];
  const c = await appClient();
  await c.query("select set_config('app.workspace_id', $1, false)", [W]);
  await c.query("insert into facts (id, workspace_id, field, subject, current_version, created_at, updated_at) values ($1, $2, 'claim', '', 2, now(), now())", [factId, W]);
  for (const [v, value] of [[1, "Reviewers cost extra"], [2, "Reviewers are free"]] as const)
    await c.query("insert into fact_versions (workspace_id, fact_id, version, value, source, confidence, digest, actor_system, at) values ($1, $2, $3, $4, '{}', 'high', 'd', 'test', now())", [W, factId, v, value]);
  await c.query(
    "insert into agent_runs (id, workspace_id, idempotency_key, agent, definition_version, prompt_revision, prompt_digest, tool_set_digest, trigger, status, deadline_ms, step_cap, cost_cap_micros, input, created_at, updated_at) values ($1, $2, $3, 'recipient_writer', 1, 'r1', 'p', 't', 'person', 'succeeded', 1000, 1, 1, '{}', '2026-12-10T14:02:00Z', now())",
    [runId, W, `run:${runId}`],
  );
  await c.query("insert into agent_run_parts (workspace_id, run_id, seq, kind, ref_id, version, digest, trust, at) values ($1, $2, 1, 'plan', $3, '4', 'd', 'trusted', now())", [W, runId, planId]);
  // The Run was given the Tone and one Lesson, at version 2 of its words.
  const [toneId, lessonId] = [crypto.randomUUID(), crypto.randomUUID()];
  await c.query("insert into facts (id, workspace_id, field, subject, current_version, created_at, updated_at) values ($1, $2, 'tone', '', 1, now(), now())", [toneId, W]);
  await c.query("insert into agent_run_parts (workspace_id, run_id, seq, kind, ref_id, version, digest, trust, at) values ($1, $2, 2, 'fact', $3, '1', 'd', 'trusted', now())", [W, runId, toneId]);
  await c.query("insert into agent_lessons (id, workspace_id, agent, state, version, created_at, updated_at) values ($1, $2, 'recipient_writer', 'live', 2, now(), now())", [lessonId, W]);
  for (const [v, text] of [[1, "Under 120 words"], [2, "Under 90 words"]] as const)
    await c.query("insert into agent_lesson_versions (workspace_id, lesson_id, version, text, source, created_by, created_at) values ($1, $2, $3, $4, 'person', $5, now())", [W, lessonId, v, text, person.userId]);
  await c.query("insert into agent_run_lessons (workspace_id, run_id, lesson_id, version, digest) values ($1, $2, $3, 2, 'd')", [W, runId, lessonId]);
  const made = await items.createActionItem(W, {
    idempotencyKey: crypto.randomUUID(),
    capability: POST,
    dedupe: "blind",
    spec: { body: "hello" },
    actor: person,
    details: { title: "An email", warnings: [], groupKey: `campaign:${campaignId}:step:s3`, snapshot: [{ kind: "fact", id: factId, version: "1" }, { kind: "template", id: "x", version: "1" }] },
  });
  await c.query("insert into agent_proposals (workspace_id, run_id, output_key, kind, item_id, at) values ($1, $2, 'out', 'action', $3, now())", [W, runId, made.id]);
  await c.end();

  expect((await items.detail(W, made.id))!.writtenFrom).toEqual({
    run: { id: runId, agent: "recipient_writer", at: new Date("2026-12-10T14:02:00Z") },
    planId,
    step: { campaignId, stepKey: "s3" },
    // The words at the version it cites, not the Fact's latest.
    facts: [{ id: factId, version: 1, text: "Reviewers cost extra" }],
    lessons: [{ id: lessonId, text: "Under 90 words" }],
    voice: true,
  });
  // A person's own post records no source, so it shows none.
  expect((await items.detail(W, (await newPost()).id))!.writtenFrom).toBeNull();

  // A brand reader's proposal was given the same Tone, but it read a page rather than writing in a voice.
  const [readerRun, read] = [crypto.randomUUID(), await newPost()];
  const r = await appClient();
  await r.query("select set_config('app.workspace_id', $1, false)", [W]);
  await r.query(
    "insert into agent_runs (id, workspace_id, idempotency_key, agent, definition_version, prompt_revision, prompt_digest, tool_set_digest, trigger, status, deadline_ms, step_cap, cost_cap_micros, input, created_at, updated_at) values ($1, $2, $3, 'brand_reader', 1, 'r1', 'p', 't', 'person', 'succeeded', 1000, 1, 1, '{}', now(), now())",
    [readerRun, W, `run:${readerRun}`],
  );
  await r.query("insert into agent_run_parts (workspace_id, run_id, seq, kind, ref_id, version, digest, trust, at) values ($1, $2, 1, 'fact', $3, '1', 'd', 'trusted', now())", [W, readerRun, toneId]);
  await r.query("insert into agent_proposals (workspace_id, run_id, output_key, kind, item_id, at) values ($1, $2, 'out', 'fact_proposal', $3, now())", [W, readerRun, read.id]);
  await r.end();
  expect((await items.detail(W, read.id))!.writtenFrom).toMatchObject({ run: { id: readerRun, agent: "brand_reader" }, voice: false });
});
