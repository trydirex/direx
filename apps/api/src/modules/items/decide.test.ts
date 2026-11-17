// SPDX-License-Identifier: AGPL-3.0-only
// Approving and deciding, through the module's entry point, a real ledger and real schedule.
import { expect, test } from "vitest";
import { appClient } from "../../../../../test/db";
import { actionIdOf as idIn, itemsWorld, person } from "./fixtures/items";
import type { Items } from "./index";
import { can, ROLES } from "../identity/index";

const applied: string[] = [];
const afterCommit: { id: string; kind: string; payload: unknown; userId: string; committed: boolean }[] = [];
const late: { items?: Items } = {};
const w = await itemsWorld({
  onApplied: async (workspaceId, item) => {
    // Read on another connection: the hook must see the approval already committed.
    const seen = await late.items!.detail(workspaceId, item.id);
    afterCommit.push({ id: item.id, kind: item.kind, payload: item.payload, userId: item.userId, committed: seen?.item.state === "applied" });
    if ((item.payload as { mode: string }).mode === "hook_throws") throw new Error("hook blew up");
  },
  kinds: {
    fact_edit: {
      permission: "item.approve",
      apply: async (_tx, item, _actor, choice) => {
        const p = item.payload as { mode: string };
        if (p.mode === "choose" && !choice) return { ok: false, reason: "choice_required" };
        if (p.mode === "refuse") return { ok: false, reason: "fact_conflict" };
        if (p.mode === "throw") throw new Error("apply blew up");
        applied.push(item.id);
        return { ok: true };
      },
    },
    owner_only: { permission: "workspace.delete", apply: async () => ({ ok: true }) },
    careful: { permission: "item.approve", stepUp: true, bulk: false, apply: async () => ({ ok: true }) },
    // Like an Ask start: the Item names the permission its own button needs, and only a person's own yes applies it.
    asked: { permission: "item.approve", permissionOf: (item) => (item.payload as { needs: string }).needs, bulk: false, grant: false, apply: async () => ({ ok: true }) },
  },
  mayGrant: async () => true,
});
const { W, items, ledger, clock, hours, newPost, newTouch, newPerson, submit, who, email } = w;
late.items = items;

const actionIdOf = (id: string) => idIn(W, id);
const own = async (mode = "ok", kind = "fact_edit") => {
  const r = await items.createItem(W, { kind, payload: { mode }, actor: person, details: { title: "Add this?", warnings: [] } });
  if (!r.ok) throw new Error(r.reason);
  return r.item;
};

test("approve binds the Item's stored snapshot and planned time", async () => {
  const entry = { kind: "fact", id: "f1", version: "3" };
  const created = await items.createActionItem(W, {
    idempotencyKey: crypto.randomUUID(),
    capability: "test.post",
    dedupe: "blind",
    spec: { body: "x" },
    actor: person,
    details: { title: "T", warnings: [], snapshot: [entry], plannedAt: hours(5) },
  });
  const i = await submit(created);
  expect((await items.approve(W, i.id, i.revision, who)).ok).toBe(true);
  const id = await actionIdOf(i.id);
  expect((await ledger.getAction(W, id))!.dueAt).toEqual(hours(5));
  const c = await appClient();
  await c.query("select set_config('app.workspace_id', $1, false)", [W]);
  const { rows } = await c.query("select snapshot from approvals where action_id = $1", [id]);
  await c.end();
  expect(rows[0].snapshot).toEqual([entry]);
});

test("approving an old revision is refused and nothing changes", async () => {
  const i = await submit(await newPost());
  await items.reviseActionItem(W, i.id, { spec: { body: "new" }, actor: person, details: { warnings: [] } });
  expect(await items.approve(W, i.id, 1, who)).toEqual({ ok: false, reason: "draft_version_moved" });
  expect((await items.view(W, i.id))!.state).toBe("needs_approval");
});

test("a planned time already gone must be chosen again", async () => {
  const i = await submit(await newPost({ plannedAt: hours(-1) }));
  expect(await items.approve(W, i.id, 1, who)).toEqual({ ok: false, reason: "slot_in_past" });
});

