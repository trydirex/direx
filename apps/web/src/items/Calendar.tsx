// SPDX-License-Identifier: AGPL-3.0-only
import { DocsImport, DocsWriteBack } from "../docs/DocsImport";
import { useState, Suspense, type ComponentProps, type ComponentType, type ReactNode } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { inWorkspace } from "../api/query";
import { Notice, Page } from "../components/layout";
import { QueryBoundary } from "../components/QueryBoundary";
import { Button } from "@/components/Button";
import { Dialog, DialogHeader } from "@astryxdesign/core/Dialog";
import { DropdownMenu } from "@astryxdesign/core/DropdownMenu";
import { Skeleton } from "@astryxdesign/core/Skeleton";
import { toast } from "@/components/toast";
import { cn } from "@/lib/cn";
import { addDays, approvable, approve, approveClean, approveLabel, chips, emptyStepsQuery, isoDay, ITEM_MESSAGES, mailboxDaysQuery, mayApprove, mayEdit, message, move, needsYouQuery, onDay, RANGE_CAP, rangeQuery, STATE_LABEL, weekStart, type BulkResult, type Chip, type Item, type MailboxDay, type Role } from "./actions";
import { campaignsQuery } from "../campaigns/actions";
import { Select } from "../components/Input";
import { AddPost, CampaignBands, dayName, LaunchMarker } from "./CalendarParts";
import type { ItemDialog } from "./ItemPanel";
import { StateChip } from "./StateChip";
import { ChannelMark, channelOf } from "../components/ChannelMark";

// Keyed by work area: a post's channel is its connection's name, so channel can't pick posts out.
// Each with its channel colour, so the filter is the legend too.
const LAYERS = [
  ["outreach", "Emails", "bg-channel-email"],
  ["social", "Posts", "bg-channel-post"],
  ["newsletter", "Newsletters", "bg-channel-newsletter"],
  ["seo", "SEO", "bg-channel-seo"],
] as const;
/** The Campaign an Item belongs to, from its group key (`campaign:<id>:step:...`). */
const campaignOf = (i: Item) => /^campaign:([^:]+):/.exec(i.groupKey ?? "")?.[1];
/** A post's network: its channel is the connection, which names the network. */
const networkOf = (i: Item) => (i.workArea === "social" && i.channel) || undefined;
/** A Mailbox's day counts as nearly full from this share of its daily limit. */
const NEARLY_FULL = 0.8;
const ALL = "all";

/** A work area's channel colour, for the small square that marks a card. */
const SWATCH: Record<string, string> = Object.fromEntries(LAYERS.map(([area, , swatch]) => [area, swatch]));
const Swatch = (p: { area?: string | null }) => <span aria-hidden className={cn("inline-block size-2 shrink-0 rounded-sm", SWATCH[p.area ?? ""] ?? "bg-faint")} />;
/** A card's channel as its glyph, named for a screen reader and on hover, so colour is never the only sign; a decision with no channel keeps the plain square. */
const Mark = (p: { item: Pick<Item, "workArea" | "channel"> }) => {
  const a = p.item.workArea;
  // Only the four channels have a mark; a company review or a decision keeps the plain square.
  if (!a || !(a in SWATCH)) return <Swatch area={a} />;
  return <ChannelMark channel={channelOf(a === "social" ? (p.item.channel ?? "post") : a)} className="size-4 [&_svg]:size-2.5" />;
};
/** "1 Email", "3 Posts": a day's count of one channel, in words. */
const countOf = (k: number, label: string) => `${k} ${k === 1 && label.endsWith("s") ? label.slice(0, -1) : label}`;
/** What still needs a person is peach, as everywhere else in the app; sent work goes quiet; the rest is a white card. */
const NEEDS_YOU = "border-transparent bg-peach text-peach-foreground";
const tone = (i: Item) => (needsYou(i) ? "border-l-4 border-l-peach-foreground bg-card" : i.state === "sent" || i.state === "applied" ? "bg-muted text-muted-foreground" : "bg-card");
/** The week's rows, shared by every day so mornings line up across it. */
const SLOTS = ["Morning", "Afternoon", "Evening"] as const;
/** How many undated Items the tray lists before pointing to Home. */
const TRAY = 6;
/** A drag from the tray carries this before the Item's id, so a drop knows it has no day to come from. */
const UNDATED = "undated:";

/** The filters as the URL holds them: `hide` is work areas by comma, `needs` is true for only what needs you. */
export type Filters = { hide?: string | undefined; needs?: boolean | undefined; campaign?: string | undefined; network?: string | undefined };
/** The work areas `hide` names; one the Calendar doesn't have is dropped. */
const hiddenOf = (hide?: string) => new Set((hide ?? "").split(",").filter((a) => a in SWATCH));

export type View = "day" | "week" | "month";
const VIEWS: [View, string][] = [
  ["day", "Day"],
  ["week", "Week"],
  ["month", "Month"],
];
/** How many chips a month cell shows before "+N more" expands it. */
const MONTH_CHIPS = 3;
/** How many of a group's Items its card lists. */
const GROUP_LIST = 20;

/** A group's Items counted by state: "3 Scheduled, 2 Needs approval". */
function byState(items: Item[]): string {
  const counts = new Map<Item["state"], number>();
  for (const i of items) counts.set(i.state, (counts.get(i.state) ?? 0) + 1);
  return [...counts].map(([s, n]) => `${n} ${STATE_LABEL[s]}`).join(", ");
}

