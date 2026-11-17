// SPDX-License-Identifier: AGPL-3.0-only
// A week's Briefs for one Workspace: pick candidates, read each page, start the brief agent on it,
// and when an agent hands a Brief over, check its quotes against the page before it reaches a
// person. Approving a Brief keeps it in seo_briefs; nothing is published or sent.
import type { Sink } from "../../agents/index";
import type { ItemKind, Items } from "../../items/index";
import { briefHistory, briefItemForRun, briefOfRun, briefsBeingWritten, briefWaiting, BRIEF_KIND, insertBrief, pagesToSkip, workspaceName, type NewBrief } from "../adapters/briefs-repo";
import { briefMarkdown, briefProblems, type Brief } from "../domain/brief";
import { BRIEFS_PER_WEEK, briefInputText, candidateFor, QUIET_DAYS, tryOrder, whyPicked, type Candidate, type Selector, type WeeklyCandidate } from "../domain/pick";
import { pageBrief } from "../definitions/page-brief";
import type { PageRead } from "./read-page";
import { SEARCH_DEFAULTS, type Refused, type Seo } from "./search-console";

const DAY_MS = 86_400_000;
const ACTOR = { system: "seo" } as const;
/** A run notes at most this many skipped pages, so the note stays small. */
const NOTED_SKIPS = 10;

export type StartBrief = (workspaceId: string, a: { agent: string; input: BriefInput; key?: string; tainted?: boolean } & ({ startedBy: string } | { schedule: true })) => Promise<{ ok: true; run: { id: string } } | { ok: false; reason: string }>;
/** The Campaign step a Brief was asked for by, with the names a person sees. */
export type BriefStep = { campaignId: string; stepKey: string; campaign: string; step: string };
/** Where a step's Brief run stands, read from the agent run and the Brief Item it made. */
export type StepBriefState =
  | { state: "running" }
  | { state: "failed" | "no_brief"; reason: string }
  | { state: "waiting" | "approved" | "dismissed"; itemId: string };
type RunOf = (workspaceId: string, runId: string) => Promise<{ status: string; statusReason: string | null; rejections: string[] } | undefined>;
type Window = { startDate: string; endDate: string };
type ReadOk = Extract<PageRead, { ok: true }>;
export type BriefInput = {
  text: string;
  candidate: Candidate;
  window: Window;
  previous: Window;
  page: { url: string; title: string | null; metaDescription: string | null; text: string; readAt: string };
  /** Set when a Campaign step asked for this Brief. */
  step?: BriefStep;
};
/** What a run did, kept on the Search Console connection and shown on the SEO page. */
export type RunNote = {
  week: string;
  at: string;
  by: "schedule" | "person";
  started: { page: string; query: string; selector: WeeklyCandidate["selector"] }[];
  skipped: { page: string; reason: string }[];
  /** Why the run stopped before starting any, when it did. */
  stopped: string | null;
};

/** The Brief history lists this many, newest first. */
const HISTORY = 100;
/** A Brief's "after" is the 28 days of search data following its approval, which Search Console has 3 days later. */
const AFTER_DAYS = SEARCH_DEFAULTS.summaryDays + SEARCH_DEFAULTS.lagDays;
/** Search Console keeps 16 months; a Brief approved earlier than this can't be checked any more. */
const KEPT_DAYS = 480;

/** One past Brief: its page and search, where it stands, and clicks before and after when Direx has them. */
export type BriefHistoryRow = {
  itemId: string;
  page: string;
  query: string;
  state: "draft" | "needs_approval" | "scheduled" | "applied" | "cancelled";
  createdAt: string;
  appliedAt: string | null;
  /** The day the 28 days after approval are in Search Console. */
  checkOn: string | null;
  /** Clicks for this search on this page over the 28 days that picked the Brief, before it was written. */
  before: { clicks: number; startDate: string; endDate: string } | null;
  /**
   * Clicks for this search on this page over the 28 days from approval, read live from Search Console once
   * those days are in it. Null before the check day, past Search Console's 16 months, or when it can't be read.
   */
  after: number | null;
};

/** A run still going holds its week this long, so a second press can't start a second run. */
const RUNNING_MS = 10 * 60_000;

/** The Monday, in UTC, of the week `at` falls in: the key that lets a Workspace run once a week. */
export const weekOf = (at: Date) => new Date(at.getTime() - ((at.getUTCDay() + 6) % 7) * DAY_MS).toISOString().slice(0, 10);