test("bulk approve takes the clean ones and refuses the rest, one result each", async () => {
  const clean = await submit(await newPost());
  const warned = await submit(await newPost({ warnings: ["a claim has no source"] }));
  const r = await items.approveClean(W, [clean, warned, { id: crypto.randomUUID(), revision: 1 }].map((i) => ({ id: i.id, revision: 1 })), who);
  expect(r.map((x) => (x.result.ok ? true : x.result.reason))).toEqual([true, "not_clean", "not_found"]);
  expect((await items.view(W, warned.id))!.state).toBe("needs_approval");
});

test("a kind that wants step-up is refused without it and approved with it", async () => {
  const i = await own("ok", "careful");
  expect(await items.approve(W, i.id, i.revision, who)).toEqual({ ok: false, reason: "step_up_required" });
  expect((await items.view(W, i.id))!.state).toBe("needs_approval");
  expect((await items.approve(W, i.id, i.revision, { ...who, steppedUp: true })).ok).toBe(true);
});

test("approve all clean leaves a one-at-a-time kind for someone to read", async () => {
  const i = await own("ok", "careful");
  const r = await items.approveClean(W, [{ id: i.id, revision: i.revision }], { ...who, steppedUp: true });
  expect(r[0]!.result).toEqual({ ok: false, reason: "one_at_a_time" });
  expect((await items.view(W, i.id))!.state).toBe("needs_approval");
});

test("approving a Touch reserves its slot, and it goes out", async () => {
  const p = await newPerson();
  const i = await submit(await newTouch(p, hours(2)));
  expect((await items.approve(W, i.id, 1, who)).ok).toBe(true);
  clock.at = hours(2);
  await ledger.run(W, await actionIdOf(i.id));
  expect((await items.view(W, i.id))!.state).toBe("sent");
  expect(email.calls).toHaveLength(1);
});

test("a Touch with no planned time reserves now and goes out", async () => {
  const p = await newPerson();
  const i = await submit(await newTouch(p, null));
  expect((await items.approve(W, i.id, 1, who)).ok).toBe(true);
  await ledger.run(W, await actionIdOf(i.id));
  expect((await items.view(W, i.id))!.state).toBe("sent");
});

test("a full slot refuses the approval and the Item stays in Needs approval", async () => {
  const p = await newPerson();
  const first = await submit(await newTouch(p, hours(24)));
  expect((await items.approve(W, first.id, 1, who)).ok).toBe(true);
  const second = await submit(await newTouch(p, hours(25)));
  expect(await items.approve(W, second.id, 1, who)).toEqual({ ok: false, reason: "slot_full", cap: "general" });
  expect((await items.view(W, second.id))!.state).toBe("needs_approval");
});

test("approving a non-Action Item applies it and ends in Applied, with one event", async () => {
  const i = await own();
  const r = await items.approve(W, i.id, i.revision, who);
  expect(r.ok && r.item.state).toBe("applied");
  expect(applied).toContain(i.id);
  const { timeline } = (await items.detail(W, i.id))!;
  expect(timeline.at(-1)).toMatchObject({ from: "needs_approval", to: "applied", actor: { kind: "person", id: person.userId } });
  expect(await items.approve(W, i.id, r.ok ? r.item.revision : 0, who)).toEqual({ ok: false, reason: "wrong_state" });
});

test("when apply refuses or throws, the state doesn't change", async () => {
  const refused = await own("refuse");
  expect(await items.approve(W, refused.id, 1, who)).toEqual({ ok: false, reason: "fact_conflict" });
  expect((await items.view(W, refused.id))!.state).toBe("needs_approval");
  const thrown = await own("throw");
  await expect(items.approve(W, thrown.id, 1, who)).rejects.toThrow("apply blew up");
  expect((await items.view(W, thrown.id))!.state).toBe("needs_approval");
  expect((await items.detail(W, thrown.id))!.timeline).toHaveLength(1);
});

test("a kind's own permission decides who may approve it", async () => {
  const i = await own("ok", "owner_only");
  const marketer = { ...who, may: (p: string) => p === "item.approve" };
  expect(await items.approve(W, i.id, 1, marketer)).toEqual({ ok: false, reason: "forbidden" });
});