const clock = (at: string) => new Date(at).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
const midnight = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate());
const needsYou = (i: Item) => i.state === "needs_approval" || i.state === "held";
const needYou = (n: number) => `${n} ${n === 1 ? "needs" : "need"} you`;
/** Where a time falls in a week column. */
const slotOf = (at: string) => {
  const h = new Date(at).getHours();
  return h < 12 ? "Morning" : h < 17 ? "Afternoon" : "Evening";
};

/** A `YYYY-MM-DD` from the URL as a local day, or nothing when it isn't one. */
function parseDay(s?: string): Date | undefined {
  if (!s || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return undefined;
  const d = new Date(`${s}T00:00`);
  return isNaN(d.getTime()) ? undefined : d;
}

/** The days a view shows around `on`: that day, its Monday-to-Sunday week, or the whole weeks holding its month. */
export function daysOf(view: View, on: Date): Date[] {
  if (view === "day") return [midnight(on)];
  const week = view === "week";
  const start = weekStart(week ? on : new Date(on.getFullYear(), on.getMonth(), 1));
  const end = week ? addDays(start, 7) : addDays(weekStart(new Date(on.getFullYear(), on.getMonth() + 1, 0)), 7);
  const out: Date[] = [];
  for (let d = start; d < end; d = addDays(d, 1)) out.push(d);
  return out;
}

/** `on` moved by `n` days, weeks or months. */
const shift = (view: View, on: Date, n: number) =>
  view === "day" ? addDays(midnight(on), n) : view !== "month" ? addDays(weekStart(on), 7 * n) : new Date(on.getFullYear(), on.getMonth() + n, 1);

const heading = (view: View, on: Date, days: Date[]) =>
  view === "day"
    ? on.toLocaleDateString(undefined, { weekday: "long", day: "numeric", month: "long" })
    : view !== "month"
      ? `${dayName(days[0]!)} to ${dayName(days[6]!)}`
      : on.toLocaleDateString(undefined, { month: "long", year: "numeric" });


/** What is planned to go out, across every campaign, by day, week or month. */
export function Calendar(p: { workspaceId: string; role: Role;
  /** The Item dialog. Passed in, so the route file can load it on first open rather than with the screen. */
  ItemView: ComponentType<ComponentProps<typeof ItemDialog>>;
  start?: Date; initial?: Item[];
  /** The day and view from the URL; `onNavigate` asks for others. Without it both are held here, starting from `view`. */
  date?: string; view?: string; onNavigate?: (to: { date: string; view: View }) => void;
  /** The open Item from the URL; `onItem` opens or closes one. Without it the open Item is held here. */
  item?: string; onItem?: (id: string | undefined) => void;
  /** The filters from the URL; `onFilters` asks for others. Without it they are held here. */
  filters?: Filters; onFilters?: (f: Filters) => void }) {
  const client = useQueryClient();
  const asView = (v?: string): View => (VIEWS.some(([k]) => k === v) ? (v as View) : "week");
  const [own, setOwn] = useState<{ on: Date; view: View }>({ on: p.start ?? new Date(), view: asView(p.view) });
  const { on, view } = p.onNavigate ? { on: parseDay(p.date) ?? new Date(), view: asView(p.view) } : own;
  const go = (next: { on: Date; view: View }) => {
    setError(undefined);
    if (p.onNavigate) p.onNavigate({ date: isoDay(next.on), view: next.view });
    else setOwn(next);
  };
  const days = daysOf(view, on);
  const start = days[0]!;
  const today = isoDay(new Date());
  // The server refuses a move into the past, so a past day is no target.
  const past = (d: Date) => isoDay(d) < today;
  // A test's `initial` is the Items of the week holding `start`, shown in that week or one of its days; anything else loads.
  const first = p.initial && p.start && view !== "month" && weekStart(start).getTime() === weekStart(p.start).getTime();
  const query = useQuery({ ...rangeQuery(p.workspaceId, start, days.length), initialData: first ? { items: p.initial!, launching: [], more: false } : undefined });
  const lane = useQuery(mailboxDaysQuery(p.workspaceId, start, days.length));
  // Extras: when either can't be read, the Calendar shows without them.
  const gaps = useQuery({ ...emptyStepsQuery(p.workspaceId, start, days.length), enabled: view !== "month" }).data ?? [];
  const waitingAll = useQuery(needsYouQuery(p.workspaceId)).data?.items ?? [];
  // The filters live in the URL when the route passes them, so a bookmark or a shared link is a saved view.
  const [ownFilters, setOwnFilters] = useState<Filters>({});
  const filters = p.onFilters ? (p.filters ?? {}) : ownFilters;
  const setFilters = (change: Filters) => {
    const next = { ...filters, ...change };
    if (p.onFilters) p.onFilters(next);
    else setOwnFilters(next);
  };
  const hidden = hiddenOf(filters.hide);
  const setHidden = (next: Set<string>) => setFilters({ hide: [...next].join(",") || undefined });
  // Only what waits for a person, the rest out of the way.
  const onlyNeeds = filters.needs === true;
  const setOnlyNeeds = (on: boolean) => setFilters({ needs: on || undefined });
  const campaign = filters.campaign ?? ALL;
  const setCampaign = (id: string) => setFilters({ campaign: id === ALL ? undefined : id });
  const network = filters.network ?? ALL;
  const setNetwork = (n: string) => setFilters({ network: n === ALL ? undefined : n });
  const loaded = query.data?.items ?? [];
  const campaignIds = [...new Set(loaded.map(campaignOf).filter((c): c is string => Boolean(c)))];
  const networks = [...new Set(loaded.map(networkOf).filter((n): n is string => Boolean(n)))].sort();
  // Names come from the Campaign list, read only once the range holds a Campaign's Items.
  const listed = useQuery({ ...campaignsQuery(p.workspaceId), enabled: campaignIds.length > 0 || view === "week" });
  // A choice no longer in range (after paging) filters nothing.
  const byCampaign = campaignIds.includes(campaign) ? campaign : ALL;
  const byNetwork = networks.includes(network) ? network : ALL;
  const campaignName = (id: string) => listed.data?.find((c) => c.id === id)?.title ?? query.data?.launching.find((l) => l.campaignId === id)?.title ?? "Unnamed campaign";
  // Month days opened past their first few chips.
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [ownOpen, setOwnOpen] = useState<string>();
  const open = p.onItem ? p.item : ownOpen;
  const setOpen = (id: string | undefined) => (p.onItem ? p.onItem(id) : setOwnOpen(id));
  // Mounted on first open, then kept, so closing returns focus as a dialog should.
  const [opened, setOpened] = useState(Boolean(p.item));
  const show = (id: string) => {
    setOpened(true);
    setOpen(id);
  };
  const [error, setError] = useState<string>();
  // The chip whose approve or move is running.
  const [busy, setBusy] = useState<string>();
  const reload = () => client.invalidateQueries({ queryKey: inWorkspace(p.workspaceId) });

  const say = (verb: string, r: BulkResult, note = "") => {
    if (r.done) toast.add({ title: `${verb} ${r.done}.${note}` });
    setError(r.refused.length ? `${r.refused.length} didn't: ${message(r.refused[0]!.reason)}` : undefined);
  };
  async function working(key: string, action: () => Promise<void>) {
    setBusy(key);
    try {
      await action();
      await reload();
    } finally {
      setBusy(undefined);
    }
  }

  const approveChip = (c: Chip) =>
    working(c.key, async () => {
      const ready = approvable(c);
      if (c.items.length === 1) {
        const code = await approve(p.workspaceId, ready[0]!);
        setError(code ? message(code) : undefined);
        if (!code) toast.add({ title: "Approved." });
      } else {
        say("Approved", await approveClean(p.workspaceId, ready));
      }
    });

  // The day whose "Approve the day" is waiting for its confirm.
  const [confirming, setConfirming] = useState<string>();
  const approveDay = (day: Date, ready: Item[]) =>
    working(`day:${isoDay(day)}`, async () => {
      setConfirming(undefined);
      const all: BulkResult = { done: 0, ids: [], refused: [] };
      // The bulk call takes 200 at a time.
      for (let n = 0; n < ready.length; n += 200) {
        const r = await approveClean(p.workspaceId, ready.slice(n, n + 200));
        all.done += r.done;
        all.ids.push(...r.ids);
        all.refused.push(...r.refused);
      }
      say("Approved", all);
    });

  // A dropped move of an approved Item, waiting for its confirm on the day it was dropped on.
  const [pendingMove, setPendingMove] = useState<{ items: Item[]; key: string; day: Date }>();
  /** `asked`: the person already saw that approved Items go back for approval, as the Move to menu says. */
  const drop = (items: Item[], key: string, day: Date, asked = false) => {
    // An undated Item dragged from the tray gets that day at 9:00, or the next whole hour when today is past it.
    if (key.startsWith(UNDATED)) {
      const i = waitingAll.find((x) => x.id === key.slice(UNDATED.length));
      if (!i?.movable) return;
      const soon = new Date();
      soon.setHours(soon.getHours() + 1, 0, 0, 0);
      const nine = new Date(day.getFullYear(), day.getMonth(), day.getDate(), 9);
      const at = nine < soon ? soon : nine;
      return working(key, async () => say("Moved", await move(p.workspaceId, [{ id: i.id, plannedAt: at.toISOString() }]), ` It waits for approval on ${dayName(day)}.`));
    }
    // Any move voids an approval, so an Item already on that day stays put.
    const moving = items.filter((i) => (i.groupKey ?? i.id) === key && i.movable && i.at && isoDay(new Date(i.at)) !== isoDay(day));
    if (!moving.length) return;
    const approved = moving.some((i) => i.state === "scheduled");
    if (approved && !asked) return setPendingMove({ items, key, day });
    setPendingMove(undefined);
    const note = approved ? " Moved emails and posts go back for approval." : "";
    return working(key, async () => {
      say("Moved", await move(p.workspaceId, moving.map((i) => ({ id: i.id, plannedAt: onDay(new Date(i.at!), day).toISOString() }))), note);
    });
  };

  const unit = view;
  const span = view === "day" ? "on this day" : `this ${unit}`;

  const counts = (d: MailboxDay) => `${d.name}: ${d.counted} of ${d.limit} emails a day`;
  /** The month's badge on a day when an email account is at or near its daily limit; the counts are in its title. A hint: when the read fails, there is none. */
  const laneFor = (day: Date) => {
    const near = (lane.data ?? []).filter((d) => d.day === isoDay(day) && d.counted >= d.limit * NEARLY_FULL);
    if (!near.length) return null;
    const full = near.some((d) => d.counted >= d.limit);
    const said = near.map(counts).join(", ");
    return (
      <p className={cn("max-w-full self-start truncate rounded-full px-2 text-xs font-semibold", full ? "bg-destructive-tint text-destructive" : "bg-warning-tint text-warning")} title={said}>
        {full ? "Email account full" : "Email account nearly full"}
        <span className="sr-only">. {said}</span>
      </p>
    );
  };

  /** The week's and day's lane: each email account sending that day, its count against its limit as text and a bar that turns amber, then red. */
  const bars = (day: Date) =>
    (lane.data ?? [])
      .filter((d) => d.day === isoDay(day) && d.counted > 0)
      .map((d) => {
        const level = d.counted >= d.limit ? "full" : d.counted >= d.limit * NEARLY_FULL ? "near" : "";
        return (
          <div key={d.credentialId} className="flex min-w-0 flex-col gap-0.5 text-xs" title={counts(d)}>
            <p className={cn("flex min-w-0 justify-between gap-1 text-xs tabular-nums", level === "full" ? "font-semibold text-destructive" : level === "near" ? "text-warning" : "text-muted-foreground")}>
              <span className="truncate">{d.name}</span>
              <span className="shrink-0">
                {d.counted}/{d.limit}
                {level === "full" ? " full" : ""}
              </span>
            </p>
            <div aria-hidden className="h-1 overflow-hidden rounded-full bg-muted">
              <div className={cn("h-full rounded-full", level === "full" ? "bg-destructive" : level === "near" ? "bg-warning" : "bg-channel-email")} style={{ width: `${Math.min(100, (100 * d.counted) / d.limit)}%` }} />
            </div>
          </div>
        );
      });

  /** A Campaign step the plan puts on this day that nothing has been drafted for: a hatched slot, with the way to its drafts. */
  // A past day's gap can't be filled any more, so only today and later show one.
  const gapsOn = (day: Date) =>
    gaps
      .filter((s) => s.on === isoDay(day) && !past(day))
      .map((s) => (
        <div key={`${s.campaignId}:${s.stepKey}`} className="flex min-w-0 flex-col items-start gap-0.5 rounded-sm border border-dashed border-input px-2 py-1 text-xs text-muted-foreground">
          <span className="max-w-full truncate" title={`${s.campaign}: ${s.title}`}>
            {s.campaign}: {s.title}
          </span>
          <span>
            Nothing drafted yet.{" "}
            <Link to="/w/$workspaceId/campaigns/$campaignId" params={{ workspaceId: p.workspaceId, campaignId: s.campaignId }} search={{ tab: "drafts" }} className="font-medium text-foreground underline">
              Open its drafts
            </Link>
          </span>
        </div>
      ));

  /** Asks before a drop sends an approved Item back for approval. */
  const moveConfirm = (day: Date) =>
    pendingMove && isoDay(pendingMove.day) === isoDay(day) ? (
      <div role="group" aria-label={`Move to ${dayName(day)}`} className="flex flex-col items-start gap-1 rounded-sm bg-muted p-2 text-xs">
        <p>Moving this sends it back for approval. Move anyway?</p>
        <div className="flex flex-wrap gap-1">
          <Button size="sm" pending={busy === pendingMove.key} onClick={() => void drop(pendingMove.items, pendingMove.key, day, true)}>
            Move
          </Button>
          <Button size="sm" variant="outline" onClick={() => setPendingMove(undefined)}>
            Cancel
          </Button>
        </div>
      </div>
    ) : null;

  // The day whose new-post form is open.
  const [adding, setAdding] = useState<string>();
  // One "Add post" for the screen: on the first day shown that is still to come, or today; the form's When changes it.
  const addOn = days.find((d) => !past(d)) ?? midnight(new Date());

  /** A day's box: a drop target in every view. */
  const dayBox = (items: Item[], day: Date, className: string, body: ReactNode) => (
    <section
      key={day.getTime()}
      aria-label={dayName(day)}
      aria-current={isoDay(day) === today ? "date" : undefined}
      className={cn("flex min-w-0 flex-col gap-1 border-t border-border pt-2", past(day) && "bg-muted/40", className)}
      onDragOver={(e) => mayEdit(p.role) && !past(day) && e.preventDefault()}
      onDrop={(e) => mayEdit(p.role) && !past(day) && void drop(items, e.dataTransfer.getData("text/plain"), day)}
    >
      {body}
      {moveConfirm(day)}
    </section>
  );

  /** A chip with its time and channel. The day's (`full`) adds its state chip and actions; the week's writes its state and Campaign, and opens the Item panel for the rest. */
  const card = (items: Item[], c: Chip, day: Date, full: boolean) => {
    // A group leads with what still needs a person, so approving the rest can't hide it.
    const lead = c.items.find(needsYou) ?? c.items[0]!;
    const ready = approvable(c);
    const unclean = c.items.filter((i) => i.state === "needs_approval" && !i.clean);
    const single = c.items.length === 1;
    const movable = mayEdit(p.role) && c.items.some((i) => i.movable);
    const camp = campaignOf(lead);
    const time = c.items[0]!.at && clock(c.items[0]!.at);
    const meta = (full ? [time, lead.channel] : [time, STATE_LABEL[lead.state], camp && campaignName(camp)]).filter(Boolean).join(" · ");
    return (
      <div
        key={c.key}
        draggable={movable}
        onDragStart={(e) => e.dataTransfer.setData("text/plain", c.key)}
        className={cn("flex min-w-0 flex-col items-start gap-1 border", full ? "rounded-card p-3" : "rounded-control p-1 text-xs", full ? (needsYou(lead) ? "border-2 border-peach bg-card" : "border-border bg-card") : cn("border-border", tone(lead)))}
      >
        <Button variant="ghost" size="sm" className={cn("h-auto max-w-full justify-start px-1 text-left whitespace-normal text-inherit", full ? "font-semibold" : "font-medium")} onClick={() => show(lead.id)}>
          {c.title}
          {single ? "" : ` · ${c.items.length}`}
        </Button>
        {meta && (
          <p className={cn("flex max-w-full min-w-0 items-center gap-1.5 px-1 text-xs", !needsYou(lead) && "text-muted-foreground")}>
            <Mark item={lead} />
            <span className="truncate">{meta}</span>
          </p>
        )}
        {full && (
          <div className="flex flex-wrap items-center gap-2">
            <StateChip state={lead.state} />
            {/* A Campaign step's yes is due a working day before it sends; past that, it can't go out on time. */}
            {lead.state === "needs_approval" && lead.decideBy && (
              <span className={cn("rounded-sm px-1.5 text-xs font-medium tabular-nums", new Date(lead.decideBy) < new Date() ? "bg-warning-tint text-warning" : "bg-peach text-peach-foreground")}>
                {new Date(lead.decideBy) < new Date() ? "Was due" : "Decide by"} {dayName(new Date(lead.decideBy))}, {clock(lead.decideBy)}
              </span>
            )}
          </div>
        )}
        {!single && (
          <details className="w-full px-1 text-xs">
            <summary className="cursor-pointer text-muted-foreground">{byState(c.items)}</summary>
            <ul className="mt-1 flex flex-col gap-1">
              {c.items.slice(0, GROUP_LIST).map((i) => (
                <li key={i.id}>
                  <button type="button" className="text-left hover:underline" onClick={() => show(i.id)}>
                    {i.at && `${clock(i.at)} `}
                    {i.title} · {STATE_LABEL[i.state]}
                  </button>
                </li>
              ))}
              {c.items.length > GROUP_LIST && <li className="text-muted-foreground">and {c.items.length - GROUP_LIST} more</li>}
            </ul>
          </details>
        )}
        {single && lead.reason && <p className="max-w-full px-1 text-xs break-words text-muted-foreground">{lead.reason}</p>}
        {full && unclean.length > 0 && (
          <Button size="sm" variant="outline" className="h-auto max-w-full whitespace-normal" aria-label={`Review ${c.title}: ${unclean.length} with warnings`} onClick={() => show(unclean[0]!.id)}>
            Review · {unclean.length} with warnings
          </Button>
        )}
        {full && ready.length > 0 && mayApprove(p.role) && (
          <Button size="sm" className="h-auto max-w-full text-left whitespace-normal" pending={busy === c.key} aria-label={`${approveLabel(ready)}: ${c.title}`} onClick={() => void approveChip(c)}>
            {approveLabel(ready)}
          </Button>
        )}
        {/* Dragging needs a mouse; this moves the same way from a keyboard or a phone. The week leaves it to the day. */}
        {full && movable && (
          <DropdownMenu
            button={{ label: "Move to…", variant: "secondary", size: "sm", isLoading: busy === c.key, "aria-label": `Move ${c.title} to another day` }}
            header={c.items.some((i) => i.state === "scheduled") ? <p className="max-w-56 px-2 py-1 text-xs text-muted-foreground">Approved emails and posts go back for approval when moved.</p> : undefined}
            items={
              // Seven days from the chip's Monday, or from today when that has passed, so a held Item in a past week can still move.
              Array.from({ length: 7 }, (_, n) => addDays(past(weekStart(day)) ? midnight(new Date()) : weekStart(day), n))
                .filter((d) => d.getTime() !== day.getTime())
                .map((d) => ({ id: String(d.getTime()), label: dayName(d), onClick: () => void drop(items, c.key, d, true) }))
            }
          />
        )}
      </div>
    );
  };

  /** Approve every clean Item of a day, after a confirm that says how many go out. Only the day view offers it, and only for more than one chip. */
  const dayApprove = (day: Date, here: Chip[]) => {
    const ready = here.flatMap(approvable);
    if (!mayApprove(p.role) || here.filter((c) => approvable(c).length).length < 2) return null;
    const key = isoDay(day);
    return confirming === key ? (
      <div role="group" aria-label={`Approve ${dayName(day)}`} className="flex flex-col items-start gap-1 rounded-sm bg-muted p-2 text-xs">
        <p>
          {ready.length} go out as scheduled. Items with warnings stay for review.
        </p>
        <div className="flex gap-1">
          <Button size="sm" pending={busy === `day:${key}`} onClick={() => void approveDay(day, ready)}>
            Approve {ready.length}
          </Button>
          <Button size="sm" variant="outline" onClick={() => setConfirming(undefined)}>
            Cancel
          </Button>
        </div>
      </div>
    ) : (
      <Button size="sm" variant="outline" className="h-auto max-w-full self-start whitespace-normal" aria-label={`Approve the day: ${dayName(day)}, ${ready.length} with no warnings`} onClick={() => setConfirming(key)}>
        Approve the day · {ready.length}
      </Button>
    );
  };

  // A month cell has no room for the move form, so only the day and week views offer it.
  const launches = (launching: { campaignId: string; title: string; on: string }[], day: Date) =>
    launching
      .filter((l) => l.on === isoDay(day))
      .map((l) => <LaunchMarker key={l.campaignId} workspaceId={p.workspaceId} launch={l} edit={view !== "month" && mayEdit(p.role)} onMoved={reload} />);

  const skeleton =
    view === "month" ? (
      <Skeleton className="h-96 w-full" />
    ) : (
      <div className={cn("grid gap-1", view === "week" && "lg:grid-cols-7")}>
        {days.map((d) => (
          <Skeleton key={d.getTime()} className="h-30" />
        ))}
      </div>
    );

  return (
    <Page
      title="Calendar"
      actions={
        <div className="flex flex-wrap items-center gap-2">
          <div role="group" aria-label="View" className="flex gap-1">
            {VIEWS.map(([v, label]) => (
              // The day opens on today when it is in view, not on the week's first day.
              <Button key={v} size="sm" variant={v === view ? "default" : "outline"} aria-pressed={v === view} onClick={() => go({ on: v === "day" && view !== "day" && days.some((d) => isoDay(d) === today) ? new Date() : on, view: v })}>
                {label}
              </Button>
            ))}
          </div>
          <Button variant="outline" size="sm" onClick={() => go({ on: new Date(), view })}>
            Today
          </Button>
          <div className="flex items-center gap-2">
            <Button variant="outline" size="icon-sm" onClick={() => go({ on: shift(view, on, -1), view })} aria-label={`Previous ${unit}`}>
              ‹
            </Button>
            <Button variant="outline" size="icon-sm" onClick={() => go({ on: shift(view, on, 1), view })} aria-label={`Next ${unit}`}>
              ›
            </Button>
          </div>
          {mayEdit(p.role) && (
            <Button size="sm" variant="outline" aria-label="Add a post" onClick={() => setAdding(isoDay(addOn))}>
              + Add post
            </Button>
          )}
          {mayEdit(p.role) && <DocsImport workspaceId={p.workspaceId} onDone={() => void reload()} />}
          <DocsWriteBack workspaceId={p.workspaceId} />
        </div>
      }
    >
      <h2 aria-live="polite" className="-mt-4">{heading(view, on, days)}</h2>
      {/* Filter pills: each channel's colour is in its pill, so the filter is the legend too. */}
      <fieldset className="flex flex-wrap items-center gap-2">
        <legend className="sr-only">Show on the calendar</legend>
        {LAYERS.map(([area, label, swatch]) => (
          <label key={area} className={cn("flex min-h-8 cursor-pointer items-center gap-2 rounded-full border border-border px-3 text-sm has-focus-visible:outline-2 has-focus-visible:outline-offset-2 has-focus-visible:outline-ring", hidden.has(area) ? "text-muted-foreground" : "bg-card")}>
            <input
              type="checkbox"
              className="sr-only"
              checked={!hidden.has(area)}
              onChange={() => {
                const next = new Set(hidden);
                if (!next.delete(area)) next.add(area);
                setHidden(next);
              }}
            />
            <span aria-hidden className={cn("size-2.5 rounded-sm", swatch)} />
            {!hidden.has(area) && <span aria-hidden>✓</span>}
            {label}
          </label>
        ))}
        <Button size="sm" variant="outline" className={cn("rounded-full", onlyNeeds && NEEDS_YOU)} aria-pressed={onlyNeeds} onClick={() => setOnlyNeeds(!onlyNeeds)}>
          <span aria-hidden className="size-1.5 rounded-full bg-current" />
          Only what needs you
        </Button>
        {campaignIds.length > 0 && (
          <Select aria-label="Campaign" value={byCampaign} onChange={(e) => setCampaign(e.target.value)}>
            <option value={ALL}>All campaigns</option>
            {campaignIds.map((id) => (
              <option key={id} value={id}>
                {campaignName(id)}
              </option>
            ))}
          </Select>
        )}
        {networks.length > 0 && (
          <Select aria-label="Network" value={byNetwork} onChange={(e) => setNetwork(e.target.value)}>
            <option value={ALL}>All networks</option>
            {networks.map((n) => (
              <option key={n} value={n}>
                {n}
              </option>
            ))}
          </Select>
        )}
      </fieldset>
      {error && <Notice tone="error">{error}</Notice>}
      <QueryBoundary query={query} skeleton={skeleton} messages={ITEM_MESSAGES}>
        {({ items, launching, more }) => {
          const live = items.filter((i) => i.at && i.state !== "cancelled");
          const visible = live.filter((i) => (!i.workArea || !hidden.has(i.workArea)) && (byCampaign === ALL || campaignOf(i) === byCampaign) && (byNetwork === ALL || networkOf(i) === byNetwork) && (!onlyNeeds || needsYou(i)));
          const waiting = visible.filter(needsYou).length;
          const hiddenCount = live.length - visible.length;
          const undated = waitingAll.filter((i) => !i.at && i.state !== "cancelled" && (!i.workArea || !hidden.has(i.workArea)));
          return (
            <>
              <p className="text-sm">
                {waiting > 0 ? (
                  <>
                    {needYou(waiting)} {span}.{" "}
                    {/* Opens the first in place; the panel's queue carries on from there without leaving the Calendar. */}
                    <button type="button" className="cursor-pointer border-0 bg-transparent p-0 underline" onClick={() => show(visible.find(needsYou)!.id)}>
                      Review them
                    </button>
                  </>
                ) : visible.length || launching.length ? (
                  // The tray below may still hold some, so say this is about what has a day.
                  undated.length ? `Nothing with a day ${span} needs you.` : `Nothing needs you ${span}.`
                ) : (
                  <>
                    Nothing planned {span}.{" "}
                    <Link to="/w/$workspaceId/campaigns" params={{ workspaceId: p.workspaceId }} className="underline">
                      Plan a campaign
                    </Link>{" "}
                    to fill it.
                  </>
                )}
                {hiddenCount > 0 && ` ${hiddenCount} hidden by the filters above.`}
                {more && ` Showing the first ${RANGE_CAP.toLocaleString()}.`}
              </p>
              {/* What waits for a yes but has no day yet would otherwise be on no calendar at all. */}
              {undated.length > 0 && (
                <div role="group" aria-label="Not dated yet" className="flex flex-wrap items-center gap-2 rounded-card border-2 border-peach bg-card p-3">
                  <p className="text-sm font-semibold">Not dated yet · {needYou(undated.length)}</p>
                  {undated.slice(0, TRAY).map((i) => (
                    <button
                      key={i.id}
                      type="button"
                      draggable={mayEdit(p.role) && i.movable}
                      onDragStart={(e) => e.dataTransfer.setData("text/plain", `${UNDATED}${i.id}`)}
                      className="flex max-w-64 min-w-0 items-center gap-1.5 rounded-sm bg-peach px-2 py-1 text-left text-xs text-peach-foreground hover:underline"
                      onClick={() => show(i.id)}
                    >
                      <Mark item={i} />
                      <span className="truncate">{i.title}</span>
                    </button>
                  ))}
                  {undated.length > TRAY && (
                    <Link to="/w/$workspaceId" params={{ workspaceId: p.workspaceId }} className="text-xs underline">
                      {undated.length - TRAY} more on Home
                    </Link>
                  )}
                  {mayEdit(p.role) && <p className="ml-auto text-xs text-muted-foreground">Drag one onto a day, or open it to set a time.</p>}
                </div>
              )}
              {view === "month" ? (
                <div className="grid grid-cols-7 gap-1">
                  {days.slice(0, 7).map((d) => (
                    <p key={d.getTime()} aria-hidden className="text-center text-xs text-muted-foreground">
                      {d.toLocaleDateString(undefined, { weekday: "short" })}
                    </p>
                  ))}
                  {days.map((day) => {
                    // What needs a person leads, so a collapsed day never hides it behind "+N more".
                    const here = chips(visible, day).sort((a, b) => Number(b.items.some(needsYou)) - Number(a.items.some(needsYou)));
                    const outside = day.getMonth() !== on.getMonth();
                    const key = isoDay(day);
                    const isOpen = expanded.has(key);
                    const need = here.reduce((n, c) => n + c.items.filter(needsYou).length, 0);
                    return dayBox(
                      items,
                      day,
                      cn("min-h-16 sm:min-h-24", outside && "text-muted-foreground"),
                      <>
                        <div className="flex items-center gap-1">
                          <Button variant="ghost" size="sm" className={cn("h-auto self-start px-1 text-xs", outside && "text-muted-foreground", key === today && "bg-primary text-primary-foreground hover:bg-primary")} aria-label={`Open ${dayName(day)}`} onClick={() => go({ on: day, view: "day" })}>
                            {day.getDate()}
                          </Button>
                          {need > 0 && <span className={cn("ml-auto hidden rounded-sm px-1.5 text-xs font-semibold sm:inline", NEEDS_YOU)}>{needYou(need)}</span>}
                        </div>
                        {/* A phone has no room for chips in a month; the count leads to the day, with a dot for what needs you. */}
                        {here.length > 0 && (
                          <p className="flex items-center gap-1 px-1 text-xs sm:hidden">
                            {need > 0 && <span aria-hidden className="size-1.5 rounded-full bg-peach-foreground" />}
                            {here.reduce((n, c) => n + c.items.length, 0)} planned
                          </p>
                        )}
                        <div className="hidden min-w-0 flex-col gap-1 sm:flex">
                          {launches(launching, day)}
                          {laneFor(day)}
                          {(isOpen ? here : here.slice(0, MONTH_CHIPS)).map((c) => {
                            const lead = c.items.find(needsYou) ?? c.items[0]!;
                            return (
                              <button
                                key={c.key}
                                type="button"
                                draggable={mayEdit(p.role) && c.items.some((i) => i.movable)}
                                onDragStart={(e) => e.dataTransfer.setData("text/plain", c.key)}
                                onClick={() => show(lead.id)}
                                title={c.title}
                                className={cn("flex min-w-0 items-center gap-1.5 rounded-sm border border-border px-2 py-0.5 text-left text-xs", tone(lead), needsYou(lead) && "font-medium")}
                              >
                                <Mark item={lead} />
                                <span className="truncate">
                                  {c.title}
                                  {c.items.length > 1 ? ` · ${c.items.length}` : ""}
                                </span>
                              </button>
                            );
                          })}
                          {here.length > MONTH_CHIPS && (
                            <Button
                              variant="ghost"
                              size="sm"
                              className="h-auto self-start px-1 text-xs"
                              aria-expanded={isOpen}
                              onClick={() => {
                                const next = new Set(expanded);
                                if (!next.delete(key)) next.add(key);
                                setExpanded(next);
                              }}
                            >
                              {isOpen ? "Show less" : `+${here.length - MONTH_CHIPS} more`}
                            </Button>
                          )}
                        </div>
                      </>,
                    );
                  })}
                </div>
              ) : (
                (() => {
                  const all = days.map((day) => chips(visible, day));
                  const now = new Date();
                  // Ink, not red: red is for errors and Pause all sending.
                  const nowLine = <hr key="now" aria-hidden title="Now" className="my-0.5 border-t-2 border-primary" />;
                  const later = (c: Chip) => new Date(c.items[0]!.at!) > now;
                  // The day: a time down the side and full cards with their actions, only at times that have something.
                  if (view === "day") {
                    const day = days[0]!;
                    const here = all[0]!;
                    const rows: ReactNode[] = [];
                    const row = (key: string, time: string, body: ReactNode) => (
                      <div key={key} className="flex min-w-0 items-start gap-3">
                        <span className="w-16 shrink-0 pt-2 text-right text-xs text-muted-foreground tabular-nums">{time}</span>
                        {body}
                      </div>
                    );
                    let line = isoDay(day) !== today;
                    here.forEach((c, n) => {
                      if (!line && later(c)) {
                        rows.push(row("now", "", <div className="flex-1 pt-2">{nowLine}</div>));
                        line = true;
                      }
                      const time = clock(c.items[0]!.at!);
                      rows.push(row(c.key, n > 0 && clock(here[n - 1]!.items[0]!.at!) === time ? "" : time, <div className="min-w-0 flex-1">{card(items, c, day, true)}</div>));
                    });
                    if (!line && here.length) rows.push(row("now", "", <div className="flex-1 pt-2">{nowLine}</div>));
                    return dayBox(
                      items,
                      day,
                      "gap-3",
                      <>
                        <div className="flex flex-wrap items-start gap-x-6 gap-y-2">
                          {launches(launching, day)}
                          <div className="flex w-56 flex-col gap-2">{bars(day)}</div>
                          {dayApprove(day, here)}
                        </div>
                        {gapsOn(day)}
                        {rows}
                      </>,
                    );
                  }
                  // The week: a column a day whose rows (head, launches and gaps, Morning, Afternoon, Evening) every
                  // day shares through subgrid, so a busy morning lines up across the week. Below `lg` it is a list
                  // of days, the ones with nothing in them left out.
                  const nowSlot = slotOf(now.toISOString());
                  return (
                    <>
                    <CampaignBands workspaceId={p.workspaceId} days={days} campaigns={listed.data ?? []} only={byCampaign === ALL ? undefined : byCampaign} />
                    <div className="flex flex-col gap-4 rounded-card border border-border bg-card lg:grid lg:gap-0" style={{ gridTemplateColumns: `5rem repeat(${days.length}, minmax(0, 1fr))` }}>
                      <div aria-hidden className="hidden text-xs text-muted-foreground lg:row-span-5 lg:grid lg:grid-rows-subgrid">
                        <span />
                        <span />
                        {SLOTS.map((s) => (
                          <span key={s} className="border-t border-border px-2 pt-2">
                            {s}
                          </span>
                        ))}
                      </div>
                      {days.map((day, n) => {
                        const here = all[n]!;
                        const isToday = isoDay(day) === today;
                        const need = here.reduce((k, c) => k + c.items.filter(needsYou).length, 0);
                        const extras = [...launches(launching, day), ...gapsOn(day)];
                        // The day's count of each channel, so its cadence reads from the head.
                        const tally = LAYERS.map(([area, label]) => [area, label, here.reduce((k, c) => k + c.items.filter((i) => i.workArea === area).length, 0)] as const).filter(([, , k]) => k > 0);
                        const slots = SLOTS.map((s) => {
                          const cards: ReactNode[] = [];
                          let line = !isToday || s !== nowSlot;
                          for (const c of here.filter((c) => slotOf(c.items[0]!.at!) === s)) {
                            if (!line && later(c)) {
                              cards.push(nowLine);
                              line = true;
                            }
                            cards.push(card(items, c, day, false));
                          }
                          if (!line) cards.push(nowLine);
                          return (
                            <div key={s} className={cn("flex min-w-0 flex-col gap-1 lg:border-t lg:border-border lg:p-1", !cards.length && "max-lg:hidden")}>
                              {cards}
                            </div>
                          );
                        });
                        return dayBox(
                          items,
                          day,
                          cn("border-border px-2 pb-2 lg:row-span-6 lg:grid lg:grid-rows-subgrid lg:gap-0 lg:border-t-0 lg:border-l lg:px-0", !here.length && !extras.length && !isToday && "max-lg:hidden"),
                          <>
                            <div className="flex min-w-0 flex-col gap-1.5 lg:px-1 lg:pb-2">
                              <button type="button" className="flex items-baseline gap-1 rounded-control border-0 bg-transparent px-1 text-left hover:bg-muted" aria-label={`Open ${dayName(day)}${need ? `, ${needYou(need)}` : ""}`} onClick={() => go({ on: day, view: "day" })}>
                                <span className="text-xs text-muted-foreground">{day.toLocaleDateString(undefined, { weekday: "short" })}</span>
                                <span className={cn("inline-block min-w-7 rounded-control text-center text-md font-semibold tabular-nums", isToday && "bg-primary text-primary-foreground")}>{day.getDate()}</span>
                                {need > 0 && <span className={cn("ml-auto rounded-sm px-1.5 text-xs font-semibold", NEEDS_YOU)}>{need}</span>}
                              </button>
                              {tally.length > 0 && (
                                <p className="flex flex-wrap gap-x-2 px-1 text-xs text-muted-foreground tabular-nums">
                                  {tally.map(([area, label, k]) => (
                                    <span key={area} className="flex items-center gap-1">
                                      <Swatch area={area} />
                                      {countOf(k, label)}
                                    </span>
                                  ))}
                                </p>
                              )}
                              <div className="flex flex-col gap-1 px-1">{bars(day)}</div>
                            </div>
                            <div className="flex min-w-0 flex-col gap-1 lg:px-1 lg:pb-1">{extras}</div>
                            {slots}
                          </>,
                        );
                      })}
                    </div>
                    </>
                  );
                })()
              )}
            </>
          );
        }}
      </QueryBoundary>
      <Dialog isOpen={!!adding} onOpenChange={(o) => !o && setAdding(undefined)} purpose="form" width={448}>
        {adding && (
          <>
            <DialogHeader title={`New post for ${dayName(new Date(`${adding}T00:00`))}`} subtitle="It waits for approval like any draft." />
            <AddPost workspaceId={p.workspaceId} day={new Date(`${adding}T00:00`)} onCancel={() => setAdding(undefined)} onDone={() => { setAdding(undefined); void reload(); }} />
          </>
        )}
      </Dialog>
      {opened && (
        <Suspense fallback={null}>
          <p.ItemView workspaceId={p.workspaceId} id={open} role={p.role} onClose={() => setOpen(undefined)} />
        </Suspense>
      )}
    </Page>
  );
}