/**
 * Whether this week's run is used up: one started a Brief, or one is still going. A run that started
 * none can be tried again, since it had nothing to show.
 */
const weekTaken = (note: RunNote | null, at: Date) => note?.week === weekOf(at) && (note.started.length > 0 || at.getTime() - Date.parse(note.at) < RUNNING_MS);

export type BriefsDeps = {
  seo: () => Pick<Seo, "candidates" | "briefsRun" | "saveBriefsRun" | "pageNumbers" | "clicksOver">;
  readPage: (url: string) => Promise<PageRead>;
  start: () => StartBrief;
  /** Workspaces with Search Console connected, for the weekly run. */
  workspaces: () => Promise<string[]>;
  /** An agent run's status and its refused hand-overs, for a step's Brief. */
  runOf?: () => RunOf;
  now?: () => Date;
};

export function createBriefs(deps: BriefsDeps) {
  const now = deps.now ?? (() => new Date());

  /** One Workspace's run for this week. A person's run uses their model sign-in; the schedule's, the shared one. */
  async function run(workspaceId: string, by: { userId: string } | "schedule"): Promise<{ ok: true; note: RunNote } | Refused | { ok: false; reason: "already_ran" | "no_workspace" }> {
    const at = now();
    const week = weekOf(at);
    const last = (await deps.seo().briefsRun(workspaceId)) as RunNote | null;
    if (weekTaken(last, at)) return { ok: false, reason: "already_ran" };
    const name = await workspaceName(workspaceId);
    if (name === null) return { ok: false, reason: "no_workspace" };
    const c = await deps.seo().candidates(workspaceId, name);
    if (!c.ok) return c;

    const note: RunNote = { week, at: at.toISOString(), by: by === "schedule" ? "schedule" : "person", started: [], skipped: [], stopped: null };
    // Saved first, so a second press or the weekly job finds this week taken.
    await deps.seo().saveBriefsRun(workspaceId, note);
    const skip = new Set(await pagesToSkip(workspaceId, new Date(at.getTime() - QUIET_DAYS * DAY_MS)));
    const skipped = (page: string, reason: string) => void (note.skipped.length < NOTED_SKIPS && note.skipped.push({ page, reason }));
    for (const candidate of tryOrder(c, skip)) {
      if (note.started.length === BRIEFS_PER_WEEK) break;
      // One page going wrong is noted and passed over; it never costs the others their Brief.
      try {
        const read = await deps.readPage(candidate.page);
        if (!read.ok) {
          skipped(candidate.page, read.reason);
          continue;
        }
        const input = inputFor(candidate, c.current, c.previous, read);
        const started = await deps.start()(workspaceId, { agent: pageBrief.id, input, ...(by === "schedule" ? { schedule: true as const } : { startedBy: by.userId }) });
        if (!started.ok) {
          note.stopped = started.reason;
          break;
        }
        note.started.push({ page: candidate.page, query: candidate.query, selector: candidate.selector });
      } catch (e) {
        console.error(`seo briefs: ${candidate.page}:`, e);
        skipped(candidate.page, "failed");
      } finally {
        // Kept as it goes, so the SEO page shows what started even if the run is cut short.
        await deps.seo().saveBriefsRun(workspaceId, note);
      }
    }
    await deps.seo().saveBriefsRun(workspaceId, note);
    return { ok: true, note };
  }

  return {
    run,
    /** The weekly job: every Workspace with Search Console, one at a time, a failure in one not stopping the rest. */
    async weekly() {
      for (const workspaceId of await deps.workspaces()) {
        try {
          await run(workspaceId, "schedule");
        } catch (e) {
          console.error(`seo briefs: workspace ${workspaceId}:`, e);
        }
      }
    },
    /**
     * A Brief a Campaign step asks for: one page and search, started as the person who pressed
     * Make brief. Outside the weekly run, so it neither uses up nor waits for the week.
     */
    async startForStep(workspaceId: string, a: { page: string; query: string; step: BriefStep; userId: string }): Promise<{ ok: true; run: { id: string } } | { ok: false; reason: string }> {
      const read = await deps.readPage(a.page);
      if (!read.ok) return { ok: false, reason: read.reason };
      const { current, previous, numbers } = await deps.seo().pageNumbers(workspaceId, a.page, a.query);
      const candidate: Candidate = { selector: "step", page: a.page, query: a.query.trim(), numbers, asked: { campaign: a.step.campaign, step: a.step.step } };
      return deps.start()(workspaceId, { agent: pageBrief.id, input: { ...inputFor(candidate, current, previous, read), step: a.step }, startedBy: a.userId });
    },

    /**
     * A Brief a person asked for on one row of the candidate lists. Like a step's Brief it is outside
     * the weekly run; it waits for approval like every Brief, and a second one for the same page and
     * search is refused while the first waits.
     */
    /** `ask` carries an accepted Ask start's key and taint. */
    async writeOne(workspaceId: string, a: { page: string; query: string; userId: string }, ask?: { key: string; tainted: boolean }): Promise<{ ok: true; run: { id: string } } | Refused | { ok: false; reason: string }> {
      const name = await workspaceName(workspaceId);
      if (name === null) return { ok: false, reason: "no_workspace" };
      const c = await deps.seo().candidates(workspaceId, name);
      if (!c.ok) return c;
      const candidate = candidateFor(c, a.page, a.query);
      if (!candidate) return { ok: false, reason: "not_a_candidate" };
      // ponytail: two presses in the same instant can both pass this check; a lock per page and search if that shows up.
      if (await briefWaiting(workspaceId, pageBrief.id, a.page, a.query)) return { ok: false, reason: "brief_waiting" };
      const read = await deps.readPage(candidate.page);
      if (!read.ok) return { ok: false, reason: read.reason };
      return deps.start()(workspaceId, { agent: pageBrief.id, input: inputFor(candidate, c.current, c.previous, read), startedBy: a.userId, ...ask });
    },

    history: (workspaceId: string) => briefsHistory(workspaceId, { clicksOver: deps.seo().clicksOver, now }),

    async stepBrief(workspaceId: string, runId: string): Promise<StepBriefState> {
      const item = await briefOfRun(workspaceId, runId);
      return stepBriefState((await deps.runOf?.()(workspaceId, runId)) ?? null, item);
    },

    /** What the SEO page shows: the latest run, and whether this week's has happened. */
    async latest(workspaceId: string) {
      const note = (await deps.seo().briefsRun(workspaceId)) as RunNote | null;
      return { note, ranThisWeek: weekTaken(note, now()) };
    },
  };
}
export type Briefs = ReturnType<typeof createBriefs>;

