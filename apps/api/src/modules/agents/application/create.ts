// SPDX-License-Identifier: AGPL-3.0-only
// The module's parts put together, apart from index.ts so routes can name the type.
import type { PgBoss } from "pg-boss";
import { memberEmail, type Mailer } from "../../identity/index";
import { isPinned, ranOnSubscription, runCost, type Deployment, type Models, type Route } from "../../models/index";
import { digestOf } from "../adapters/digest";
import { createFetchPage, createFetchSitemap, type FetchPage, type FetchSitemap } from "../adapters/fetch-page";
import { workRunWakes } from "../adapters/queue";
import * as repo from "../adapters/repo";
import { inWorkspace, type RunRow } from "../adapters/repo";
import { createLoop, type UsableFact, type WorkspaceRead } from "./loop";
import { createOffers } from "./offers";
import { createProposals, INCOMPLETE_WARNING, type Sink } from "./proposals";
import { createRuns, type CancelBy, type NotifyStarter, type RunInput, type RunLessons, type OnIncomplete } from "./runs";
import { createSettings } from "./settings";
import { brandReader } from "../definitions/brand-reader";
import type { AgentDefinition, ProposalKind } from "../definitions/define";
import { hasEnded, type RunStatus } from "../domain/states";
import { DEFAULT_CAPS, nextUtcDay } from "../domain/caps";
import { workState, type WorkReport } from "./ask-start";

const BUILT_IN = { brand_reader: brandReader as unknown as AgentDefinition<never> };
const RECENT_RUNS = 20;

export type AgentsDeps = {
  boss: PgBoss;
  deployment: Deployment;
  routes: Readonly<Record<string, Route>>;
  models: () => Pick<Models, "generate">;
  sinks: Partial<Record<ProposalKind, Sink>>;
  /** Definitions a later module owns, passed in so this module never imports it. */
  definitions?: Readonly<Record<string, AgentDefinition<never>>>;
  addWarning: (workspaceId: string, itemId: string, warning: { code: "run_incomplete"; text: string }) => Promise<void>;
  context: (workspaceId: string) => Promise<UsableFact[]>;
  /** Agent lessons, owned by the lessons module. Left out, runs carry none. */
  lessons?: RunLessons;
  notify: NotifyStarter;
  /** A run ended without a result, whatever stopped it. */
  onIncomplete?: OnIncomplete;
  fetchPage?: FetchPage;
  fetchSitemap?: FetchSitemap;
  /** Reads of a run's own Workspace by tool name, owned by core-reads. Left out, no definition can use them. */
  reads?: Readonly<Record<string, WorkspaceRead>>;
  now?: () => Date;
};

/** Tells who started a run when it stops at a limit or has to wait. */
export const starterNotice =
  (mailer: Mailer): NotifyStarter =>
  async (run, what) => {
    const to = run.startedBy && (await memberEmail(run.workspaceId, run.startedBy));
    if (!to) return;
    if (run.agent !== brandReader.id) {
      await mailer({ to, subject: "Direx hasn't finished a draft", text: what === "capped" ? "A draft reached its limit before it finished, so nothing changed. You can try again or write it yourself." : "A draft is waiting for this Workspace's run or budget limit to reset, and will carry on by itself." });
      return;
    }
    await mailer(
      what === "capped"
        ? { to, subject: "Direx stopped reading before it finished", text: "A read for Brand reached its limit. Anything it found is waiting on the Brand page, marked as coming from a read that didn't finish." }
        : { to, subject: "Direx is waiting to finish a read", text: "A read for Brand is waiting for this Workspace's run or budget limit to reset, and will carry on by itself. You can cancel it on the Brand page." },
    );
  };

