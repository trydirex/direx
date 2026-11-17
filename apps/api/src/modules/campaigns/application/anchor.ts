// SPDX-License-Identifier: AGPL-3.0-only
// Moving a Campaign's launch. Every step keeps its distance from it, so steps without Items just read
// a new date; Items not yet going out move by the same number of days. Later keeps their approvals,
// earlier asks for them again, and one notice in Needs you says what happened.
import { memberEmail } from "../../identity";
import type { Items } from "../../items";
import type { Plans } from "../../plans";
import { syncedOutput } from "./step-links";
import { activeActions, anchoredCampaigns, cancelSteps, dependedOnSteps, draftedSteps, ensureStep, firstOutput, inWorkspace, latestOutput, listCampaigns, movableItems, readCampaign, requireApproved, setAnchor, setAnchorStep, setStallWaitFrom, stepsOf, waiveDependency } from "../adapters/repo";
import { datedSteps, dayWords, daysBetween, decideBy, launchMovedTitle, shiftAt, stallChoices, stallDue, type StallChoice } from "../domain/anchor";
import { stepFields } from "../domain/merge";
import type { TemplateBody } from "../definitions/drafter";
import { LAUNCH_MOVED_KIND, STALL_KIND, type StallPayload } from "./coordination";
import { moveItems } from "./plan-change";

const APPROVED: ReadonlySet<string> = new Set(["scheduled", "held"]);

