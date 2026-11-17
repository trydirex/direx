// SPDX-License-Identifier: AGPL-3.0-only
// Counter-moves: each Change labelled an answer becomes one Item a person decides, or joins the one of
// the event it is another sighting of. A Fact update is a Fact proposal; a comparison page or a post is
// a competitor_move Item holding the competitor's own lines. For a comparison page, the comparison_brief
// agent then drafts edits; for a post, counter_post drafts the post. A draft reaches the Item only if it
// passes Direx's checks. Nothing leaves Direx: a person copies it out.
import type { Sink } from "../../agents/index";
import type { Facts } from "../../facts/index";
import type { Items } from "../../items/index";
import { norm } from "../../seo/index";
import { answerLinks, inWorkspace, setItemId, unmovedAnswers } from "../adapters/repo";
import type { Source } from "../domain/competitor";
import { comparisonInput, comparisonMarkdown, comparisonProblems, type BriefPage, type ComparisonBrief } from "../domain/comparison-brief";
import type { ChangeDetail } from "../domain/diff";
import { COUNTER_MOVES, type CounterMove } from "../domain/labels";
import { addSighting, factSource, factValue, linesOf, MOVE_KIND, movePayload, moveTitle, rootOf, type MovePayload, type Sighting } from "../domain/moves";
import { comparisonBrief } from "../definitions/comparison-brief";
import { counterPost } from "../definitions/counter-post";
import { postInput, postProblems, type CounterPost } from "../domain/post";
import type { ReadPage } from "./competitors";
import { CHANGES_SHOWN_DAYS } from "./snapshots";

const DAY_MS = 86_400_000;
const ACTOR = { system: "competitors" } as const;
const WORK_AREA = "Brand";
const WAITING = ["draft", "needs_approval"];
export const noPageNote = (competitor: string) => `No comparison page against ${competitor} yet. Add one under Competitors to get a draft.`;
export const REFUSED_NOTE = "A draft was written, but it didn't pass Direx's checks, so it isn't shown.";

/** What a Brief run is given: the untrusted text, and what the sink checks the draft against. */
/** `read` is missing on runs started before it was added. */
export type BriefInput = { text: string; itemId: string; page: BriefPage; theirs: string[]; read?: string[] };
/** What a post run is given: the untrusted text, and the competitor's words the sink checks it against. */
export type PostInput = { text: string; itemId: string; theirs: string[] };
export type StartBrief = (workspaceId: string, a: { agent: string; input: BriefInput | PostInput; schedule: true }) => Promise<{ ok: true; run: { id: string } } | { ok: false; reason: string }>;
export type MovesDeps = {
  facts: () => Pick<Facts, "propose" | "list" | "usableFacts">;
  items: () => Pick<Items, "settleGroupIn" | "reviseOwnItem" | "detail">;
  /** Both, or no Brief is drafted: the counter-move holds the evidence alone. */
  start?: () => StartBrief;
  readPage?: ReadPage;
  now?: () => Date;
};
export type Made = { created: number; joined: number };

type Answer = Awaited<ReturnType<typeof unmovedAnswers>>[number];
const sightingOf = (a: Answer): Sighting => ({
  changeId: a.id,
  source: a.source as Source,
  lines: linesOf(a.detail as ChangeDetail),
  before: { id: a.before.id, readAt: a.before.readAt.toISOString() },
  after: { id: a.after.id, readAt: a.after.readAt.toISOString(), url: a.after.url },
});
const isMove = (k: string | null): k is CounterMove => (COUNTER_MOVES as readonly string[]).includes(k ?? "");
const factText = (f: { field: string; subject: string; value: string }) => `${f.field}${f.subject ? ` (${f.subject})` : ""}: ${f.value}`;