export function createAgents(d: AgentsDeps) {
  const now = d.now ?? (() => new Date());
  const definitions: Readonly<Record<string, AgentDefinition<never>>> = { ...BUILT_IN, ...d.definitions };
  const warnItem = (workspaceId: string, itemId: string) => d.addWarning(workspaceId, itemId, { code: "run_incomplete", text: INCOMPLETE_WARNING });
  const runs = createRuns({ boss: d.boss, now, notify: d.notify, warnItem, lessons: d.lessons, onIncomplete: d.onIncomplete });
  const settings = createSettings({ deployment: d.deployment, now });
  // Run loops this process started and that haven't ended; only a stop waits on them.
  const loops = new Set<Promise<void>>();
  const loop = createLoop({
    models: { generate: (req) => d.models().generate(req) },
    runs,
    fetchPage: d.fetchPage ?? createFetchPage(),
    fetchSitemap: d.fetchSitemap ?? createFetchSitemap(),
    now,
    definitions,
    context: d.context,
    lessons: d.lessons,
    reads: d.reads,
    accept: createProposals({ definitions, sinks: d.sinks, warnItem, now }),
  });

  const summary = async (run: RunRow) => ({
    run,
    costMicros: await runCost(run.workspaceId, run.id),
    subscription: await ranOnSubscription(run.workspaceId, run.id),
    proposals: await inWorkspace(run.workspaceId, (tx) => repo.proposalsOf(tx, run.id)),
  });

  return {
    runGate: runs.runGate,
    /** What one agent and its Workspace may still start today and on a fresh day, under the daily run caps. A day is a UTC day. */
    capsLeft: (workspaceId: string, agent: string) =>
      inWorkspace(workspaceId, async (tx) => {
        const at = now();
        const used = await repo.usage(tx, agent, new Date(nextUtcDay(at).getTime() - 86_400_000));
        const agentPerDay = (await repo.settingsFor(tx, agent))?.maxDailyRuns ?? DEFAULT_CAPS.agentDaily;
        const workspacePerDay = DEFAULT_CAPS.workspaceDaily;
        return { agentLeftToday: Math.max(0, agentPerDay - used.agentToday), agentPerDay, workspaceLeftToday: Math.max(0, workspacePerDay - used.workspaceToday), workspacePerDay };
      }),
    /** The Items a run's proposals became, for a module that must warn on them later. */
    itemsOfRun: async (workspaceId: string, runId: string) => (await inWorkspace(workspaceId, (tx) => repo.proposalsOf(tx, runId))).flatMap((p) => (p.itemId ? [p.itemId] : [])),
    /** Where a run's work stands and the Items it made, from records only, for Ask's done line (rule 029). */
    async report(workspaceId: string, runId: string): Promise<WorkReport | null> {
      const run = await inWorkspace(workspaceId, (tx) => repo.readRun(tx, runId));
      if (!run) return null;
      const made = await inWorkspace(workspaceId, (tx) => repo.proposalsOf(tx, runId));
      return { state: workState(run.status as RunStatus), itemIds: made.flatMap((p) => (p.itemId ? [p.itemId] : [])) };
    },
    /** Drafts that lost to a person's save, for that person to use or dismiss. */
    offers: createOffers({ sinks: d.sinks, now }),
    settings: settings.get,
    changeSettings: settings.change,

    /**
     * The same input on the same day is the same run, unless that run didn't get anywhere: after
     * a failure or a cancel, asking again has to be able to try again. A scheduled run has no person
     * behind it, so it runs on the Workspace's shared model sign-in or not at all.
     */
    /** `key` replaces the derived key when the caller already has one that is unique per request, such as an Ask message id. */
    async start(workspaceId: string, a: { agent?: string; input: RunInput; key?: string; tainted?: boolean } & ({ startedBy: string; trigger?: "advance" | "user_request" } | { schedule: true })) {
      const definition = definitions[a.agent ?? brandReader.id];
      if (!definition) return { ok: false, reason: "unknown_agent" } as const;
      const route = d.routes[definition.purposes[0]!];
      if (!route) return { ok: false, reason: "no_route" } as const;
      if (!(await settings.get(workspaceId, definition.id)).enabled) return { ok: false, reason: "disabled" } as const;
      const base = a.key ?? `${definition.id}:${now().toISOString().slice(0, 10)}:${digestOf(JSON.stringify(a.input))}`;
      let idempotencyKey = base;
      for (;;) {
        const run = await runs.start(workspaceId, { definition, input: a.input, idempotencyKey, tainted: a.tainted, ...("startedBy" in a ? { startedBy: a.startedBy, trigger: a.trigger ?? "person" } : { trigger: "schedule" }), unevaluated: route.candidates.some((c) => !c.evalRef || !isPinned(c)) });
        if (run.status === "succeeded" || !hasEnded(run.status as RunStatus)) return { ok: true, run } as const;
        idempotencyKey = `${base}:${run.id}`;
      }
    },

    cancel: (workspaceId: string, runId: string, by: CancelBy) => runs.cancel(workspaceId, runId, by),

    // ponytail: a few queries per run over the latest 20, join them if the list grows.
    /** The newest runs, of one agent when it is named, so a busy agent's runs don't crowd out another's. */
    async list(workspaceId: string, agent?: string) {
      const rows = await inWorkspace(workspaceId, (tx) => repo.recentRuns(tx, RECENT_RUNS, agent));
      return Promise.all(rows.map(summary));
    },

    async get(workspaceId: string, runId: string) {
      const run = await inWorkspace(workspaceId, (tx) => repo.readRun(tx, runId));
      if (!run) return undefined;
      const [s, parts, events] = await Promise.all([summary(run), inWorkspace(workspaceId, (tx) => repo.partsOf(tx, runId)), inWorkspace(workspaceId, (tx) => repo.eventsOf(tx, runId))]);
      return { ...s, parts, events };
    },

    /** Works run wakes. The loop runs apart from the wake, so a long run doesn't hold up the queue; if it dies, its lease lapses. */
    work: () =>
      workRunWakes(d.boss, async (wake) => {
        const claimed = await runs.wake(wake);
        if (!claimed) return;
        const running = loop.execute(claimed).catch((e) => console.error("agents: a run stopped:", e));
        loops.add(running);
        void running.finally(() => loops.delete(running));
      }),

    /** Resolves once every run loop this process started has ended, so a stopping process can let them finish (ADR 0027 rule 004). */
    settled: async () => {
      await Promise.allSettled([...loops]);
    },
  };
}

export type Agents = ReturnType<typeof createAgents>;