test("an Item that names its own permission is accepted by exactly the roles that hold it", async () => {
  for (const role of ROLES) {
    const r = await items.createItem(W, { kind: "asked", payload: { needs: "item.edit" }, actor: person, details: { title: "Draft the plan?", warnings: [] } });
    if (!r.ok) throw new Error(r.reason);
    const as = { ...who, may: (p: string) => can(role, p as "item.edit") };
    expect((await items.approve(W, r.item.id, 1, as)).ok, role).toBe(can(role, "item.edit"));
  }
});

test("a kind that refuses grants is applied only by a person's own yes, and never in bulk", async () => {
  const asked = await items.createItem(W, { kind: "asked", payload: { needs: "item.edit" }, actor: person, details: { title: "Draft the plan?", warnings: [] } });
  if (!asked.ok) throw new Error(asked.reason);
  expect(await items.applyByGrant(W, asked.item.id, { userId: person.userId, as: "advance" })).toEqual({ ok: false, reason: "forbidden" });
  expect(await items.approveClean(W, [{ id: asked.item.id, revision: 1 }], who)).toEqual([{ id: asked.item.id, result: { ok: false, reason: "one_at_a_time" } }]);
  const granted = await own();
  expect((await items.applyByGrant(W, granted.id, { userId: person.userId, as: "advance" })).ok).toBe(true);
});

test("Dismiss gives Cancelled, and Cancelled is final", async () => {
  const i = await own();
  const r = await items.cancel(W, i.id, person);
  expect(r.ok && r.item.state).toBe("cancelled");
  expect(await items.cancel(W, i.id, person)).toEqual({ ok: false, reason: "wrong_state" });
  expect(await items.approve(W, i.id, 2, who)).toEqual({ ok: false, reason: "wrong_state" });
});

test("cancel, resume and resolve reach the ledger for an Action", async () => {
  const held = await itemsWorld({ postSteps: { steps: ["hang"] } });
  const i = await held.submit(await held.newPost());
  expect((await held.items.cancel(held.W, i.id, person)).ok).toBe(true);
  expect(await items.resume(W, (await own()).id, person)).toEqual({ ok: false, reason: "wrong_state" });
  expect(await items.resolveUnknown(W, (await own()).id, "mark_sent", person.userId)).toEqual({ ok: false, reason: "wrong_state" });
});

test("a kind that needs a choice gets one, and an Action refuses any", async () => {
  const i = await own("choose");
  expect(await items.approve(W, i.id, 1, who)).toEqual({ ok: false, reason: "choice_required" });
  const r = await items.approve(W, i.id, 1, who, "keep");
  expect(r.ok && r.item.state).toBe("applied");
  const post = await submit(await newPost());
  expect(await items.approve(W, post.id, 1, who, "keep")).toEqual({ ok: false, reason: "choice_not_allowed" });
});

test("an applied own Item reaches onApplied after the commit, and nothing else does", async () => {
  afterCommit.length = 0;
  const ok = await own("ok");
  expect((await items.approve(W, ok.id, ok.revision, who)).ok).toBe(true);
  expect(afterCommit).toEqual([{ id: ok.id, kind: "fact_edit", payload: { mode: "ok" }, userId: person.userId, committed: true }]);

  afterCommit.length = 0;
  const refused = await own("refuse");
  expect(await items.approve(W, refused.id, refused.revision, who)).toEqual({ ok: false, reason: "fact_conflict" });
  expect((await items.approve(W, ok.id, ok.revision, who)).ok).toBe(false);
  const post = await submit(await newPost());
  expect((await items.approve(W, post.id, post.revision, who)).ok).toBe(true);
  expect(afterCommit).toEqual([]);
});

test("a failing onApplied leaves the approval standing", async () => {
  const i = await own("hook_throws");
  const r = await items.approve(W, i.id, i.revision, who);
  expect(r.ok && r.item.state).toBe("applied");
  expect((await items.detail(W, i.id))?.item.state).toBe("applied");
});
