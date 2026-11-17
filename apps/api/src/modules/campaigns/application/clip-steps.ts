// SPDX-License-Identifier: AGPL-3.0-only
// A clips step: each recording uploaded to it becomes clips, and each clip a post on one account, one
// Item per clip and account. A step takes one recording after another; a later recording's posts skip the
// days an earlier one already posts on. The clip engine and the posts module are reached through ports,
// so this module imports neither. Posts are drafted once, when a run is done; a page read drafts whatever
// a missed call back left out, and never touches a post already there, so an edited caption stays.
import type { Facts } from "../../facts";
import { warn, type Items } from "../../items";
import type { Plans } from "../../plans";
import { clipStepRunOf, clipStepRunsOf, insertClipStepRun, inWorkspace, readCampaign, stepsOf, type ClipStepRunRow, type StepRow } from "../adapters/repo";
import { spreadClips, type ClipAccount, type ClipPost } from "../domain/clip-spread";
import type { PostPort, PostTarget, StepPost } from "./campaigns";

type RunClip = { id: string; mediaId: string; startMs: number; endMs: number; title: string; caption: string; citations: string[]; measureKey: string | null; why: string };
export type ClipRunView = { id: string; state: string; failure: string | null; dropped: { moment: Omit<RunClip, "id" | "mediaId">; reason: string }[]; clips: RunClip[] };
/** What a campaign asks of the clip engine. */
export type ClipPort = {
  start: (workspaceId: string, a: { mediaId: string; planId: string; userId: string }) => Promise<{ ok: true; run: { id: string } } | { ok: false; reason: string }>;
  get: (workspaceId: string, runId: string) => Promise<ClipRunView | null>;
};
export type ClipSetup = { sourceMediaId: string; accounts: ClipAccount[]; firstAt: string };
/** One recording on a step: what was chosen, its run, and where its posts go once the run is done. */
type Recording = { row: ClipStepRunRow; setup: ClipSetup; run: ClipRunView | null; spread: ReturnType<typeof spreadClips> | null };

const CHANGED_FACT = warn("changed_since_drafted", "A Fact this clip cites changed after it was drafted. Read it before you post it by hand.");
const LIVE = new Set(["queued", "transcribing", "picking", "cutting"]);

