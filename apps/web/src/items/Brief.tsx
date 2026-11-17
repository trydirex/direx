// SPDX-License-Identifier: AGPL-3.0-only
// The cards on Home around the queue: today at a glance, read from the same Items the Calendar shows,
// how the running Campaigns are doing, and what is coming up this week.
import type { ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { ProgressBar } from "@astryxdesign/core/ProgressBar";
import { Skeleton } from "@astryxdesign/core/Skeleton";
import { Section } from "../components/layout";
import { campaignsQuery, dayWords } from "../campaigns/actions";
import { replyCountQuery, resultsQuery } from "../outreach/actions";
import { MeasureLine } from "../plans/Fields";
import { changeWords, searchConsoleQuery, summaryQuery } from "../seo/actions";
import { addDays, BRIEF_LIMIT, briefQuery, chips, emptyStepsQuery, isoDay, rangeQuery, type Item } from "./actions";
import { StateChip } from "./StateChip";

/** Yesterday's and today's Items, sorted into what the brief says. Days are the browser's. */
export function brief(items: Pick<Item, "state" | "at">[], now: Date) {
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const yesterday = addDays(new Date(today), -1).getTime();
  const tomorrow = addDays(new Date(today), 1).getTime();
  const on = (i: Pick<Item, "at">, from: number, to: number) => !!i.at && new Date(i.at).getTime() >= from && new Date(i.at).getTime() < to;
  const count = (state: Item["state"], from: number, to: number) => items.filter((i) => i.state === state && on(i, from, to)).length;
  return {
    sentYesterday: count("sent", yesterday, today),
    sentToday: count("sent", today, tomorrow),
    scheduledToday: count("scheduled", today, tomorrow),
    heldToday: count("held", today, tomorrow),
    capped: items.length >= BRIEF_LIMIT,
  };
}

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;
const fact = "font-medium";

/** The week's replies and opt-outs that have a reason Direx can name; the rest say nothing, so the strip stays quiet. */
export function WhyLines(p: { workspaceId: string }) {
  const read = useQuery(resultsQuery(p.workspaceId));
  const shown = (read.data?.results ?? []).filter((l) => l.why);
  if (shown.length === 0) return null;
  return (
    <ul aria-label="Why" className="flex w-full flex-col gap-1 border-t border-border pt-3 text-sm text-muted-foreground">
      {shown.map((l) => (
        <li key={l.key}>
          <span className="font-medium text-foreground">{`${l.label}: ${l.now}, against ${l.before} the week before.`}</span> {l.why}
        </li>
      ))}
    </ul>
  );
}

/** Where "since" starts: yesterday, or on a Monday, Friday, so the weekend's replies aren't missed. */
export function sinceDay(now: Date) {
  const monday = now.getDay() === 1;
  return { from: addDays(new Date(now.getFullYear(), now.getMonth(), now.getDate()), monday ? -3 : -1), words: monday ? "since Friday" : "since yesterday" };
}

/** One quiet strip beside the queue: today's sends and holds, and the replies since yesterday (since Friday on a Monday). */
export function MorningBrief(p: { workspaceId: string; now?: Date }) {
  const now = p.now ?? new Date();
  const w = { workspaceId: p.workspaceId };
  const read = useQuery(briefQuery(p.workspaceId, now));
  const items = read.data;
  // From the start of that day, to the minute, so the count doesn't change on every render.
  const { from: since, words } = sinceDay(now);
  const until = new Date(Math.ceil(now.getTime() / 60_000) * 60_000);
  const replies = useQuery(replyCountQuery(p.workspaceId, since, until));
  // Steps the plan puts on today with nothing drafted: the week below shows them, so today mustn't say nothing is planned.
  // The same seven-day read as "This week", so it comes from one request.
  const start = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const undrafted = (useQuery(emptyStepsQuery(p.workspaceId, start, 7)).data ?? []).filter((s) => s.on === isoDay(start)).length;
  // While it loads it keeps its place, so nothing beside or below it jumps; if it can't be read it says nothing.
  if (!items) return read.isError ? null : <Skeleton className="h-28 w-full rounded-card" />;
  const b = brief(items, now);
  const n = (x: number) => (b.capped ? `${x}+` : String(x));
  const going = b.scheduledToday + b.sentToday;
  return (
    <section aria-label="Today" className="flex flex-wrap items-center justify-between gap-4 rounded-card border border-border bg-card px-6 py-4">
      <ul className="flex flex-wrap items-center gap-x-8 gap-y-2">
        {going === 0 && b.heldToday === 0 && undrafted === 0 && <li className={fact}>Nothing planned today.</li>}
        {undrafted > 0 && (
          <li>
            <Link to="/w/$workspaceId/calendar" params={w} search={{ view: "day" }} className={fact}>
              {`${plural(undrafted, "step", "steps")} planned today, nothing drafted yet`}
            </Link>
          </li>
        )}
        {going > 0 && (
          <li>
            <Link to="/w/$workspaceId/calendar" params={w} search={{ view: "day" }} className={fact}>
              {`${n(going)} going out today`}
            </Link>
          </li>
        )}
        {b.heldToday > 0 && (
          <li>
            <Link to="/w/$workspaceId/calendar" params={w} search={{ view: "day" }} className={fact}>
              {`${n(b.heldToday)} held`}
            </Link>
          </li>
        )}
        {/* Replies always show, so the strip doesn't jump when they arrive; if they can't be read they say nothing. */}
        {replies.isPending ? (
          <li>
            <Skeleton className="h-5 w-40" />
          </li>
        ) : (
          replies.data && (
            <>
              <li>
                <Link to="/w/$workspaceId/people" params={w} className={fact}>
                  {`${plural(replies.data.replies, "reply", "replies")} ${words}`}
                </Link>
              </li>
              {replies.data.optedOut > 0 && (
                <li>
                  <Link to="/w/$workspaceId/people" params={w} className={fact}>
                    {`${replies.data.optedOut} asked to stop`}
                  </Link>
                </li>
              )}
            </>
          )
        )}
      </ul>
      <Link to="/w/$workspaceId/calendar" params={w} className="text-sm underline underline-offset-4">
        See the week
      </Link>
      <WhyLines workspaceId={p.workspaceId} />
    </section>
  );
}

/** A card's foot link. */
const More = (p: { workspaceId: string; to: "/w/$workspaceId/campaigns" | "/w/$workspaceId/calendar"; children: ReactNode }) => (
  <Link to={p.to} params={{ workspaceId: p.workspaceId }} className="self-start text-sm underline underline-offset-4">
    {p.children}
  </Link>
);

const numeric = (c: { measure: { target: string } | null }) => !!c.measure && c.measure.target.trim() !== "" && Number.isFinite(Number(c.measure.target));

/** A Campaign's one next thing to do, from what is already known: drafts waiting for a yes first, then this week's steps with nothing drafted. */
export function nextStep(c: { needApproval: number }, emptyThisWeek: number): { text: string; to: "review" | "campaign" } | null {
  if (c.needApproval > 0) return { text: `${c.needApproval} waiting for your approval`, to: "review" };
  if (emptyThisWeek > 0) return { text: `${plural(emptyThisWeek, "step", "steps")} this week with nothing drafted`, to: "campaign" };
  return null;
}

/** The next thing as a link to where it is done: Review for drafts, the Campaign for its empty steps. */
function NextLink(p: { workspaceId: string; campaignId: string; next: ReturnType<typeof nextStep> }) {
  if (!p.next) return null;
  const w = { workspaceId: p.workspaceId };
  const text = `Next: ${p.next.text}`;
  return p.next.to === "review" ? (
    <Link to="/w/$workspaceId/review" params={w} className="text-sm font-medium">
      {text}
    </Link>
  ) : (
    <Link to="/w/$workspaceId/campaigns/$campaignId" params={{ ...w, campaignId: p.campaignId }} className="text-sm font-medium">
      {text}
    </Link>
  );
}

/** The running Campaigns (and the ones about to start), each against its measure or its steps, and what to do next. Silent when they can't be read. */
export function CampaignsCard(p: { workspaceId: string; now?: Date }) {
  const now = p.now ?? new Date();
  const list = useQuery(campaignsQuery(p.workspaceId));
  // The same read as the week below, so it costs no extra request.
  const empty = useQuery(emptyStepsQuery(p.workspaceId, new Date(now.getFullYear(), now.getMonth(), now.getDate()), 7)).data ?? [];
  const search = useQuery(searchConsoleQuery(p.workspaceId)).data;
  const ready = !!search?.siteUrl && !search.refusal;
  const sum = useQuery({ ...summaryQuery(p.workspaceId), enabled: ready }).data;
  if (list.isError) return null;
  const shown = (list.data ?? []).filter((c) => c.status === "running" || c.status === "scheduled").sort((a, b) => Number(b.status === "running") - Number(a.status === "running")).slice(0, 3);
  const change = sum && !("reason" in sum) ? changeWords(sum.clicks, sum.previous?.clicks, sum.previous) : "";
  return (
    <Section title="How your campaigns are doing">
      {!list.data ? (
        <Skeleton className="h-32 w-full" />
      ) : shown.length === 0 ? (
        <p className="text-muted-foreground">No campaign is running. Start one and its results show here.</p>
      ) : (
        <ul className="flex flex-col divide-y divide-border">
          {shown.map((c) => (
            <li key={c.id} className="flex flex-col gap-2 py-3 first:pt-0 last:pb-0">
              <div className="flex flex-wrap items-baseline justify-between gap-2">
                <Link to="/w/$workspaceId/campaigns/$campaignId" params={{ workspaceId: p.workspaceId, campaignId: c.id }} className="font-medium">
                  {c.title}
                </Link>
                <span className="text-sm text-muted-foreground">
                  {[c.status === "scheduled" && (c.startsOn ? `Starts ${dayWords(c.startsOn)}` : "Scheduled"), !numeric(c) && c.planned > 0 && `${c.done} of ${c.planned} steps done`].filter(Boolean).join(" · ")}
                </span>
              </div>
              {/* A target written as a sentence ("Record the baseline first") has no bar to draw; the steps do. */}
              {numeric(c) ? <MeasureLine measure={c.measure!} /> : c.planned > 0 && <ProgressBar label={`${c.title} steps done`} isLabelHidden value={Math.min(c.done, c.planned)} max={c.planned} />}
              {(c.sent > 0 || c.replied > 0) && <span className="text-sm text-muted-foreground">{[c.sent > 0 && `${c.sent} sent`, c.replied > 0 && `${c.replied} replied`].filter(Boolean).join(" · ")}</span>}
              <NextLink workspaceId={p.workspaceId} campaignId={c.id} next={nextStep(c, empty.filter((s) => s.campaignId === c.id).length)} />
            </li>
          ))}
        </ul>
      )}
      {sum && !("reason" in sum) && <p className="border-t border-border pt-3 text-sm tabular-nums">{`Search: ${plural(sum.clicks, "click", "clicks")}${change ? `, ${change}` : ""}`}</p>}
      <More workspaceId={p.workspaceId} to="/w/$workspaceId/campaigns">
        {shown.length === 0 && list.data ? "Open Campaigns" : "See campaigns"}
      </More>
    </Section>
  );
}

/** How many lines one day shows; the Calendar has the rest. */
const DAY_LINES = 4;
const time = (at: string) => new Date(at).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
/** What the week shows: work that is planned, held, or waiting for a yes, so a draft not yet approved sits in its day. */
const WEEK_STATES: Item["state"][] = ["needs_approval", "scheduled", "held"];
/** A chip's mark: the most urgent state among its Items. */
const markOf = (items: Item[]) => WEEK_STATES.find((s) => items.some((i) => i.state === s)) ?? "scheduled";

/** The next seven days, one column a day: launches, then each group's time, title and state. Silent when they can't be read. */
export function ComingUp(p: { workspaceId: string; now?: Date }) {
  const now = p.now ?? new Date();
  const start = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const query = useQuery(rangeQuery(p.workspaceId, start, 7));
  // Empty slots are extra: if they can't be read, the week shows without them.
  const empty = useQuery(emptyStepsQuery(p.workspaceId, start, 7)).data ?? [];
  if (query.isError) return null;
  const planned = query.data?.items.filter((i) => WEEK_STATES.includes(i.state)) ?? [];
  const days = Array.from({ length: query.data ? 7 : 0 }, (_, n) => {
    const day = addDays(start, n);
    const lines = [
      ...query.data!.launching.filter((l) => l.on === isoDay(day)).map((l) => ({ key: `launch:${l.campaignId}`, text: `${l.title} starts`, mark: null, gap: false })),
      ...chips(planned, day).map((c) => ({ key: c.key, text: `${c.title}${c.items.length > 1 ? ` · ${c.items.length}` : ""}, ${time(c.items[0]!.at!)}`, mark: markOf(c.items), gap: false })),
      // A step the plan puts on this day with nothing drafted for it: an empty slot to fill.
      ...empty.filter((s) => s.on === isoDay(day)).map((s) => ({ key: `empty:${s.campaignId}:${s.stepKey}`, text: `${s.campaign}: ${s.title}`, mark: null, gap: true })),
    ];
    return { label: n === 0 ? "Today" : n === 1 ? "Tomorrow" : dayWords(isoDay(day)), lines };
  });
  return (
    <Section title="This week">
      {!query.data ? (
        <Skeleton className="h-32 w-full" />
      ) : days.every((d) => d.lines.length === 0) ? (
        <p className="text-muted-foreground">Nothing scheduled this week.</p>
      ) : (
        // A column a day on a wide screen; on a phone, only the days with something in them.
        <ul className="grid gap-4 split:grid-cols-7 split:gap-0 split:divide-x split:divide-border">
          {days.map((d) => (
            <li key={d.label} className={`flex min-w-0 flex-col gap-2 split:px-3 split:first:pl-0 split:last:pr-0 ${d.lines.length === 0 ? "hidden split:flex" : ""}`}>
              <h3 className="font-sans text-sm text-muted-foreground">{d.label}</h3>
              <ul className="flex flex-col gap-2">
                {d.lines.slice(0, DAY_LINES).map((l) => (
                  <li key={l.key} className={`flex flex-col items-start gap-1 text-sm wrap-break-word ${l.gap ? "rounded-sm border border-dashed border-input px-2 py-1.5 text-muted-foreground" : ""}`}>
                    <span>{l.text}</span>
                    {l.mark && l.mark !== "scheduled" && <StateChip state={l.mark} />}
                    {l.gap && <span className="text-xs">Planned, nothing drafted yet</span>}
                  </li>
                ))}
                {d.lines.length > DAY_LINES && <li className="text-sm text-muted-foreground">{`+${d.lines.length - DAY_LINES} more`}</li>}
              </ul>
            </li>
          ))}
        </ul>
      )}
      <More workspaceId={p.workspaceId} to="/w/$workspaceId/calendar">
        Open the Calendar
      </More>
    </Section>
  );
}
