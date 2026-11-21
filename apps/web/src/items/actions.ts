// SPDX-License-Identifier: AGPL-3.0-only
// The Item calls the pages make, and the rules for showing them. Each change returns the
// API's error code, or null when it worked.
import { infiniteQueryOptions, queryOptions, useQueries } from "@tanstack/react-query";
import type { components } from "../api/schema";
import { call, inWorkspace } from "../api/query";
import { api } from "../client";
import { ACTION_LABEL, KIND_LABEL } from "./type-labels";
import { confirmOnStepUp } from "../api/messages";
export { TYPES } from "./type-labels";

type S = components["schemas"];
export type Item = S["Item"];
export type ItemState = Item["state"];
export type Role = S["MyWorkspace"]["role"];

export const STATE_LABEL: Record<ItemState, string> = {
  draft: "Draft",
  needs_approval: "Needs approval",
  scheduled: "Scheduled",
  sent: "Sent",
  applied: "Applied",
  held: "Held",
  blocked: "Blocked",
  cancelled: "Cancelled",
};

/** Whether approving the Item sends or posts something (an email, post, issue or DM); everything else on Home is a decision. */
export const toApprove = (i: Pick<Item, "kind">) => i.kind === "action";

// The fix for each hold reason, as the button that leads to it says it; the open Item carries the fix itself.
const FIX: Record<string, string> = {
  credential_unavailable: "Reconnect the account",
  account_budget_reached: "Move it to tomorrow",
  campaign_paused: "Resume the Campaign",
  mailbox_unchecked: "Check the Mailbox",
  mailbox_paused: "See why it's paused",
  workspace_paused: "See why it's held",
  snapshot_changed: "Send back for approval",
  rule_needs_review: "Send back for approval",
  may_be_talking: "Decide on it",
  outcome_unknown: "Check what happened",
};

/** What a stuck Item's button says: its fix when the reason is known, else "Fix it". */
export const fixLabel = (i: Pick<Item, "reasonCode">) => FIX[i.reasonCode ?? ""] ?? "Fix it";

/** What an Item is, in a word or two, so a list says more than its state. */
export const kindLabel = (i: Pick<Item, "kind" | "workArea">): string =>
  i.kind === "action" ? (ACTION_LABEL[i.workArea ?? ""] ?? "Action") : (KIND_LABEL[i.kind] ?? "Approval");

export const ITEM_MESSAGES: Record<string, string> = {
  draft_version_moved: "This changed after you opened it. Check the new version, then approve.",
  details_stale: "This draft is still being updated. Try again in a moment.",
  not_clean: "This one has warnings, so it needs its own review.",
  slot_full: "That time would mean too many messages to this Person close together. Pick another.",
  mailbox_day_full: "That day already has as many emails as this email account sends a day. Pick another day.",
  account_day_full: "That day already has as many posts as this account makes a day. Pick another day.",
  slot_in_past: "That time has passed. Pick a new one.",
  wrong_state: "This can't be done any more. It may have moved on already.",
  outcome_unknown: "We can't tell if this went out. Mark it sent or resend it first.",
  credential_unavailable: "The account this sends from isn't connected any more. Reconnect it, then approve.",
  stale: "Someone else changed this just now. Try again.",
  not_found: "We couldn't find that one.",
  forbidden: "Your role doesn't allow that.",
  target_changed: "Brand changed after this was suggested. Dismiss it and check the current value.",
  choice_required: "Pick one of the options.",
  step_up_required: "This needs a recent sign-in. Sign in again, then approve it once more.",
  one_at_a_time: "Read this one and approve it on its own.",
  lesson_budget_full: "This writer's lessons are full. Retire or shorten one on the Lessons page first.",
  no_free_slot: "This Person has no free send time in the next two weeks. Move it to a later date.",
  too_late: "That time is more than a day gone. Pick a new one.",
  late_needs_time: "This is more than a day late. Resume it here so it goes at the next free time.",
  no_strategy: "There's no approved Strategy to add to yet.",
  invalid_choice: "That choice couldn't be used. Give each ticked suggestion some text, up to 400 characters, then try again.",
};
export const message = (code: string) => {
  // `too_many_assumptions:<how many the Strategy has>`
  const many = code.match(/^too_many_assumptions:(\d+)$/)?.[1];
  if (many) return `Your Strategy already has ${many} assumptions. Remove some first, or add fewer.`;
  return ITEM_MESSAGES[code] ?? "That didn't go through. Try again.";
};

