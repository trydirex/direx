// SPDX-License-Identifier: AGPL-3.0-only
// One person's Ask conversation. Each message starts one run and cancels the one still going; the
// run's single reply is stored on the message, after anything it proposes exists as an Item, so the
// panel never shows a reply that points at nothing.
import type { Agents, AskStart, Sink, WorkState } from "../../agents/index";
import type { Campaigns } from "../../campaigns/index";
import { warningsOf } from "../../core-reads/index";
import type { Facts } from "../../facts/index";
import { warn, type Items } from "../../items/index";
import type { NextSteps } from "../../next-steps/index";
import * as repo from "../adapters/repo";
import { ASK_AGENT, askRequest, nowLine, type Looking, type Reply } from "../definitions/ask";
import { RESCHEDULE_KIND } from "./reschedule";
import { ASK_START_KIND } from "./starts";

const SHOWN = 30;
const LIVE = new Set(["queued", "running", "waiting"]);
const STEP_LABELS: Record<string, string> = { read_needs_you: "Reading what needs you", read_schedule: "Reading the schedule", read_campaign: "Reading Campaigns", read_plans: "Reading plans", read_companies: "Reading companies", read_seo_pages: "Reading Search Console", read_media: "Reading videos" };
/** What a finished run read, as the line under its reply names it: "Looked at the schedule". */
const LOOKED: Record<string, string> = { read_needs_you: "what needs you", read_schedule: "the schedule", read_campaign: "Campaigns", read_plans: "plans", read_companies: "companies", read_seo_pages: "Search Console", read_media: "videos" };
/** Why a run stopped when asking again won't help until someone changes a setting. */
const SETUP: Record<string, string> = {
  no_connection: "Ask needs a model to answer. Connect a model provider on the AI models page, then ask again.",
  no_shared_sign_in: "Ask needs a model to answer. Connect a model provider on the AI models page, then ask again.",
  credential_unavailable: "The model provider's key needs attention on the AI models page. Fix it there, then ask again.",
  no_route: "No model is available for Ask yet.",
  provider_quota: "The model provider's usage limit is used up. Ask again once it resets.",
};
const OFF = "Ask is off until Direx finishes checking it on the model it would use. The rest of Direx works as usual.";

/** A stored reply: the run's reply, plus the Item it became when it made one and what the run read. */
/** `before` is a rewritten email's words when Ask took the request, so the card can show what changed. */
export type Stored = Reply & { itemId?: string; looked?: string[]; before?: { subject?: string; text: string } };
/** Where accepted work stands, from records only (rule 029): fixed words, and the Items the work made. */
export type Done = { state: WorkState | "refused"; text: string; itemIds: string[] };

export type AskDeps = {
  agents: () => Pick<Agents, "start" | "cancel" | "get">;
  items: () => Pick<Items, "view" | "createItem" | "detail">;
  nextSteps: () => Pick<NextSteps, "offerAsked"> | undefined;
  facts: () => Pick<Facts, "propose">;
  /** Rewrites a Campaign email or post. Left out, Ask can't rewrite. */
  campaigns?: () => Pick<Campaigns, "rewrite">;
  /** The work other modules let a person start from Ask, as this server runs it. Left out, none. */
  starts?: () => readonly AskStart[];
  now: () => Date;
  /** The Workspace's time zone, for the times a card names and the run's "Now is" line. Left out, as in tests, times are UTC. */
  timeZone?: (workspaceId: string) => Promise<string>;
  /** Whether Ask's route has a passing eval result. Left out, as in tests, Ask runs. */
  ready?: () => boolean;
};

const cannot = (text: string): Stored => ({ kind: "cannot", text });

const HISTORY_TURNS = 4;
const HISTORY_WINDOW_MS = 6 * 3_600_000;
const HISTORY_CHARS = 500;
/**
 * The person's last few exchanges, so a follow-up such as "it's on the 26th" has what it answers. Only
 * answered ones from the last hours, each cut short; the replies are a model's words, so it rides as data.
 */