export function campaignAnchor(d: { plans: Plans; items: () => Pick<Items, "redateItem" | "settleGroup" | "setTriage" | "cancel" | "detail">; now: () => Date }) {
  /** A step others wait on, its date, title and output, and each step waiting on it with whether its text uses the output. */
  async function dependency(workspaceId: string, campaignId: string, stepKey: string) {
    const read = await inWorkspace(workspaceId, async (tx) => {
      const campaign = await readCampaign(tx, campaignId);
      return campaign && { campaign, rows: await stepsOf(tx, campaignId), output: await latestOutput(tx, campaignId, stepKey) };
    });
    if (!read) return null;
    const plan = await d.plans.plan(workspaceId, read.campaign.planId);
    const planned = plan?.current ? datedSteps(plan.current, read.campaign.anchorOn).find((s) => s.key === stepKey) : undefined;
    const row = read.rows.find((r) => r.stepKey === stepKey);
    if (!planned || !row) return null;
    const dependants = read.rows
      .filter((r) => r.dependsOnStepKey === stepKey && !r.dependencyWaivedAt && !r.cancelledAt)
      .map((r) => {
        const t = r.template as TemplateBody | null;
        return { key: r.stepKey, usesOutput: t !== null && stepFields(`${t.subject}\n${t.text}`).includes(stepKey) };
      });
    return { campaign: read.campaign, row, planned, output: read.output, dependants, timeZone: read.campaign.advanceTimeZone ?? "UTC" };
  }

  const stallGroup = (campaignId: string, stepKey: string) => `${STALL_KIND}:${campaignId}:${stepKey}`;
  const closeStall = (workspaceId: string, campaignId: string, stepKey: string) =>
    d.items().settleGroup(workspaceId, { kind: STALL_KIND, groupKey: stallGroup(campaignId, stepKey), actor: { system: "campaigns" }, next: null });

  async function offerStall(workspaceId: string, campaignId: string, stepKey: string) {
    const dep = await dependency(workspaceId, campaignId, stepKey);
    if (!dep || !dep.dependants.length) return;
    const choices = stallChoices(dep.dependants);
    const ask = choices.includes("go_ahead") ? "keep waiting, go ahead without it, or cancel" : "keep waiting or cancel; a step's text links to it";
    const payload: StallPayload = { campaignId, stepKey, choices };
    await d.items().settleGroup(workspaceId, {
      kind: STALL_KIND,
      groupKey: stallGroup(campaignId, stepKey),
      actor: { system: "campaigns" },
      next: { payload, details: { title: `"${dep.planned.title}" has no URL 3 days after its date: ${ask}`, workArea: "outreach", warnings: [] } },
    });
  }

  const dayIn = (at: Date, timeZone: string) => new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(at);
  const notice = (workspaceId: string, campaignId: string, title: string) =>
    d.items().settleGroup(workspaceId, { kind: LAUNCH_MOVED_KIND, groupKey: `${LAUNCH_MOVED_KIND}:${campaignId}`, actor: { system: "campaigns" }, next: { payload: { campaignId }, details: { title, workArea: "outreach", warnings: [] } } });

  const api = {
    offerStall,

    /** Each listed Campaign's launch from `from` to `to`, inclusive, for the Calendar and for posts that would land on one. */
    async launchesBetween(workspaceId: string, from: string, to: string): Promise<{ campaignId: string; title: string; on: string }[]> {
      const rows = await inWorkspace(workspaceId, (tx) => listCampaigns(tx));
      const out: { campaignId: string; title: string; on: string }[] = [];
      for (const row of rows) {
        const plan = await d.plans.plan(workspaceId, row.planId);
        if (!plan?.current || plan.archivedAt) continue;
        const on = row.anchorOn ?? plan.current.startsOn;
        if (on >= from && on <= to) out.push({ campaignId: row.id, title: plan.title, on });
      }
      return out;
    },

    /**
     * Each approved, unpaused Campaign's steps dated `from` to `to`, inclusive, that nothing has been drafted for yet,
     * so Home's week shows an empty slot where the plan expects something. A cancelled step isn't expected any more.
     */
    async stepsWithoutDrafts(workspaceId: string, from: string, to: string): Promise<{ campaignId: string; campaign: string; stepKey: string; title: string; on: string }[]> {
      const rows = await inWorkspace(workspaceId, (tx) => listCampaigns(tx));
      const out: { campaignId: string; campaign: string; stepKey: string; title: string; on: string }[] = [];
      for (const row of rows) {
        if (row.pausedAt) continue;
        const plan = await d.plans.plan(workspaceId, row.planId);
        if (!plan?.current || plan.archivedAt) continue;
        const due = datedSteps(plan.current, row.anchorOn).filter((s) => s.on >= from && s.on <= to);
        if (!due.length) continue;
        const { drafted, cancelled } = await inWorkspace(workspaceId, async (tx) => ({
          drafted: await draftedSteps(tx, row.id),
          cancelled: new Set((await stepsOf(tx, row.id)).filter((s) => s.cancelledAt).map((s) => s.stepKey)),
        }));
        for (const s of due) if (!drafted.has(s.key) && !cancelled.has(s.key)) out.push({ campaignId: row.id, campaign: plan.title, stepKey: s.key, title: s.title, on: s.on });
      }
      return out;
    },

    /** The daily job: asks about each step others wait on whose output is overdue. One failing Campaign doesn't stop the rest. */
    async offerStalls(): Promise<void> {
      for (const s of await dependedOnSteps()) {
        try {
          const dep = await dependency(s.workspaceId, s.campaignId, s.stepKey);
          if (!dep || dep.row.cancelledAt) continue;
          const today = new Intl.DateTimeFormat("en-CA", { timeZone: dep.timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(d.now());
          const waitingSince = dep.row.stallWaitFrom ? dep.row.stallWaitFrom.toISOString().slice(0, 10) : null;
          if (stallDue({ dependencyOn: dep.planned.on, hasOutput: dep.output !== null, today, waitingSince })) await offerStall(s.workspaceId, s.campaignId, s.stepKey);
        } catch (e) {
          console.error("campaigns: stall check failed", s, e);
        }
      }
    },

    /**
     * The daily job's other half: each Campaign whose launch follows a step moves once that step's output
     * is late. A post's link is noticed here, so its launch moves within a day of it going live.
     * ponytail: daily, and the day counted is the day it was noticed; record outputs when posts publish
     * if a day matters. The move is made in the owner's name, who set the Campaign up.
     */
    async followAnchors(): Promise<void> {
      for (const c of await anchoredCampaigns()) {
        try {
          const row = await inWorkspace(c.workspaceId, (tx) => readCampaign(tx, c.campaignId));
          if (row) await api.followAnchorOutput(c.workspaceId, c.campaignId, { userId: row.ownerUserId });
        } catch (e) {
          console.error("campaigns: following the launch failed", c, e);
        }
      }
    },

    /**
     * A person's answer to a stalled step. Going ahead lets each step waiting on it make Items without
     * its output, offered only when none of their text uses it. Cancelling ends the step and every step
     * whose text uses its output, with their unsent Items; the others go ahead without it.
     */
    async resolveStall(workspaceId: string, campaignId: string, stepKey: string, choice: StallChoice, actor: { userId: string }) {
      const dep = await dependency(workspaceId, campaignId, stepKey);
      if (!dep) return { ok: false, reason: "not_found" } as const;
      if (!stallChoices(dep.dependants).includes(choice)) return { ok: false, reason: "go_ahead_not_possible" } as const;
      const at = d.now();
      const using = dep.dependants.filter((x) => x.usesOutput).map((x) => x.key);
      const rest = dep.dependants.filter((x) => !x.usesOutput).map((x) => x.key);
      const cancelled = choice === "cancel" ? [stepKey, ...using] : [];
      await inWorkspace(workspaceId, async (tx) => {
        if (choice === "wait") await setStallWaitFrom(tx, campaignId, stepKey, at);
        if (choice === "go_ahead") await waiveDependency(tx, campaignId, rest, actor.userId, at);
        if (choice === "cancel") {
          await cancelSteps(tx, campaignId, cancelled, actor.userId, at);
          await waiveDependency(tx, campaignId, rest, actor.userId, at);
        }
      });
      let itemsCancelled = 0;
      for (const key of cancelled) {
        const links = await inWorkspace(workspaceId, (tx) => activeActions(tx, campaignId, key));
        // One already sent, or with an unknown outcome, refuses to cancel, and that's the right answer for it.
        for (const link of links) if ((await d.items().cancel(workspaceId, link.itemId, actor)).ok) itemsCancelled++;
      }
      await closeStall(workspaceId, campaignId, stepKey);
      // The launch followed a step that no longer happens, so it stays on the date it had.
      if (dep.campaign.anchorStepKey && cancelled.includes(dep.campaign.anchorStepKey)) {
        await inWorkspace(workspaceId, (tx) => setAnchorStep(tx, campaignId, null, at));
        const plan = await d.plans.plan(workspaceId, dep.campaign.planId);
        const on = dep.campaign.anchorOn ?? plan?.current?.startsOn;
        if (on) await notice(workspaceId, campaignId, `Launch no longer follows "${dep.planned.title}"; it stays on ${dayWords(on)}`);
      }
      return { ok: true, cancelled, waived: choice === "wait" ? [] : rest, itemsCancelled } as const;
    },

    /**
     * With `preview`, says what the move would do and changes nothing; it can't know yet which slots are
     * over their cap. ponytail: the launch moves first and Items one by one, so a crash midway leaves
     * the rest at their old times; move again to finish.
     */
    async moveAnchor(workspaceId: string, campaignId: string, to: { on: string }, actor: { userId: string }, opts: { preview?: boolean } = {}) {
      const read = await inWorkspace(workspaceId, async (tx) => {
        const approved = await requireApproved(tx, campaignId);
        if (!approved.ok) return approved;
        const campaign = approved.campaign;
        return { ok: true as const, campaign, items: await movableItems(tx, campaignId) };
      });
      if (!read.ok) return read;
      const plan = await d.plans.plan(workspaceId, read.campaign.planId);
      if (!plan?.current) return { ok: false, reason: "not_found" } as const;
      const from = read.campaign.anchorOn ?? plan.current.startsOn;
      if (to.on === from) return { ok: false, reason: "same_anchor" } as const;
      const timeZone = read.campaign.advanceTimeZone ?? "UTC";
      const today = new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(d.now());
      if (to.on < today) return { ok: false, reason: "date_in_past" } as const;
      const days = daysBetween(from, to.on);
      const moves = read.items.map((i) => ({ ...i, to: shiftAt(i.plannedAt, days, timeZone) }));

      if (opts.preview) {
        const approved = moves.filter((m) => APPROVED.has(m.state)).length;
        return { ok: true, from, to: to.on, moved: moves.length, kept: days > 0 ? approved : 0, backToApproval: days < 0 ? approved : 0, overCap: 0, failed: 0 } as const;
      }

      await inWorkspace(workspaceId, (tx) => setAnchor(tx, campaignId, { on: to.on, userId: actor.userId }, d.now()));
      const { tally, approverIds } = await moveItems(d.items(), workspaceId, moves, actor, timeZone);
      await d.items().settleGroup(workspaceId, {
        kind: LAUNCH_MOVED_KIND,
        groupKey: `${LAUNCH_MOVED_KIND}:${campaignId}`,
        actor: { system: "campaigns" },
        next: { payload: { campaignId, from, to: to.on }, details: { title: launchMovedTitle({ from, to: to.on, ...tally, approvers: await Promise.all([...approverIds].map(async (id) => (await memberEmail(workspaceId, id)) ?? "someone who has left")) }), workArea: "outreach", warnings: [] } },
      });
      return { ok: true, from, to: to.on, ...tally } as const;
    },

    /**
     * The launch follows a step's output instead of a date, or a date again with null: a manual step's
     * link, or the post on the account a post step names as its output.
     */
    async followStep(workspaceId: string, campaignId: string, stepKey: string | null, actor: { userId: string }) {
      const read = await inWorkspace(workspaceId, async (tx) => {
        const approved = await requireApproved(tx, campaignId);
        if (!approved.ok) return approved;
        const campaign = approved.campaign;
        return { ok: true as const, campaign, rows: await stepsOf(tx, campaignId) };
      });
      if (!read.ok) return read;
      if (stepKey !== null) {
        const plan = await d.plans.plan(workspaceId, read.campaign.planId);
        const row = read.rows.find((r) => r.stepKey === stepKey);
        const outputs = !row || (row.type === "manual" && !row.cancelledAt) || (row.type === "post" && row.outputConnection !== null && !row.cancelledAt);
        if (!plan?.current?.steps.some((s) => s.key === stepKey) || !outputs) return { ok: false, reason: "not_output_step" } as const;
      }
      await inWorkspace(workspaceId, async (tx) => {
        if (stepKey) await ensureStep(tx, { workspaceId, campaignId, stepKey, now: d.now() });
        await setAnchorStep(tx, campaignId, stepKey, d.now());
      });
      if (stepKey) await api.followAnchorOutput(workspaceId, campaignId, actor);
      return { ok: true } as const;
    },

    /**
     * Once the step the launch follows has its output, a launch later than planned moves everything with
     * it. One earlier than planned moves nothing: an early page never pulls an email ahead of its date.
     */
    async followAnchorOutput(workspaceId: string, campaignId: string, actor: { userId: string }) {
      const read = await inWorkspace(workspaceId, async (tx) => {
        const campaign = await readCampaign(tx, campaignId);
        if (!campaign?.anchorStepKey) return null;
        // A post's link is picked up here, so the launch moves once it is live.
        await syncedOutput(tx, { workspaceId, campaignId, stepKey: campaign.anchorStepKey, at: d.now() });
        return { campaign, output: await firstOutput(tx, campaignId, campaign.anchorStepKey) };
      });
      if (!read?.output) return;
      const plan = await d.plans.plan(workspaceId, read.campaign.planId);
      if (!plan?.current) return;
      const day = dayIn(read.output.at, read.campaign.advanceTimeZone ?? "UTC");
      if (day > (read.campaign.anchorOn ?? plan.current.startsOn)) await api.moveAnchor(workspaceId, campaignId, { on: day }, actor);
    },
  };
  return api;
}