export const mayApprove = (role: Role) => role === "owner" || role === "admin" || role === "marketer";
export const mayEdit = (role: Role) => role !== "viewer";

/** Kinds that close only with their own answer; the server refuses to dismiss them (`choice_required`). */
const OWN_ANSWER = ["opt_out_review", "reply", "company_review", "plan_change"];
/** Whether "Don't send" or "Dismiss" can withdraw it: still open, its outcome known, and not a kind that needs its own answer. */
export const mayWithdraw = (i: Pick<Item, "state" | "kind" | "reasonCode">) =>
  (i.state === "draft" || i.state === "needs_approval" || i.state === "scheduled" || i.state === "held") && i.reasonCode !== "outcome_unknown" && !OWN_ANSWER.includes(i.kind);

const at = (workspaceId: string) => ({ path: { workspaceId } });
const one = (workspaceId: string, id: string) => ({ path: { workspaceId, id } });

export async function needsYou(workspaceId: string) {
  const { data } = await api.GET("/api/w/{workspaceId}/items", { params: { ...at(workspaceId), query: { needsYou: "true", limit: 200 } } });
  return data ? { items: data.items, count: data.needsYouCount } : { items: [], count: 0 };
}

export async function week(workspaceId: string, from: Date, to: Date): Promise<Item[]> {
  const query = { from: from.toISOString(), to: to.toISOString(), limit: 500 };
  const { data } = await api.GET("/api/w/{workspaceId}/items", { params: { ...at(workspaceId), query } });
  return data?.items ?? [];
}

/** What needs this person, and how many in all. */
export const needsYouQuery = (workspaceId: string) =>
  queryOptions({
    queryKey: inWorkspace(workspaceId, "items", "needs-you"),
    queryFn: async () => {
      const data = await call(api.GET("/api/w/{workspaceId}/items", { params: { ...at(workspaceId), query: { needsYou: "true", limit: 200 } } }));
      return { items: data.items, count: data.needsYouCount };
    },
  });

/** How many Items need this person in one Workspace, read with a single row so it is cheap for every client. */
export const needsYouCountQuery = (workspaceId: string) =>
  queryOptions({
    queryKey: inWorkspace(workspaceId, "items", "needs-you-count"),
    queryFn: async () => (await call(api.GET("/api/w/{workspaceId}/items", { params: { ...at(workspaceId), query: { needsYou: "true", limit: 1 } } }))).needsYouCount,
  });

/** What waits in each of these Workspaces, by id; one that can't be read counts as nothing. */
// ponytail: one request per Workspace; a single /api/me count endpoint once someone belongs to dozens.
export function useWaitingByWorkspace(workspaceIds: string[]): Record<string, number> {
  const counts = useQueries({ queries: workspaceIds.map(needsYouCountQuery) });
  return Object.fromEntries(workspaceIds.map((id, n) => [id, counts[n]?.data ?? 0]));
}

/** A local day as launch dates are written, such as "2026-11-10". */
export const isoDay = (d: Date) => d.toLocaleDateString("en-CA");

/** When something put on `day` goes: 9:00, or the next whole hour once 9:00 has passed. */
export function firstSlot(day: Date, now = new Date()): Date {
  const soon = new Date(now);
  soon.setHours(soon.getHours() + 1, 0, 0, 0);
  const nine = new Date(day.getFullYear(), day.getMonth(), day.getDate(), 9);
  return nine < soon ? soon : nine;
}

/** `firstSlot` as a date and time field's value, such as "2026-11-17T10:00". */
export function firstSlotValue(day: Date, now = new Date()): string {
  const at = firstSlot(day, now);
  return `${isoDay(at)}T${String(at.getHours()).padStart(2, "0")}:00`;
}

export type MailboxDay = S["MailboxDays"]["days"][number];