export function createMoves(d: MovesDeps) {
  const now = d.now ?? (() => new Date());

  /** The counter-move's payload changed by `f`, if it is still waiting; null when it isn't. */
  async function update(workspaceId: string, itemId: string, f: (p: MovePayload) => MovePayload): Promise<MovePayload | null> {
    const shown = await d.items().detail(workspaceId, itemId);
    if (!shown || shown.item.kind !== MOVE_KIND || !WAITING.includes(shown.item.state)) return null;
    const payload = shown.content as MovePayload;
    const next = f(payload);
    if (next === payload) return payload;
    const { title, workArea, warnings, groupKey } = shown.item;
    const r = await d.items().reviseOwnItem(workspaceId, itemId, { payload: next, details: { title, workArea, warnings, groupKey }, actor: ACTOR });
    return r.ok ? next : null;
  }

  /** What the Workspace has on file about the competitor: its competitor Fact's value, if any. */
  async function onFileFor(workspaceId: string, p: MovePayload) {
    const name = p.competitor.name.trim().toLowerCase();
    return (await d.facts().list(workspaceId)).find((f) => f.field === "competitor" && f.subject === name)?.value ?? null;
  }

  /** Starts the move's draft over every sighting so far. No route (the eval gate) leaves the evidence as it is. */
  async function startDraft(workspaceId: string, itemId: string, p: MovePayload) {
    if (p.move === "post") await startPost(workspaceId, itemId, p);
    else await startBrief(workspaceId, itemId, p);
  }

  async function startPost(workspaceId: string, itemId: string, p: MovePayload) {
    if (!d.start) return;
    const onFile = await onFileFor(workspaceId, p);
    const theirs = [...p.sightings.flatMap((s) => s.lines), ...(onFile ? [onFile] : [])];
    const text = postInput(p.competitor.name, onFile, p.sightings.map((x) => ({ source: x.source, readAt: x.after.readAt, lines: x.lines })));
    const r = await d.start()(workspaceId, { agent: counterPost.id, input: { text, itemId, theirs }, schedule: true });
    // A draft over fewer sightings is out of date once this one starts.
    if (r.ok) await update(workspaceId, itemId, (x) => ({ ...x, postRunId: r.run.id, post: null, briefNote: null }));
  }

  /** Reads our comparison page and starts a draft over every sighting so far. */
  async function startBrief(workspaceId: string, itemId: string, p: MovePayload) {
    if (p.move !== "comparison_page" || !p.target || !d.start || !d.readPage) return;
    const read = await d.readPage(p.target);
    if (!read.ok) {
      await update(workspaceId, itemId, (x) => ({ ...x, briefNote: `Couldn't read your comparison page: ${read.reason}` }));
      return;
    }
    const onFile = await onFileFor(workspaceId, p);
    const page = { url: p.target, title: read.title, metaDescription: read.metaDescription, text: read.text };
    const theirs = [...p.sightings.flatMap((s) => s.lines), ...(onFile ? [onFile] : [])];
    const r = await d.start()(workspaceId, { agent: comparisonBrief.id, input: { text: comparisonInput(p.competitor.name, onFile, p.sightings.map((x) => ({ source: x.source, readAt: x.after.readAt, lines: x.lines })), page), itemId, page, theirs, read: p.sightings.map((x) => x.after.readAt) }, schedule: true });
    // A draft over fewer sightings is out of date once this one starts.
    if (r.ok) await update(workspaceId, itemId, (x) => ({ ...x, briefRunId: r.run.id, brief: null, briefNote: null }));
  }

  /** One more sighting on a counter-move still waiting, and a fresh draft over all of them; a decided one keeps what was decided. */
  async function join(workspaceId: string, itemId: string, s: Sighting) {
    const before = await d.items().detail(workspaceId, itemId);
    const had = before?.item.kind === MOVE_KIND ? (before.content as MovePayload).sightings.length : 0;
    const next = await update(workspaceId, itemId, (p) => addSighting(p, s));
    if (next && next.sightings.length > had) await startDraft(workspaceId, itemId, next);
  }

  /** A new counter-move for the event `rootId` starts, from its first Change seen here. */
  async function create(workspaceId: string, kind: CounterMove, rootId: string, a: Answer, s: Sighting): Promise<boolean> {
    if (kind === "fact_update") {
      const r = await d.facts().propose(workspaceId, {
        field: "competitor",
        subject: a.competitor,
        value: factValue(s.source, s.after.readAt, a.detail as ChangeDetail),
        source: factSource(a.competitor, s.source, s.after),
        confidence: "high",
        untrustedInput: true,
        actor: ACTOR,
      });
      // ponytail: Brand already saying this gives no Item, so the answer is tried again until it ages out (4 weeks, no effect).
      if (!r.ok || !r.item) return false;
      await inWorkspace(workspaceId, (tx) => setItemId(tx, a.id, r.item!.id));
      return true;
    }
    const target = kind === "comparison_page" ? a.comparisonUrl : null;
    const first = movePayload(kind, { id: a.competitorId, name: a.competitor }, target, a.reason ?? "", s);
    const payload = kind === "comparison_page" && !target ? { ...first, briefNote: noPageNote(a.competitor) } : first;
    const details = { title: moveTitle(kind, a.competitor, s.lines[0]), workArea: WORK_AREA, warnings: [] };
    // The Item and the link to it commit together, so a retry finds the link and makes no second one.
    const itemId = await inWorkspace(workspaceId, async (tx) => {
      const settled = await d.items().settleGroupIn(tx, workspaceId, { kind: MOVE_KIND, groupKey: `${MOVE_KIND}:${rootId}`, actor: ACTOR, next: { payload, details } });
      await setItemId(tx, a.id, settled.itemId!);
      return settled.itemId!;
    });
    await startDraft(workspaceId, itemId, payload);
    return true;
  }

  return {
    /** After labels are stored: every answer of the last 4 weeks without a counter-move gets one, or joins its event's. */
    async make(workspaceId: string): Promise<Made> {
      const since = new Date(now().getTime() - CHANGES_SHOWN_DAYS * DAY_MS);
      const made: Made = { created: 0, joined: 0 };
      for (const a of await inWorkspace(workspaceId, (tx) => unmovedAnswers(tx, since))) {
        // Read again each time: the answer before this one may have just made its event's Item.
        const links = await inWorkspace(workspaceId, answerLinks);
        const rootId = rootOf(a.id, new Map(links.map((l) => [l.id, l.sameAs])));
        const root = links.find((l) => l.id === rootId)!;
        const s = sightingOf(a);
        if (root.itemId) {
          await join(workspaceId, root.itemId, s);
          await inWorkspace(workspaceId, (tx) => setItemId(tx, a.id, root.itemId!));
          made.joined++;
        } else if (isMove(root.kind) && (await create(workspaceId, root.kind, rootId, a, s))) {
          made.created++;
        }
      }
      return made;
    },

    /**
     * Where a comparison_brief run's draft lands. Only the counter-move's latest run counts; an older one
     * is dropped. A draft that fails the checks is refused, and the counter-move says so. Safe to call twice.
     */
    briefSink: (async (workspaceId, proposal, context) => {
      const input = context.input as Partial<BriefInput> | null;
      if (!input?.itemId || !input.page || !input.theirs) return { ok: false, code: "no_input" };
      const shown = await d.items().detail(workspaceId, input.itemId);
      if (!shown || shown.item.kind !== MOVE_KIND) return { ok: false, code: "no_item" };
      const current = shown.content as MovePayload;
      if (current.briefRunId !== context.runId || current.brief !== null || !WAITING.includes(shown.item.state)) return { ok: true, itemId: null };
      const body = proposal.body as ComparisonBrief;
      const brief: ComparisonBrief = { edits: body.edits, cantTell: body.cantTell, steered: body.steered };
      const ours = new Map((await d.facts().usableFacts(workspaceId)).map((f) => [f.id, factText(f)]));
      const page = [input.page.text, input.page.title ?? "", input.page.metaDescription ?? ""];
      const problems = comparisonProblems(brief, { page, theirs: input.theirs, ours, read: input.read ?? [] }, norm);
      if (problems.length) {
        await update(workspaceId, input.itemId, (p) => (p.briefRunId === context.runId ? { ...p, briefNote: REFUSED_NOTE } : p));
        return { ok: false, code: `brief_refused: ${problems.join("; ")}`.slice(0, 400) };
      }
      const markdown = comparisonMarkdown(brief, input.page.url, current.competitor.name);
      const done = await update(workspaceId, input.itemId, (p) => (p.briefRunId === context.runId ? { ...p, brief: { ...brief, markdown }, briefNote: null } : p));
      return { ok: true, itemId: done ? input.itemId : null };
    }) satisfies Sink,

    /**
     * Where a counter_post run's draft lands, on the same terms as a Brief: only the latest run counts, a
     * draft that fails the checks is refused and the counter-move says so, and a second call does nothing.
     * A post of "" is the run saying there's nothing worth posting; its reason becomes the note.
     */
    postSink: (async (workspaceId, proposal, context) => {
      const input = context.input as Partial<PostInput> | null;
      if (!input?.itemId || !input.theirs) return { ok: false, code: "no_input" };
      const shown = await d.items().detail(workspaceId, input.itemId);
      if (!shown || shown.item.kind !== MOVE_KIND) return { ok: false, code: "no_item" };
      const current = shown.content as MovePayload;
      if (current.postRunId !== context.runId || (current.post ?? null) !== null || !WAITING.includes(shown.item.state)) return { ok: true, itemId: null };
      const body = proposal.body as CounterPost;
      const post: CounterPost = { text: body.text.trim(), theirs: body.theirs, citations: body.citations, cantTell: body.cantTell, steered: body.steered };
      const ours = new Map((await d.facts().usableFacts(workspaceId)).map((f) => [f.id, { version: f.version, text: factText(f) }]));
      const problems = postProblems(post, { theirs: input.theirs, ours }, norm);
      if (problems.length) {
        await update(workspaceId, input.itemId, (p) => (p.postRunId === context.runId ? { ...p, briefNote: REFUSED_NOTE } : p));
        return { ok: false, code: `post_refused: ${problems.join("; ")}`.slice(0, 400) };
      }
      // The cited Facts' words go with the post, so the card shows what it rests on.
      const facts = post.citations.map((c) => ({ id: c.factId, text: ours.get(c.factId)!.text }));
      const note = post.text ? null : post.cantTell;
      const done = await update(workspaceId, input.itemId, (p) => (p.postRunId === context.runId ? { ...p, post: { ...post, facts }, briefNote: note } : p));
      return { ok: true, itemId: done ? input.itemId : null };
    }) satisfies Sink,
  };
}
export type Moves = ReturnType<typeof createMoves>;
