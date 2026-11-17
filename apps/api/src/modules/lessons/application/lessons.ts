// SPDX-License-Identifier: AGPL-3.0-only
// Proposing, accepting, rewriting, retiring and turning a lesson into a Fact. Only a person's typed
// words become a lesson, after the lesson check, and only someone who may grant rules accepts one,
// recently signed in and one at a time. Every change stops that Agent's agent-written rules until a
// person re-confirms them, since what writes the unread email changed.
import { subjectOf, type Field } from "../../facts/index";
import { memberNames } from "../../identity/index";
import { warn, type ItemKind, type Items } from "../../items/index";
import type { Actor } from "../../ledger/index";
import * as repo from "../adapters/repo";
import { inWorkspace, type LessonsTx } from "../adapters/repo";
import { fitsBudget, LESSON_PROPOSAL_KIND, lessonText, type LessonRefusal } from "../domain/lessons";
import { checkLesson, type Generate } from "./check";
import { lessonDigest, setDigest, type CarriedLesson } from "./digest";

export const LESSON_FACT_KIND = "lesson_fact";
const GRANT = "rule.grant";
export const LESSONS_CHANGED = "this agent's lessons changed";

type ProposalPayload = { agent: string; text: string; sourceRef: string | null; definitionVersion: number | null };
type FactPayload = { field: Field; subject: string; value: string; source: { kind: "person"; label: string }; confidence: "high"; lessonId: string; lessonVersion: number };

export type LessonsDeps = {
  items: () => Pick<Items, "createItem">;
  /** Undefined when this process has no model access, so no lesson can be checked. */
  generate: () => Generate | undefined;
  /** Whether the lesson check has a passing eval on file. */
  checkOpen: () => boolean;
  /** Stops this Agent's agent-written standing rules until a person re-confirms each. */
  suspendRules: (tx: LessonsTx, agent: string, reason: string, at: Date) => Promise<number>;
  /** Warns on Drafts still waiting that these runs wrote. */
  warnDrafts: (workspaceId: string, runIds: readonly string[]) => Promise<void>;
  /** How an accepted Fact proposal is applied, so a lesson's Fact lands exactly as any other. */
  applyFact: ItemKind["apply"];
  /** Brand's live Facts, so a lesson isn't offered into a slot that already holds one. */
  liveFacts: (workspaceId: string) => Promise<readonly { field: string; subject: string }[]>;
  now: () => Date;
};

type Refused = { ok: false; reason: LessonRefusal | "lesson_check_unavailable" | "not_found" | "fact_slot_filled"; reasons?: string[] };
const refuse = (reason: Refused["reason"], reasons?: string[]): Refused => ({ ok: false, reason, ...(reasons && { reasons }) });