/** Each Mailbox's emails against its daily limit on the days from `start`, for the Calendar's lane. */
export const mailboxDaysQuery = (workspaceId: string, start: Date, days: number) =>
  queryOptions({
    queryKey: inWorkspace(workspaceId, "items", "mailbox-days", start.getTime(), days),
    queryFn: async () => (await call(api.GET("/api/w/{workspaceId}/mailbox-days", { params: { ...at(workspaceId), query: { from: start.toISOString(), to: addDays(start, days).toISOString() } } }))).days,
  });

/** How many Items the Calendar reads for one range; past it, the page says it shows only the first ones. */
export const RANGE_CAP = 5000;

/** `days` days of Items from `start`, page by page up to RANGE_CAP, and the Campaigns launching in them. */
export const rangeQuery = (workspaceId: string, start: Date, days: number) =>
  queryOptions({
    queryKey: inWorkspace(workspaceId, "items", "range", start.getTime(), days),
    queryFn: async () => {
      const query = { from: start.toISOString(), to: addDays(start, days).toISOString(), limit: 500 };
      const pages = async () => {
        const items: Item[] = [];
        let cursor: string | null | undefined;
        do {
          const page = await call(api.GET("/api/w/{workspaceId}/items", { params: { ...at(workspaceId), query: cursor ? { ...query, cursor } : query } }));
          items.push(...page.items);
          cursor = page.nextCursor;
        } while (cursor && items.length < RANGE_CAP);
        return { items, more: Boolean(cursor) };
      };
      const [read, launches] = await Promise.all([
        pages(),
        call(api.GET("/api/w/{workspaceId}/campaign-launches", { params: { ...at(workspaceId), query: { from: isoDay(start), to: isoDay(addDays(start, days - 1)) } } })),
      ]);
      return { ...read, launching: launches.launches };
    },
  });

/** Everything's filters as the list API takes them: comma lists for state, channel and type. */
export type ListFilters = { state?: string | undefined; channel?: string | undefined; type?: string | undefined; campaign?: string | undefined; q?: string | undefined };

/** Every Item these filters match, newest first, 100 a page; each next page starts after the last row. */
export const everythingQuery = (workspaceId: string, f: ListFilters) =>
  infiniteQueryOptions({
    queryKey: inWorkspace(workspaceId, "items", "everything", f),
    queryFn: ({ pageParam }) => call(api.GET("/api/w/{workspaceId}/items", { params: { ...at(workspaceId), query: { ...f, limit: 100, ...(pageParam && { cursor: pageParam }) } } })),
    initialPageParam: "",
    getNextPageParam: (page) => page.nextCursor,
  });

/** Steps a running Campaign's plan dates in `days` days from `start` that nothing has been drafted for yet. */
export const emptyStepsQuery = (workspaceId: string, start: Date, days: number) =>
  queryOptions({
    queryKey: inWorkspace(workspaceId, "items", "empty-steps", start.getTime(), days),
    queryFn: async () =>
      (await call(api.GET("/api/w/{workspaceId}/campaign-steps", { params: { ...at(workspaceId), query: { from: isoDay(start), to: isoDay(addDays(start, days - 1)) } } }))).steps,
  });

/** One Item with its content and history. */
/** Keys typed into a field are words, not shortcuts. */
export const typing = (target: EventTarget | null) => target instanceof Element && target.closest("input, textarea, select, [contenteditable]:not([contenteditable='false'])") !== null;

export const itemQuery = (workspaceId: string, id: string) =>
  queryOptions({ queryKey: inWorkspace(workspaceId, "items", "one", id), queryFn: () => call(api.GET("/api/w/{workspaceId}/items/{id}", { params: one(workspaceId, id) })) });

export async function detail(workspaceId: string, id: string) {
  const { data } = await api.GET("/api/w/{workspaceId}/items/{id}", { params: one(workspaceId, id) });
  return data;
}

export type RewritePreset = "shorter" | "longer" | "casual" | "formal" | "again";
/** Why a person turned a draft down; the server holds the words each one says to the writer. */
export type RejectReason = "salesy" | "long" | "facts" | "voice" | "audience";
/**
 * Starts the email's writer on a preset, a reason with optional words, or the person's own words; the new version
 * arrives as a new revision. A reason is recorded against the email's step, with when the Item was opened.
 */