/**
 * Past Briefs, newest first: the page, the search, where each stands and the clicks Direx has for it;
 * and the page and search of each Brief still being written, which has no Item yet.
 */
export async function briefsHistory(
  workspaceId: string,
  live?: { clicksOver: Seo["clicksOver"]; now: () => Date },
): Promise<{ briefs: BriefHistoryRow[]; writing: { page: string; query: string }[] }> {
  const writing = await briefsBeingWritten(workspaceId, pageBrief.id);
  const briefs = (await briefHistory(workspaceId, HISTORY)).map((r) => ({
    itemId: r.itemId,
    page: r.page,
    query: r.query,
    state: r.state as BriefHistoryRow["state"],
    createdAt: r.createdAt.toISOString(),
    appliedAt: r.appliedAt?.toISOString() ?? null,
    checkOn: r.appliedAt ? new Date(r.appliedAt.getTime() + AFTER_DAYS * DAY_MS).toISOString().slice(0, 10) : null,
    // A slipping Brief was picked on impressions alone, and a step's may have had no numbers, so neither has clicks.
    before: typeof r.numbers?.clicks === "number" && r.window ? { clicks: r.numbers.clicks, startDate: r.window.startDate, endDate: r.window.endDate } : null,
    after: null as number | null,
  }));
  if (live) {
    const today = live.now().toISOString().slice(0, 10);
    const oldest = new Date(live.now().getTime() - KEPT_DAYS * DAY_MS).toISOString().slice(0, 10);
    // ponytail: one Search Console read per checked Brief (at most HISTORY); group by window if that gets slow.
    for (const b of briefs) {
      if (!b.appliedAt || !b.checkOn || b.checkOn > today) continue;
      const startDate = b.appliedAt.slice(0, 10);
      if (startDate < oldest) continue;
      const endDate = new Date(Date.parse(`${startDate}T00:00:00Z`) + (SEARCH_DEFAULTS.summaryDays - 1) * DAY_MS).toISOString().slice(0, 10);
      b.after = (await live.clicksOver(workspaceId, { startDate, endDate }, [b]))?.[0] ?? null;
    }
  }
  return { briefs, writing };
}