export function lessons(d: LessonsDeps) {
  /** The lesson check's answer on words already shaped by lessonText, or why it can't be asked. */
  async function checked(workspaceId: string, userId: string, text: string): Promise<Refused | null> {
    const generate = d.generate();
    if (!d.checkOpen() || !generate) return refuse("lesson_check_unevaluated");
    const c = await checkLesson(generate, workspaceId, userId, text);
    if (c.status === "unavailable") return refuse("lesson_check_unavailable");
    return c.status === "refused" ? refuse("lesson_check_refused", c.reasons) : null;
  }

  const event = (tx: LessonsTx, workspaceId: string, e: Omit<repo.NewEvent, "at" | "permission">) => repo.insertEvent(tx, workspaceId, { ...e, permission: GRANT, at: d.now() });

  /** A live lesson at the version the person saw, locked with its Agent so the budget is checked alone. */
  async function lockedAt(tx: LessonsTx, workspaceId: string, lessonId: string, version: number) {
    const row = await repo.lockLesson(tx, lessonId);
    if (!row) return null;
    await repo.lockAgent(tx, workspaceId, row.agent);
    return row.state === "live" && row.version === version ? row : "moved";
  }

  async function accept(tx: LessonsTx, item: { id: string; workspaceId: string; payload: unknown }, actor: Actor) {
    if (!("userId" in actor)) return { ok: false as const, reason: "forbidden" };
    const p = item.payload as ProposalPayload;
    await repo.lockAgent(tx, item.workspaceId, p.agent);
    if (!fitsBudget(await repo.liveLessons(tx, p.agent), p.text)) return { ok: false as const, reason: "lesson_budget_full" };
    const at = d.now();
    const lessonId = await repo.insertLesson(tx, item.workspaceId, p.agent, at);
    await repo.insertVersion(tx, item.workspaceId, { lessonId, version: 1, text: p.text, sourceRef: p.sourceRef, definitionVersion: p.definitionVersion, createdBy: actor.userId }, at);
    await event(tx, item.workspaceId, { lessonId, version: 1, itemId: item.id, op: "accept", evidenceDigest: lessonDigest(p.text), personId: actor.userId });
    await d.suspendRules(tx, p.agent, LESSONS_CHANGED, at);
    return { ok: true as const };
  }

  async function acceptFact(tx: LessonsTx, item: Parameters<ItemKind["apply"]>[1], actor: Actor, choice?: string) {
    if (!("userId" in actor)) return { ok: false as const, reason: "forbidden" };
    const p = item.payload as FactPayload;
    const row = await lockedAt(tx, item.workspaceId, p.lessonId, p.lessonVersion);
    if (row === null || row === "moved") return { ok: false as const, reason: "target_changed" };
    const applied = await d.applyFact(tx, item, actor, choice);
    if (!applied.ok) return applied;
    const at = d.now();
    await repo.setLesson(tx, row.id, { state: "cancelled" }, at);
    await event(tx, item.workspaceId, { lessonId: row.id, version: row.version, itemId: item.id, op: "convert", evidenceDigest: lessonDigest(p.value), personId: actor.userId });
    await d.suspendRules(tx, row.agent, LESSONS_CHANGED, at);
    return { ok: true as const };
  }

  return {
    /** Registered with items, so items never imports this module. */
    kinds(): Record<string, ItemKind> {
      return {
        [LESSON_PROPOSAL_KIND]: { permission: GRANT, stepUp: true, bulk: false, apply: (tx, item, actor) => accept(tx, item, actor) },
        [LESSON_FACT_KIND]: { permission: GRANT, stepUp: true, bulk: false, apply: (tx, item, actor, choice) => acceptFact(tx, item, actor, choice) },
      };
    },

    /** A person's sentence about how this Agent should work here, waiting in Needs you once it passes the check. */
    async propose(workspaceId: string, a: { agent: string; text: string; sourceRef: string | null; definitionVersion: number | null; userId: string }) {
      const shaped = lessonText(a.text);
      if (!shaped.ok) return refuse(shaped.reason);
      const no = await checked(workspaceId, a.userId, shaped.text);
      if (no) return no;
      const payload: ProposalPayload = { agent: a.agent, text: shaped.text, sourceRef: a.sourceRef, definitionVersion: a.definitionVersion };
      const r = await d.items().createItem(workspaceId, {
        kind: LESSON_PROPOSAL_KIND,
        payload,
        actor: { userId: a.userId },
        details: { title: `Remember this: "${shaped.text}"`, workArea: "Lessons", warnings: [] },
      });
      if (!r.ok) throw new Error(`lessons: ${r.reason}: the item kinds aren't registered`);
      await inWorkspace(workspaceId, (tx) => event(tx, workspaceId, { lessonId: null, version: null, itemId: r.item.id, op: "propose", evidenceDigest: lessonDigest(shaped.text), personId: a.userId }));
      return { ok: true as const, item: r.item };
    },

    /** New words for a live lesson, checked again; refused when someone changed it since it was read. */
    async rewrite(workspaceId: string, a: { lessonId: string; version: number; text: string; userId: string }) {
      const shaped = lessonText(a.text);
      if (!shaped.ok) return refuse(shaped.reason);
      const no = await checked(workspaceId, a.userId, shaped.text);
      if (no) return no;
      return inWorkspace(workspaceId, async (tx) => {
        const row = await lockedAt(tx, workspaceId, a.lessonId, a.version);
        if (row === null) return refuse("not_found");
        if (row === "moved") return refuse("target_changed");
        if (!fitsBudget(await repo.liveLessons(tx, row.agent), shaped.text, row.id)) return refuse("lesson_budget_full");
        const at = d.now();
        const version = row.version + 1;
        await repo.insertVersion(tx, workspaceId, { lessonId: row.id, version, text: shaped.text, sourceRef: null, definitionVersion: null, createdBy: a.userId }, at);
        await repo.setLesson(tx, row.id, { version }, at);
        await event(tx, workspaceId, { lessonId: row.id, version, itemId: null, op: "rewrite", evidenceDigest: lessonDigest(shaped.text), personId: a.userId });
        await d.suspendRules(tx, row.agent, LESSONS_CHANGED, at);
        return { ok: true as const, version };
      });
    },

    /** Withdraws a lesson. Drafts still waiting that a run wrote with it are marked. */
    async retire(workspaceId: string, a: { lessonId: string; version: number; userId: string }) {
      const done = await inWorkspace(workspaceId, async (tx) => {
        const row = await lockedAt(tx, workspaceId, a.lessonId, a.version);
        if (row === null) return refuse("not_found");
        if (row === "moved") return refuse("target_changed");
        const at = d.now();
        await repo.setLesson(tx, row.id, { state: "cancelled" }, at);
        await event(tx, workspaceId, { lessonId: row.id, version: row.version, itemId: null, op: "retire", evidenceDigest: lessonDigest((await repo.lessonText(tx, row.id, row.version))!), personId: a.userId });
        await d.suspendRules(tx, row.agent, LESSONS_CHANGED, at);
        return { ok: true as const, runs: await repo.runsCarrying(tx, [row.id]) };
      });
      if (!done.ok) return done;
      // Only a warning hangs on this, so a failure mustn't undo the retirement.
      await d.warnDrafts(workspaceId, done.runs).catch((e) => console.error("lessons: warning drafts failed", a.lessonId, e));
      return { ok: true as const };
    },

    /** A Fact proposal with the lesson's words; accepting it cancels the lesson in the same step. */
    async toFact(workspaceId: string, a: { lessonId: string; version: number; field: Field; subject?: string; sourceLabel: string; userId: string }) {
      const live = await inWorkspace(workspaceId, (tx) => repo.liveLessons(tx));
      const lesson = live.find((l) => l.id === a.lessonId);
      if (!lesson) return refuse("not_found");
      if (lesson.version !== a.version) return refuse("target_changed");
      const subject = subjectOf(a.field, a.subject, lesson.text);
      // Accepting would refuse anyway, and later, with a reason that isn't the real one.
      if ((await d.liveFacts(workspaceId)).some((f) => f.field === a.field && f.subject === subject)) return refuse("fact_slot_filled");
      const payload: FactPayload = {
        field: a.field,
        subject,
        value: lesson.text,
        source: { kind: "person", label: a.sourceLabel },
        confidence: "high",
        lessonId: lesson.id,
        lessonVersion: lesson.version,
      };
      const r = await d.items().createItem(workspaceId, {
        kind: LESSON_FACT_KIND,
        payload,
        actor: { userId: a.userId },
        details: { title: `Make this a Fact: "${lesson.text}"`, workArea: "Brand", warnings: [warn("unspecified", "Accepting this removes the lesson; the words become a Fact instead.")] },
      });
      if (!r.ok) throw new Error(`lessons: ${r.reason}: the item kinds aren't registered`);
      return { ok: true as const, item: r.item };
    },

    /** Live lessons, for the Workspace's people to read; one Agent's when named. */
    list: async (workspaceId: string, agent?: string) => {
      const [rows, names] = await Promise.all([
        inWorkspace(workspaceId, async (tx) => {
          const live = await repo.liveLessons(tx, agent);
          return { live, origins: await repo.origins(tx, live.map((l) => l.id)) };
        }),
        memberNames(workspaceId),
      ]);
      const by = new Map(rows.origins.map((o) => [o.lessonId, o]));
      return rows.live.map((l) => {
        const o = by.get(l.id);
        return { ...l, origin: { itemId: o?.itemId ?? null, sourceRef: o?.sourceRef ?? null, proposedBy: (o?.personId && names.get(o.personId)) || null } };
      });
    },

    /** Fixes what a run carries at its first claim, in the agents module's transaction. Returns the set's digest. */
    async fix(tx: LessonsTx, workspaceId: string, agent: string, runId: string): Promise<string> {
      const set: CarriedLesson[] = (await repo.liveLessons(tx, agent)).map((l) => ({ lessonId: l.id, version: l.version, text: l.text }));
      await repo.fixRunLessons(tx, workspaceId, runId, set.map((l) => ({ ...l, digest: lessonDigest(l.text) })));
      return setDigest(set);
    },

    /** What a run was fixed to carry, at the versions it was fixed at. */
    carried: (workspaceId: string, runId: string): Promise<CarriedLesson[]> =>
      inWorkspace(workspaceId, async (tx) => (await repo.carriedBy(tx, runId)).map((l) => ({ lessonId: l.lessonId, version: l.version, text: l.text }))),

    /** True when a lesson the run carries was withdrawn since, so a paused run mustn't carry on with it. */
    withdrawn: async (tx: LessonsTx, runId: string): Promise<boolean> => (await repo.carriedBy(tx, runId)).some((l) => l.state !== "live"),
  };
}
export type Lessons = ReturnType<typeof lessons>;