export async function rewrite(workspaceId: string, id: string, asked: { preset: RewritePreset } | { reason: RejectReason; instruction?: string } | { instruction: string }, openedAt?: string): Promise<{ error: string | null; runId?: string }> {
  const body = { ...asked, ...(openedAt && { openedAt }), timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone };
  const { data, error } = await api.POST("/api/w/{workspaceId}/items/{id}/rewrite", { params: one(workspaceId, id), body });
  return error ? { error: error.error } : { error: null, runId: data?.runId };
}

/** `openedAt` is when the reviewer opened the Item, so their own pace can be measured; it is never shown to anyone else. */
export async function approve(workspaceId: string, i: Pick<Item, "id" | "revision">, choice?: string, openedAt?: string, praise?: boolean): Promise<string | null> {
  const body = { revision: i.revision, ...(choice && { choice }), ...(openedAt && { openedAt }), ...(praise && { praise }) };
  const { error } = await api.POST("/api/w/{workspaceId}/items/{id}/approve", { params: one(workspaceId, i.id), body });
  return error ? confirmOnStepUp(error.error) : null;
}

export type BulkResult = { done: number; ids: string[]; refused: { id: string; reason: string }[] };
const tally = (results: S["ItemResult"][] = []): BulkResult => ({
  done: results.filter((r) => r.ok).length,
  ids: results.filter((r) => r.ok).map((r) => r.id),
  refused: results.filter((r) => !r.ok).map((r) => ({ id: r.id, reason: r.reason ?? "unknown" })),
});
/** The most Items one bulk request carries; the rest wait for the next. */
export const BULK = 200;

export async function approveClean(workspaceId: string, items: Pick<Item, "id" | "revision">[]): Promise<BulkResult> {
  const body = { items: items.slice(0, BULK).map(({ id, revision }) => ({ id, revision })) };
  const { data } = await api.POST("/api/w/{workspaceId}/items/approve-clean", { params: at(workspaceId), body });
  return tally(data?.results);
}

export async function move(workspaceId: string, entries: { id: string; plannedAt: string }[]): Promise<BulkResult> {
  const { data } = await api.POST("/api/w/{workspaceId}/items/move", { params: at(workspaceId), body: { items: entries.slice(0, BULK) } });
  return tally(data?.results);
}

/** Cancels each one still allowed (Scheduled and not yet claimed), as Don't send does; how many stopped. */
export async function cancelAll(workspaceId: string, ids: string[]): Promise<number> {
  const refused = await Promise.all(ids.map((id) => cancel(workspaceId, id)));
  return refused.filter((r) => r === null).length;
}

export async function cancel(workspaceId: string, id: string, openedAt?: string): Promise<string | null> {
  const { error } = await api.POST("/api/w/{workspaceId}/items/{id}/cancel", { params: { ...one(workspaceId, id), ...(openedAt && { query: { openedAt } }) } });
  return error ? error.error : null;
}

/** The signed-in reviewer's own pace over their recent decisions, and whether it has sped up while changing less. */
export const reviewRatesQuery = (workspaceId: string) =>
  queryOptions({ queryKey: inWorkspace(workspaceId, "review-rates"), queryFn: () => call(api.GET("/api/w/{workspaceId}/review-rates", { params: at(workspaceId) })) });

export async function resume(workspaceId: string, id: string): Promise<string | null> {
  const { error } = await api.POST("/api/w/{workspaceId}/items/{id}/resume", { params: one(workspaceId, id) });
  return error ? error.error : null;
}

export async function resolveUnknown(workspaceId: string, id: string, choice: "mark_sent" | "resend"): Promise<string | null> {
  const { error } = await api.POST("/api/w/{workspaceId}/items/{id}/resolve-unknown", { params: one(workspaceId, id), body: { choice } });
  return error ? error.error : null;
}