export function historyOf(rows: readonly repo.AskMessageRow[], now: Date): string | null {
  const lines = rows
    .filter((r) => r.reply && now.getTime() - r.createdAt.getTime() <= HISTORY_WINDOW_MS)
    .map((r) => `Person: ${r.text.slice(0, HISTORY_CHARS)}\nAsk (${(r.reply as Stored).kind}): ${(r.reply as Stored).text.slice(0, HISTORY_CHARS)}`);
  return lines.length ? lines.join("\n\n") : null;
}
/** Why a Next step couldn't start, in the person's words; a code not here is named as it is. */
const NO_START: Record<string, string> = {
  not_found: "Ask couldn't find that Campaign or step.",
  plan_not_approved: "the Campaign's plan isn't approved yet",
  all_have_text: "every step already has its text",
  no_text_yet: "that step has no text yet, so there's nothing to draft emails from",
  nobody_waiting: "no one on that step is still waiting for an email",
  no_step: "Ask didn't say which step",
  drafting_mode_required: "the email step needs a drafting mode chosen first",
  wrong_mode: "that step is set to write each email per person",
  drafts_already_made: "that step already has drafts",
  mailbox_required: "the step needs a Mailbox chosen first",
  sender_identity_missing: "the Mailbox has no sender name yet",
  no_template: "that step has no text yet",
  step_cancelled: "that step was cancelled",
  step_not_in_plan: "that step isn't in the approved plan",
};
const whenIn = (at: Date, timeZone: string) => new Intl.DateTimeFormat("en-GB", { timeZone, day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", timeZoneName: "short" }).format(at);

/** Why a start can't run, in the person's words; a code not here is named as it is. */
const NO_ASK_START: Record<string, string> = {
  not_available: "that work doesn't run on this server",
  moved_on: "what it would work on changed after it was offered",
  start_failed: "it failed to start",
  no_website: "Brand hasn't read a website yet, so there's none to read again",
  no_strategy: "there's no approved Strategy saying who the business is for yet",
  no_request: "that plan has no request to draft from",
  archived: "that plan is archived",
  not_found: "Ask couldn't find what it names",
  already_reviewed: "that company has already been reviewed",
  busy: "that company is being read already",
  brief_waiting: "a brief for that page and search is already waiting",
  not_a_candidate: "that page and search aren't worth a brief now",
  in_progress: "clips are already being picked from that video",
  disabled: "that work is turned off on the Agents page",
};
const why = (code: string) => NO_ASK_START[code] ?? code.replaceAll("_", " ");
const DONE_WORDS: Record<WorkState, string> = { running: "Working on it.", done: "Done.", failed: "It stopped before it finished.", cancelled: "It was stopped." };

const NO_REWRITE: Record<string, string> = {
  from_template: "This email comes from its step's text, so edit that text on the Campaign instead.",
  already_going: "This email is already on its way, so it can't be rewritten.",
  not_a_campaign_email: "Ask can only rewrite a Campaign's email so far.",
};

export function createAsk(d: AskDeps) {
  const runOf = async (workspaceId: string, runId: string) => (await d.agents().get(workspaceId, runId)) ?? null;

  async function settle(workspaceId: string, reply: Reply, context: { runId: string; tainted: boolean }, message: { id: string; agent: string | null; itemId: string | null; userId: string }): Promise<Stored> {
    const named = message.agent;
    if (reply.kind === "answer") {
      // A cited id the Workspace doesn't hold is dropped, so a card can never point at nothing.
      const cites: string[] = [];
      for (const id of reply.cites) if (await d.items().view(workspaceId, id)) cites.push(id);
      return { ...reply, cites };
    }
    if (reply.kind === "next_step") {
      const steps = d.nextSteps();
      if (!steps) return cannot("Next steps aren't running on this server, so no card was made.");
      const r = await steps.offerAsked(workspaceId, { link: reply.link, campaignId: reply.campaignId, stepKey: reply.stepKey, onlyArea: named ?? undefined });
      if ("why" in r) return cannot(`That work can't start: ${NO_START[r.why] ?? r.why.replaceAll("_", " ")}. No card was made.`);
      if ("otherArea" in r) return cannot(`@${named} doesn't do that work; it belongs to ${r.otherArea}. Ask again without naming one, or name ${r.otherArea}.`);
      return { ...reply, itemId: r.itemId };
    }
    if (reply.kind === "rewrite") {
      // Only the Item the person asked about, so a reply can never rewrite something they weren't looking at.
      if (!message.itemId) return cannot("Open Ask from the email you want rewritten, then ask again.");
      const target = await d.items().view(workspaceId, message.itemId);
      if (!target) return cannot("That Item isn't there, so nothing was rewritten.");
      if (named && target.workArea !== named) return cannot(`@${named} doesn't write this; it belongs to ${target.workArea ?? "no work area"}.`);
      const campaigns = d.campaigns?.();
      if (!campaigns) return cannot("Rewriting isn't running on this server.");
      // The words as they stand, read before the rewrite lands on the same Item, so the card can show what changed.
      const was = (await d.items().detail(workspaceId, target.id))?.content as { subject?: unknown; text?: unknown; body?: unknown } | null | undefined;
      // Started at once, with no Item first (Ask v2 decision Q3): the person asked in this message, and the new words wait for approval.
      const r = await campaigns.rewrite(workspaceId, target.id, { instruction: reply.instruction, userId: message.userId, timeZone: (await d.timeZone?.(workspaceId)) ?? "UTC", tainted: context.tainted });
      if (!r.ok) return cannot(NO_REWRITE[r.reason] ?? `The rewrite couldn't start (${r.reason}).`);
      const text = typeof was?.text === "string" ? was.text : typeof was?.body === "string" ? was.body : null;
      return { ...reply, itemId: target.id, ...(text !== null && { before: { ...(typeof was?.subject === "string" && { subject: was.subject }), text } }) };
    }
    if (reply.kind === "start") {
      const start = d.starts?.().find((s) => s.id === reply.start);
      if (!start) return cannot(`That work can't start: ${why("not_available")}. No card was made.`);
      const args = start.args.safeParse(reply.args);
      if (!args.success) return cannot("Ask didn't say exactly what to work on, so no card was made. Ask again and name it.");
      if (named && start.area !== named) {
        return cannot(start.area ? `@${named} doesn't do that work; it belongs to ${start.area}. Ask again without naming one, or name ${start.area}.` : `@${named} doesn't do that work, and no Agent does. Ask again without naming one.`);
      }
      const checked = await start.check(workspaceId, args.data);
      if (!checked.ok) return cannot(`That work can't start: ${why(checked.why)}. No card was made.`);
      const made = await d.items().createItem(workspaceId, {
        kind: ASK_START_KIND,
        payload: { start: start.id, args: args.data, basis: checked.basis, tainted: context.tainted, messageId: message.id },
        actor: { agentRunId: context.runId },
        details: { title: checked.title, workArea: start.area, warnings: context.tainted ? [warn("untrusted_source", "came from content Direx doesn't trust")] : [] },
      });
      return made.ok ? { ...reply, itemId: made.item.id } : cannot(`The work couldn't be offered (${made.reason}).`);
    }
    if (reply.kind === "reschedule") {
      const target = await d.items().view(workspaceId, reply.itemId);
      if (!target) return cannot("That Item isn't there, so nothing was proposed.");
      if (!target.movable) return cannot(`"${target.title}" can't move now, so nothing was proposed.`);
      const at = new Date(reply.at);
      if (at <= d.now()) return cannot("That time has already passed, so nothing was proposed.");
      const made = await d.items().createItem(workspaceId, {
        kind: RESCHEDULE_KIND,
        payload: { targetId: target.id, at: at.toISOString(), from: target.at?.toISOString() ?? null },
        actor: { agentRunId: context.runId },
        details: { title: `Move "${target.title}" to ${whenIn(at, (await d.timeZone?.(workspaceId)) ?? "UTC")}`, workArea: target.workArea, warnings: context.tainted ? [warn("untrusted_source", "came from content Direx doesn't trust")] : [] },
      });
      return made.ok ? { ...reply, itemId: made.item.id } : cannot(`The move couldn't be proposed (${made.reason}).`);
    }
    if (reply.kind === "fact") {
      const r = await d.facts().propose(workspaceId, {
        field: reply.field,
        subject: reply.subject,
        value: reply.value,
        source: { kind: "chat", label: "Ask Direx" },
        confidence: "high",
        untrustedInput: context.tainted,
        actor: { agentRunId: context.runId },
      });
      if (!r.ok) return cannot(`Brand didn't take that: ${r.reason}.`);
      return r.item ? { ...reply, itemId: r.item.id } : cannot("Brand already says that.");
    }
    return reply;
  }

  /** The `ask_reply` sink. It runs while the run is live, so the reply and its Item land together. */
  const sink: Sink = async (workspaceId, proposal, context) => {
    const message = await repo.inWorkspace(workspaceId, (tx) => repo.messageOfRun(tx, context.runId));
    if (!message) return { ok: false, code: "no_message" };
    const settled = await settle(workspaceId, proposal.body as Reply, context, message);
    // The reads that came back, once each, so the panel can say what the reply rests on.
    const events = (await runOf(workspaceId, context.runId))?.events ?? [];
    const looked = [...new Set(events.filter((e) => e.kind === "tool_call" && e.outcome === "ok" && e.name in LOOKED).map((e) => LOOKED[e.name]!))];
    const stored = looked.length ? { ...settled, looked } : settled;
    await repo.inWorkspace(workspaceId, (tx) => repo.setReply(tx, message.id, stored));
    return { ok: true, itemId: stored.itemId ?? null };
  };

  /**
   * A new message replaces the question still being worked on: only the newest message's run keeps going
   * (rule 022). Each post settles this once its own run is recorded, so two sent at once can't both run:
   * whichever settles last sees both, and the older one's run is cancelled either way.
   */
  async function newestOnly(workspaceId: string, userId: string) {
    const rows = await repo.inWorkspace(workspaceId, (tx) => repo.conversation(tx, userId, HISTORY_TURNS));
    for (const r of rows.slice(0, -1)) {
      if (!r.runId || r.reply) continue;
      const run = await runOf(workspaceId, r.runId);
      if (run && LIVE.has(run.run.status)) await d.agents().cancel(workspaceId, r.runId, { source: "queued_message" });
    }
  }

  return {
    sink,

    /** Whether Ask runs at all, so the panel can say it's off before anyone types. */
    on: () => !d.ready || d.ready(),

    /** `looking` is the screen the person had open; it reaches the run only, and isn't kept with the message. */
    async post(workspaceId: string, userId: string, m: { text: string; itemId?: string | undefined; agent?: string | undefined; looking?: Looking | undefined }) {
      const attached = m.itemId ? await d.items().view(workspaceId, m.itemId) : null;
      if (m.itemId && !attached) return { ok: false, reason: "not_found" } as const;
      // Off until its evals pass on the model it would use: the message is kept and says so, and nothing runs.
      if (d.ready && !d.ready()) {
        const kept = await repo.inWorkspace(workspaceId, (tx) => repo.insertMessage(tx, { workspaceId, userId, text: m.text, itemId: m.itemId ?? null, agent: m.agent ?? null, createdAt: d.now() }));
        await repo.inWorkspace(workspaceId, (tx) => repo.setReply(tx, kept.id, cannot(OFF)));
        return { ok: true, id: kept.id } as const;
      }

      const recent = await repo.inWorkspace(workspaceId, (tx) => repo.conversation(tx, userId, HISTORY_TURNS));
      const message = await repo.inWorkspace(workspaceId, (tx) => repo.insertMessage(tx, { workspaceId, userId, text: m.text, itemId: m.itemId ?? null, agent: m.agent ?? null, createdAt: d.now() }));
      const request = askRequest(m.text, m.agent, m.looking);
      const started = await d.agents().start(workspaceId, {
        agent: ASK_AGENT,
        startedBy: userId,
        trigger: "user_request",
        key: `ask:${message.id}`,
        input: {
          request,
          brief: [nowLine(d.now(), (await d.timeZone?.(workspaceId)) ?? "UTC")],
          target: { id: attached?.id ?? null, draftRevision: attached?.revision ?? 0 },
          ...(historyOf(recent, d.now()) && { history: historyOf(recent, d.now())! }),
          ...(attached && { attached: { id: attached.id, text: `${attached.kind}, ${attached.state}${attached.reason ? ` (${attached.reason})` : ""}${attached.at ? `, planned ${attached.at.toISOString()}` : ""}, ${warningsOf(attached)}: ${attached.title}` } }),
        },
      });
      await repo.inWorkspace(workspaceId, (tx) => (started.ok ? repo.setRun(tx, message.id, started.run.id) : repo.setReply(tx, message.id, cannot(`Ask can't run right now (${started.reason}).`))));
      await newestOnly(workspaceId, userId);
      return { ok: true, id: message.id } as const;
    },

    /** The newest messages, each with its reply, or what its run is doing while it works. */
    async list(workspaceId: string, userId: string) {
      const rows = await repo.inWorkspace(workspaceId, (tx) => repo.conversation(tx, userId, SHOWN));
      const started = await repo.inWorkspace(workspaceId, (tx) => repo.startsOfMessages(tx, rows.map((r) => r.id)));
      /** The done line under an accepted start: the owner's report or the refusal, in fixed words, never a model's. */
      async function doneOf(messageId: string): Promise<Done | null> {
        const row = started.find((x) => x.messageId === messageId);
        if (!row) return null;
        if (row.refused) return { state: "refused", text: `It didn't start: ${why(row.refused)}.`, itemIds: [] };
        if (!row.workKind || !row.workId) return { state: "running", text: DONE_WORDS.running, itemIds: [] };
        const payload = (await d.items().detail(workspaceId, row.itemId))?.content as { start?: string } | undefined;
        const start = d.starts?.().find((s) => s.id === payload?.start);
        const report = start ? await start.report(workspaceId, { kind: row.workKind, id: row.workId }) : null;
        return report ? { state: report.state, text: DONE_WORDS[report.state], itemIds: report.itemIds } : null;
      }
      return Promise.all(
        rows.map(async (r) => {
          const base = { id: r.id, text: r.text, itemId: r.itemId, agent: r.agent, createdAt: r.createdAt };
          if (r.reply) {
            const reply = r.reply as Stored;
            const done = reply.kind === "start" ? await doneOf(r.id) : null;
            return { ...base, status: "done" as const, steps: [] as string[], reply, ...(done && { done }) };
          }
          const run = r.runId ? await runOf(workspaceId, r.runId) : null;
          if (run && LIVE.has(run.run.status)) {
            const steps = run.events.filter((e) => e.kind === "tool_call").map((e) => STEP_LABELS[e.name] ?? "Working");
            return { ...base, status: "working" as const, steps, reply: null };
          }
          const why = run?.run.status === "cancelled" ? "Stopped for your newer message." : (run?.run.statusReason && SETUP[run.run.statusReason]) || "Ask stopped before it had a reply. Try asking again.";
          return { ...base, status: "stopped" as const, steps: [] as string[], reply: cannot(why) };
        }),
      );
    },
  };
}
export type Ask = ReturnType<typeof createAsk>;