export function clipSteps(deps: { plans: Plans; facts: Pick<Facts, "checkCitation">; items: () => Pick<Items, "addWarning">; posts?: (() => PostPort) | undefined; clips?: (() => ClipPort | undefined) | undefined; now: () => Date }) {
  const listPosts = async (workspaceId: string, step: StepRow) => (deps.posts ? ((await deps.posts().list?.(workspaceId, step.campaignId, step.stepKey)) ?? []) : []);

  async function readStep(workspaceId: string, campaignId: string, stepKey: string) {
    const read = await inWorkspace(workspaceId, async (tx) => {
      const row = await readCampaign(tx, campaignId);
      return row && { row, step: (await stepsOf(tx, campaignId)).find((s) => s.stepKey === stepKey), runs: await clipStepRunsOf(tx, campaignId, stepKey) };
    });
    if (!read) return { ok: false, reason: "not_found" } as const;
    if (read.step?.type !== "clips") return { ok: false, reason: "not_a_clips_step" } as const;
    const planStep = (await deps.plans.plan(workspaceId, read.row.planId))?.current?.steps.find((s) => s.key === stepKey);
    if (!planStep) return { ok: false, reason: "step_not_in_plan" } as const;
    return { ok: true, planId: read.row.planId, step: read.step, title: planStep.title, runs: read.runs } as const;
  }

  /**
   * The step's recordings, newest first, each finished one with its spread. Spreads are worked out oldest
   * first, each around the posts of the ones before it, so they come out as they did when drafted.
   */
  async function recordingsOf(workspaceId: string, runs: readonly ClipStepRunRow[]): Promise<Recording[]> {
    const clips = deps.clips?.();
    const taken: ClipPost[] = [];
    const out: Recording[] = [];
    for (const row of [...runs].reverse()) {
      const setup = row.setup as ClipSetup;
      const run = (await clips?.get(workspaceId, row.runId)) ?? null;
      const spread = run?.state === "done" ? spreadClips(run.clips, setup.accounts, new Date(setup.firstAt), taken) : null;
      taken.push(...(spread?.posts ?? []));
      out.unshift({ row, setup, run, spread });
    }
    return out;
  }

  /** Drafts the posts of a finished recording that aren't there yet. */
  async function draftMissing(workspaceId: string, step: StepRow, title: string, rec: Recording, have: readonly StepPost[]) {
    if (!rec.spread || !deps.posts) return;
    const drafted = new Set(have.map((p) => p.clipId));
    const targets: PostTarget[] = rec.spread.posts.filter((p) => !drafted.has(p.clipId));
    if (targets.length) await deps.posts().draft(workspaceId, { campaignId: step.campaignId, stepKey: step.stepKey, title, plannedAt: new Date(rec.setup.firstAt) }, targets, rec.row.startedBy);
  }

  /** A hand post can't be held, so one whose clip cites a Fact that moved is warned about instead. */
  async function warnChangedFacts(workspaceId: string, run: ClipRunView, posts: readonly StepPost[]) {
    for (const p of posts) {
      if (p.mode !== "manual" || p.item.state !== "needs_approval") continue;
      for (const cited of run.clips.find((c) => c.id === p.clipId)?.citations ?? []) {
        const at = cited.lastIndexOf("@");
        if ((await deps.facts.checkCitation(workspaceId, cited.slice(0, at), Number(cited.slice(at + 1)))) === "ok") continue;
        await deps.items().addWarning(workspaceId, p.itemId, CHANGED_FACT);
        break;
      }
    }
  }

  return {
    /** Adds a recording to the step, with its accounts and first post time, and starts its clip run with the Campaign's plan. */
    async makeClips(workspaceId: string, campaignId: string, stepKey: string, a: { sourceMediaId: string; accounts: ClipAccount[]; firstAt: Date }, userId: string) {
      const clips = deps.clips?.();
      if (!clips) return { ok: false, reason: "not_available" } as const;
      const read = await readStep(workspaceId, campaignId, stepKey);
      if (!read.ok) return read;
      // One recording at a time per step, so a later one is spread around posts that already exist.
      for (const row of read.runs) if (LIVE.has((await clips.get(workspaceId, row.runId))?.state ?? "")) return { ok: false, reason: "in_progress" } as const;
      const started = await clips.start(workspaceId, { mediaId: a.sourceMediaId, planId: read.planId, userId });
      if (!started.ok) return started;
      const setup: ClipSetup = { sourceMediaId: a.sourceMediaId, accounts: a.accounts, firstAt: a.firstAt.toISOString() };
      await inWorkspace(workspaceId, (tx) => insertClipStepRun(tx, { workspaceId, campaignId, stepKey, runId: started.run.id, setup, startedBy: userId, createdAt: deps.now() }));
      return { ok: true, runId: started.run.id } as const;
    },

    /** The clip engine's call back: the run is done, so its recording's posts are drafted. */
    async clipStepDone(workspaceId: string, runId: string) {
      const row = await inWorkspace(workspaceId, (tx) => clipStepRunOf(tx, runId));
      if (!row) return;
      const read = await readStep(workspaceId, row.campaignId, row.stepKey);
      if (!read.ok) return;
      const rec = (await recordingsOf(workspaceId, read.runs)).find((r) => r.row.runId === runId);
      if (rec) await draftMissing(workspaceId, read.step, read.title, rec, await listPosts(workspaceId, read.step));
    },

    /**
     * The step as its editor shows it: each recording, newest first, with its run, each clip with its
     * posts, the dropped moments, and the clips and accounts the spread left out; and the accounts the
     * last recording used, for the next one.
     */
    async clipStep(workspaceId: string, campaignId: string, stepKey: string) {
      const read = await readStep(workspaceId, campaignId, stepKey);
      if (!read.ok) return read;
      const recs = await recordingsOf(workspaceId, read.runs);
      let posts = await listPosts(workspaceId, read.step);
      if (recs.some((r) => r.spread)) {
        for (const rec of recs) await draftMissing(workspaceId, read.step, read.title, rec, posts);
        posts = await listPosts(workspaceId, read.step);
        for (const rec of recs) if (rec.spread) await warnChangedFacts(workspaceId, rec.run!, posts);
      }
      return {
        ok: true,
        recordings: recs.map(({ setup, run, spread }) => ({
          setup,
          run: run ? { id: run.id, state: run.state, failure: run.failure, dropped: run.dropped } : null,
          clips: spread ? run!.clips.map((c) => ({ ...c, posts: posts.filter((p) => p.clipId === c.id) })) : [],
          unposted: spread?.unposted ?? [],
          idle: spread?.idle ?? [],
        })),
        lastAccounts: recs[0]?.setup.accounts ?? [],
      } as const;
    },

    /** A new caption for one clip's post. Only that post is drafted again, which voids its approval. */
    async editClipCaption(workspaceId: string, campaignId: string, stepKey: string, clipId: string, text: string) {
      const read = await readStep(workspaceId, campaignId, stepKey);
      if (!read.ok) return read;
      const rec = (await recordingsOf(workspaceId, read.runs)).find((r) => r.spread?.posts.some((p) => p.clipId === clipId));
      const target = rec?.spread?.posts.find((p) => p.clipId === clipId);
      if (!rec || !target || !deps.posts) return { ok: false, reason: "not_found" } as const;
      const results = await deps.posts().draft(workspaceId, { campaignId, stepKey, title: read.title, plannedAt: new Date(rec.setup.firstAt) }, [{ ...target, text }], rec.row.startedBy);
      return { ok: true, results } as const;
    },
  };
}