const RUN_GOING = new Set(["queued", "running", "waiting"]);

/** A Brief Item, once there is one, says where things stand; until then the run does. */
export function stepBriefState(run: Awaited<ReturnType<RunOf>> | null, item: { id: string; state: string | null } | null): StepBriefState {
  if (item) return { state: item.state === "applied" ? "approved" : item.state === "cancelled" ? "dismissed" : "waiting", itemId: item.id };
  if (!run) return { state: "failed", reason: "run_missing" };
  if (RUN_GOING.has(run.status)) return { state: "running" };
  // A run that finished without a Brief either found no gaps or had its Brief refused by the quote check.
  if (run.status === "succeeded") return { state: "no_brief", reason: run.rejections[0] ?? "no_gaps" };
  return { state: "failed", reason: run.statusReason ?? run.status };
}

function inputFor(candidate: Candidate, current: Window, previous: Window, read: ReadOk): BriefInput {
  const page = { url: candidate.page, title: read.title, metaDescription: read.metaDescription, text: read.text, readAt: read.readAt.toISOString() };
  return { text: briefInputText(candidate, whyPicked(candidate, current, previous), page), candidate, window: current, previous, page };
}

/** What a Brief Item holds: the Brief, why it was picked, and the page as it was read. */
export type BriefPayload = {
  runId: string;
  page: string;
  query: string;
  selector: Selector;
  numbers: Record<string, number>;
  others: string[];
  why: string;
  window: Window;
  brief: Brief;
  markdown: string;
  pageText: string;
  readAt: string;
  step: BriefStep | null;
};

/**
 * Where a brief agent's hand-over lands. A Brief whose quotes aren't on the page, or that writes too
 * much, is refused with why; one with no gaps makes nothing. Safe to call twice.
 */
export function briefSink(d: { items: () => Pick<Items, "createItem"> }): Sink {
  return async (workspaceId, proposal, context) => {
    const input = context.input as BriefInput;
    const brief = proposal.body as Brief;
    if (!input?.candidate || !input.page) return { ok: false, code: "no_page" };
    const { candidate, page } = input;
    if (brief.gaps.length === 0) return { ok: true, itemId: null };
    const problems = briefProblems(brief, candidate.query, [page.text, page.title ?? "", page.metaDescription ?? ""]);
    if (problems.length) return { ok: false, code: `brief_refused: ${problems.join("; ").slice(0, 400)}` };
    const done = await briefItemForRun(workspaceId, context.runId);
    if (done) return { ok: true, itemId: done };
    const payload: BriefPayload = {
      runId: context.runId,
      page: candidate.page,
      query: candidate.query,
      selector: candidate.selector,
      numbers: candidate.numbers,
      others: candidate.others ?? [],
      why: whyPicked(candidate, input.window, input.previous),
      window: input.window,
      brief: { gaps: brief.gaps, cantTell: brief.cantTell, steered: brief.steered },
      markdown: briefMarkdown(brief, candidate.page, candidate.query),
      pageText: page.text,
      readAt: page.readAt,
      step: input.step ?? null,
    };
    const path = URL.canParse(candidate.page) ? new URL(candidate.page).pathname : candidate.page;
    const made = await d.items().createItem(workspaceId, { kind: BRIEF_KIND, payload, actor: ACTOR, details: { title: `"${candidate.query}" on ${path}`, workArea: "seo", warnings: [] } });
    return made.ok ? { ok: true, itemId: made.item.id } : { ok: false, code: made.reason };
  };
}

/** Registered with items, so items never imports seo. Approving keeps the Brief; nothing leaves Direx. */
export function seoKinds(deps: { now?: () => Date } = {}): Record<string, ItemKind> {
  const now = deps.now ?? (() => new Date());
  return {
    [BRIEF_KIND]: {
      permission: "item.approve",
      async apply(tx, item, actor) {
        if (!("userId" in actor)) return { ok: false, reason: "person_required" };
        const p = item.payload as BriefPayload;
        const row: NewBrief = {
          workspaceId: item.workspaceId,
          itemId: item.id,
          pageUrl: p.page,
          query: p.query,
          selector: p.selector,
          numbers: { ...p.numbers, ...p.window },
          brief: p.brief,
          pageText: p.pageText,
          pageReadAt: new Date(p.readAt),
          approvedBy: actor.userId,
          approvedAt: now(),
        };
        await insertBrief(tx, row);
        return { ok: true };
      },
    },
  };
}