/** What approving does, said on the button: a person approves a time as well as a draft. */
export function approveLabel(items: (Pick<Item, "at"> & Partial<Pick<Item, "kind">>)[], format: (d: Date) => string = sendTime): string {
  const count = items.length === 1 ? "Approve" : `Approve ${items.length}`;
  const when = items[0]?.at;
  // A post copied by hand never goes out through Direx: the person posts it.
  if (items.length > 0 && items.every((i) => i.kind === "manual_post")) return `${count} · ${items.length === 1 ? "you post it" : "you post them"} by hand${when ? `, ${format(new Date(when))}` : ""}`;
  return when ? `${count} · sends ${format(new Date(when))}` : `${count} · sends now`;
}
export const shortTime = (d: Date) => d.toLocaleString(undefined, { weekday: "short", hour: "numeric", minute: "2-digit" });
/** A time in a list: "Thu 10:00" within the coming six days, otherwise with its date ("Thu 19 Nov, 10:00"), so a weekday never reads as this week's by mistake. */
export const listTime = (d: Date, now = new Date()) => {
  const days = (d.getTime() - new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime()) / 86_400_000;
  return days >= 0 && days < 6 ? shortTime(d) : d.toLocaleString(undefined, { weekday: "short", day: "numeric", month: "short", hour: "numeric", minute: "2-digit" });
};
/** The browser's time zone at `d`, as people read it: "PST". Send times show in it until a Workspace has its own. */
const zoneName = (d: Date) => new Intl.DateTimeFormat(undefined, { timeZoneName: "short" }).formatToParts(d).find((x) => x.type === "timeZoneName")?.value ?? "";
/** A send time with its zone named: "Tue 9:00 AM PST". */
export const sendTime = (d: Date) => `${listTime(d)} ${zoneName(d)}`.trim();

/** Monday 00:00 of the week `d` falls in, in the browser's timezone. */
export function weekStart(d: Date): Date {
  const out = new Date(d.getFullYear(), d.getMonth(), d.getDate());
  out.setDate(out.getDate() - ((out.getDay() + 6) % 7));
  return out;
}
export const addDays = (d: Date, n: number) => new Date(d.getFullYear(), d.getMonth(), d.getDate() + n, d.getHours(), d.getMinutes());

/** The same time of day on another day. */
export const onDay = (when: Date, day: Date) => new Date(day.getFullYear(), day.getMonth(), day.getDate(), when.getHours(), when.getMinutes());

export type Chip = { key: string; title: string; items: Item[] };

/** One day's chips: Items sharing a group form one chip, in time order. Cancelled work isn't planned any more. */
export function chips(items: Item[], day: Date): Chip[] {
  const out = new Map<string, Chip>();
  for (const i of items) {
    if (!i.at || i.state === "cancelled") continue;
    const when = new Date(i.at);
    if (when.getFullYear() !== day.getFullYear() || when.getMonth() !== day.getMonth() || when.getDate() !== day.getDate()) continue;
    const key = i.groupKey ?? i.id;
    const chip = out.get(key) ?? { key, title: i.groupLabel ?? i.title, items: [] };
    chip.items.push(i);
    out.set(key, chip);
  }
  return [...out.values()];
}

/** What a chip's Approve covers: only clean Items waiting for approval. */
export const approvable = (c: Chip) => c.items.filter((i) => i.state === "needs_approval" && i.clean);

export type Reply = { senderEmail: string; text: string | null; status: string };
export const replyQuery = (workspaceId: string, signalId: string) =>
  queryOptions({
    queryKey: inWorkspace(workspaceId, "replies", signalId),
    queryFn: (): Promise<Reply> => call(api.GET("/api/w/{workspaceId}/outreach/replies/{signalId}", { params: { path: { workspaceId, signalId } } })),
  });

/** How many Items one read takes; a busier two days says "500+" rather than a wrong count. */
export const BRIEF_LIMIT = 500;

/** Yesterday's and today's Items, by the browser's days, for the morning brief on Home. */
export const briefQuery = (workspaceId: string, now: Date) => {
  const from = addDays(new Date(now.getFullYear(), now.getMonth(), now.getDate()), -1);
  return queryOptions({
    queryKey: inWorkspace(workspaceId, "items", "brief", from.getTime()),
    queryFn: async () =>
      (await call(api.GET("/api/w/{workspaceId}/items", { params: { ...at(workspaceId), query: { from: from.toISOString(), to: addDays(from, 2).toISOString(), limit: BRIEF_LIMIT } } }))).items,
  });
};
