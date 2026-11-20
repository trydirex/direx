// SPDX-License-Identifier: AGPL-3.0-only
// A Campaign at a glance: what waits for a person, its steps by date with their drafts by state, its
// numbers against the plan's targets and what Direx did lately.
import { CampaignNotes } from "./CampaignNotes";
import { useState, type ReactNode } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { ProgressBar } from "@astryxdesign/core/ProgressBar";
import { Table, TableBody, TableCell, TableHeader, TableHeaderCell, TableRow } from "@astryxdesign/core/Table";
import { inWorkspace } from "../api/query";
import { Button } from "@/components/Button";
import { Confirm } from "@/components/Confirm";
import { toast } from "@/components/toast";
import { Notice } from "../components/layout";
import { ChannelMark, channelOf } from "../components/ChannelMark";
import { countedFrom, planQuery, type Tracking } from "../plans/actions";
import { approveClean, mayApprove, message, needsYouQuery, STATE_LABEL, toApprove, type Item, type ItemState, type Role } from "../items/actions";
import { ItemDialog } from "../items/ItemPanel";
import { CampaignChip, StateChip } from "../items/StateChip";
import { Activity } from "./Activity";
import { Overlaps } from "./Overlaps";
import { kindWords } from "./Setup";
import { campaignsQuery, dayWords, networkWords, progressLine, progressQuery, resultsQuery, stepCountsQuery, type Listed, type Loaded, type Results, type Step, type StepCounts } from "./actions";

const STATUS_WORDS: Record<Exclude<Listed["status"], "scheduled">, string> = {
  ended: "Ended",
  paused: "Paused",
  draft: "Draft",
  awaiting_signoff: "Awaiting sign-off",
  no_launch_date: "No launch date",
  running: "Running",
};

/** Where the Campaign is, as the server derived it in the Workspace's time zone. A scheduled one names its launch day. */
export function campaignStatus(c: Pick<Listed, "status" | "startsOn"> & { anchor?: Loaded["anchor"]; launchOn?: string | null }) {
  if (c.status !== "scheduled") return STATUS_WORDS[c.status];
  const launch = c.anchor?.on ?? c.launchOn ?? c.startsOn;
  return launch ? `Starts ${dayWords(launch)}` : "Scheduled";
}

export function StatusChip(p: { campaign: Loaded }) {
  return (
    <span className="inline-flex flex-wrap items-center gap-2">
      <CampaignChip status={p.campaign.status} label={campaignStatus(p.campaign)} />
      {p.campaign.changesWaiting && <CampaignChip status="awaiting_signoff" label="Changes waiting for sign-off" />}
    </span>
  );
}

/** The plan's tracking: its measures with their latest reading and its steps' status. Undefined until the plan reads, or when it has no approved version. */
const useTracking = (workspaceId: string, planId: string) => useQuery(planQuery(workspaceId, planId)).data?.tracking as Tracking | undefined;

/**
 * Each measure against its target, "142 / 200" in the serif with a bar when both are numbers. Silent when the plan can't be read.
 * The one way measures are drawn: Overview leads with it, and the Plan tab adds each measure's basis and reading form through `after`.
 */
export function Measures(p: { tracking: Tracking | undefined; emailSent?: boolean | undefined; after?: (m: Tracking["measures"][number]) => ReactNode }) {
  // Direx counts each morning, so a count can lag a send or a mark by up to a day; the words say so.
  const waitsOn = (source: Tracking["measures"][number]["source"]) =>
    source === "meetings" ? "Mark a meeting on a Person. Direx counts marks each morning." : source === "deals" ? "Mark a deal on a Person. Direx counts marks each morning." : p.emailSent === false ? "Waiting for the first email to go out." : p.emailSent ? "Direx counts each morning, so the first count comes with the next one." : "Direx counts each morning.";
  const measures = p.tracking?.measures ?? [];
  if (!measures.length) return null;
  return (
    <section aria-labelledby="measures" className="flex flex-col gap-4">
      <h2 id="measures" className="font-sans text-sm font-semibold">
        Measures
      </h2>
      <ul className="flex flex-col gap-5">
        {measures.map((m) => {
          const from = countedFrom(m.source);
          if (!m.latest && from)
            // Counted, but nothing to count from yet: a dash, never a zero, and what it waits on.
            return (
              <li key={m.key} className="flex flex-col gap-1.5">
                <span className="font-display text-xl tabular-nums">
                  <Missing label="No count yet" /> <span className="text-base text-muted-foreground">/ {m.target}</span>
                </span>
                <span className="text-sm">{m.label}</span>
                <small className="text-xs text-muted-foreground">
                  Counted by Direx from {from}. {waitsOn(m.source)}
                </small>
                {p.after?.(m)}
              </li>
            );
          if (!m.latest)
            return (
              <li key={m.key} className="flex flex-col gap-1">
                <span>
                  {m.label}: target {m.target}
                </span>
                <span className="text-sm text-muted-foreground">No reading yet</span>
                {p.after?.(m)}
              </li>
            );
          // A person's reading on a counted Measure is a correction: the newest count shows beside it.
          const count = from && m.latest.source === "person" ? m.readings?.filter((r) => r.source === "system").sort((a, b) => `${a.observedOn}${a.at ?? ""}`.localeCompare(`${b.observedOn}${b.at ?? ""}`)).at(-1) : undefined;
          // parseFloat, so a target with its unit ("200 signups") still gets a bar.
          const value = Number.parseFloat(m.latest.value);
          const target = Number.parseFloat(m.target);
          const counted = Number.isFinite(value) && Number.isFinite(target) && target > 0;
          return (
            <li key={m.key} className="flex flex-col gap-1.5">
              <span className="font-display text-xl tabular-nums">
                {m.latest.value} <span className="text-base text-muted-foreground">/ {m.target}</span>
              </span>
              <span className="text-sm">
                {m.label}
                {counted && ` (${Math.round((value / target) * 100)}%)`}
              </span>
              {counted && <ProgressBar label={`${m.label} against its target`} isLabelHidden value={Math.min(value, target)} max={target} />}
              <small className="text-xs text-muted-foreground">
                As of {dayWords(m.latest.observedOn)}, {m.latest.source === "person" ? "entered by a person" : from ? `counted by Direx from ${from}` : "from Direx"}
              </small>
              {count && (
                <small className="text-xs text-muted-foreground">
                  Counted by Direx from {from}: {count.value} as of {dayWords(count.observedOn)}
                </small>
              )}
              {p.after?.(m)}
            </li>
          );
        })}
      </ul>
    </section>
  );
}

/** A number Direx can't give: a dash with an accessible label, optionally shown as a note. */
const Missing = (p: { label: string; visible?: boolean }) => (
  <>
    <span aria-hidden>-</span>
    <span className={p.visible ? "block text-xs text-muted-foreground" : "sr-only"}>{p.label}</span>
  </>
);

/** The numbers Direx records for a Campaign: sends per channel, then what came back on email. A number it doesn't record has none. */
export function resultTiles(r: Results | undefined): [string | number, string][] {
  if (!r) return [];
  const sent = r.sent.map((s): [number, string] => [s.n, s.kind === "email" ? "Emails sent" : s.kind === "post" ? `${networkWords(s.channel)} posts` : `${networkWords(s.channel)} DMs sent`]);
  const email: [number, string][] = r.email ? [[r.email.replied, "Stopped after a reply"], [r.email.bounced, "Bounced"], [r.email.optedOut, "Opted out by reply"]] : [];
  return [...sent, ...email];
}
/** Each step's People sent, replied and interested. A dash where Direx can't count, never a zero. Silent with no steps. */
function ByStep(p: { steps: Results["steps"] | undefined }) {
  if (!p.steps?.length) return null;
  const cell = (row: Results["steps"][number], c: Results["steps"][number]["sent"]) => (
    <TableCell className="text-right tabular-nums">
      {c ? (
        <>
          {c.n}
          {c.source === "person" && <span className="block text-xs text-muted-foreground">marked sent by a person</span>}
        </>
      ) : (
        // An email step has replies to count once one email on it goes out; other steps never do.
        <Missing visible label={row.kind === "email" ? "Not counted until an email on this step goes out" : "Direx can't count this on this step"} />
      )}
    </TableCell>
  );
  return (
    <section aria-labelledby="by-step" className="flex flex-col gap-3">
      <h2 id="by-step" className="font-sans text-sm font-semibold">
        By step
      </h2>
      <p className="text-sm text-muted-foreground">Counted by Direx, unless a number says otherwise.</p>
      {/* Tables are 14px, and this one scrolls sideways on a phone rather than squeezing its columns. */}
      <div className="overflow-x-auto text-sm">
        <Table aria-labelledby="by-step" textOverflow="wrap">
          <TableHeader>
            <TableRow>
              <TableHeaderCell scope="col">Step</TableHeaderCell>
              <TableHeaderCell scope="col" className="text-right">Sent</TableHeaderCell>
              <TableHeaderCell scope="col" className="text-right">Replied</TableHeaderCell>
              <TableHeaderCell scope="col" className="text-right">Interested</TableHeaderCell>
            </TableRow>
          </TableHeader>
          <TableBody>
            {p.steps.map((row) => (
              <TableRow key={row.stepKey}>
                <TableHeaderCell scope="row">{row.title ?? row.stepKey}</TableHeaderCell>
                {cell(row, row.sent)}
                {cell(row, row.replied)}
                {cell(row, row.interested)}
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
    </section>
  );
}

/** What came back badly reads smaller than what came back well. */
const QUIET = new Set(["Bounced", "Opted out by reply"]);

/** The step an Item belongs to in this Campaign, from the group the server files it under. */
export const stepOf = (campaignId: string, i: Pick<Item, "groupKey">) => i.groupKey?.match(new RegExp(`^campaign:${campaignId}:step:([^:]+)`))?.[1];

/** What waits for this person in this Campaign: its drafts and decisions, from the Needs you list Home reads too. */
export function useWaiting(workspaceId: string, campaignId: string) {
  const items = useQuery(needsYouQuery(workspaceId)).data?.items;
  return items?.filter((i) => i.groupKey === `campaign:${campaignId}` || i.groupKey?.startsWith(`campaign:${campaignId}:`)) ?? [];
}

export type Counts = StepCounts;
/** Each step's Items by state, dated or not. Empty until they read. */
export const useStepCounts = (workspaceId: string, c: Pick<Loaded, "id">): Record<string, Counts> => useQuery(stepCountsQuery(workspaceId, c.id)).data ?? {};

/** The states a step's bar shows, in the order an email moves through them. */
const STACK: [ItemState, string][] = [
  ["sent", "bg-success"],
  ["applied", "bg-success"],
  ["scheduled", "bg-scheduled"],
  ["needs_approval", "bg-peach-foreground"],
  ["held", "bg-muted-foreground"],
  ["draft", "bg-faint"],
];
/** A step's counts in words, "20 Sent · 10 Needs approval"; empty when nothing is drafted. */
export const countWords = (n: Counts | undefined) =>
  STACK.filter(([s]) => n?.[s])
    .map(([s]) => `${n![s]} ${STATE_LABEL[s]}`)
    .join(" · ");

/** A step's drafts as one stacked bar with the words under it, so the colours are never the only signal. */
function StepBar(p: { counts: Counts | undefined; fallback: string }) {
  const parts = STACK.filter(([s]) => p.counts?.[s]);
  const total = parts.reduce((sum, [s]) => sum + p.counts![s]!, 0);
  if (!total) return <span className="text-sm text-muted-foreground">{p.fallback}</span>;
  return (
    <div className="flex min-w-0 flex-col gap-1">
      <div aria-hidden className="flex h-2 overflow-hidden rounded-full bg-muted">
        {parts.map(([s, fill]) => (
          // Computed layout: each state's share of the bar.
          <span key={s} className={fill} style={{ width: `${(p.counts![s]! / total) * 100}%` }} />
        ))}
      </div>
      <span className="text-xs text-muted-foreground tabular-nums">{countWords(p.counts)}</span>
    </div>
  );
}

/** What a step is doing when it has no drafts to count: cancelled, out of the plan, done or skipped, or its writing so far. */
export function stepLine(s: Step, tracking: Tracking | undefined, written: string) {
  if (s.cancelled) return "Cancelled";
  if (!s.inPlan) return "No longer in the plan";
  const status = tracking?.steps.find((x) => x.key === s.key)?.status;
  if (status === "done") return "Done";
  if (status === "skipped") return "Skipped";
  return written || "Not drafted yet";
}

/** One group of waiting Items in a Campaign, by step: open one to read it, or approve the clean ones together. */
function Waiting(p: { workspaceId: string; role: Role; title: string; channel: string; items: Item[]; onOpen: (id: string) => void; onRefused: (text: string) => void }) {
  const client = useQueryClient();
  const first = p.items[0]!;
  const clean = p.items.filter((i) => i.state === "needs_approval" && i.clean && toApprove(i));
  const n = p.items.length;
  return (
    <li className="flex flex-wrap items-start gap-3 border-t border-border py-3 first:border-t-0 first:pt-0">
      <ChannelMark channel={channelOf(p.channel)} />
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        <span className="flex flex-wrap items-center gap-2">
          <span className="font-medium">{p.title}</span>
          <StateChip state={first.state} reason={first.state === "held" ? first.reason : undefined} />
        </span>
        <span className="text-sm text-muted-foreground">{n === 1 ? first.title : `${n} waiting, such as "${first.title}"`}</span>
      </div>
      <div className="flex flex-wrap gap-2">
        <Button size="sm" variant="outline" onClick={() => p.onOpen(first.id)} aria-label={`Open ${first.title}`}>
          {n > 1 ? "Open the first" : "Open"}
        </Button>
        {mayApprove(p.role) && clean.length > 0 && (
          <Confirm
            trigger={<Button size="sm">{clean.length === 1 ? "Approve" : `Approve ${clean.length}`}</Button>}
            title={clean.length === 1 ? `Approve "${clean[0]!.title}"?` : `Approve ${clean.length} from ${p.title}?`}
            body="Each goes out at its planned time. Drafts with a warning stay here for you to read first."
            confirm={clean.length === 1 ? "Approve" : `Approve ${clean.length}`}
            onConfirm={async () => {
              const r = await approveClean(p.workspaceId, clean);
              if (r.done) toast.add({ title: `Approved ${r.done}.` });
              if (r.refused.length) p.onRefused(`${r.refused.length} didn't go through: ${message(r.refused[0]!.reason)}`);
              await client.invalidateQueries({ queryKey: inWorkspace(p.workspaceId) });
            }}
          />
        )}
      </div>
    </li>
  );
}

/** What waits for a person in this Campaign, by step, decided here rather than on Home. Silent when nothing waits. */
function NeedsYou(p: { workspaceId: string; campaign: Loaded; role: Role }) {
  const { campaign: c } = p;
  const waiting = useWaiting(p.workspaceId, c.id);
  const [open, setOpen] = useState<string>();
  const [refused, setRefused] = useState<string>();
  if (!waiting.length) return null;
  const groups = new Map<string, Item[]>();
  for (const i of waiting) groups.set(`${i.groupKey}:${i.state}`, [...(groups.get(`${i.groupKey}:${i.state}`) ?? []), i]);
  return (
    <section aria-labelledby="needs-you" className="flex flex-col gap-3 rounded-card border border-border bg-card p-6">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 id="needs-you" className="font-sans text-sm font-semibold">
          Needs you
        </h2>
        <Link to="/w/$workspaceId/campaigns/$campaignId" params={{ workspaceId: p.workspaceId, campaignId: c.id }} search={{ tab: "drafts" }} className="text-sm">
          Open all in Content
        </Link>
      </div>
      {refused && <Notice tone="error">{refused}</Notice>}
      <ul className="flex flex-col">
        {[...groups.values()].map((items) => {
          const step = c.steps.find((s) => s.key === stepOf(c.id, items[0]!));
          return (
            <Waiting
              key={`${items[0]!.groupKey}:${items[0]!.state}`}
              workspaceId={p.workspaceId}
              role={p.role}
              title={step?.title ?? items[0]!.groupLabel ?? "People"}
              channel={items[0]!.channel ?? step?.type ?? "email"}
              items={items}
              onOpen={setOpen}
              onRefused={setRefused}
            />
          );
        })}
      </ul>
      <ItemDialog workspaceId={p.workspaceId} id={open} role={p.role} onClose={() => setOpen(undefined)} />
    </section>
  );
}

export function Overview(p: { workspaceId: string; campaign: Loaded; edit: boolean; role: Role }) {
  const { workspaceId, campaign: c } = p;
  const tracking = useTracking(workspaceId, c.planId);
  const results = useQuery(resultsQuery(workspaceId, c.id)).data;
  const counts = useStepCounts(workspaceId, c);
  const progress = useQuery(progressQuery(workspaceId, c.id)).data ?? [];
  const steps = [...c.steps].sort((a, b) => (a.on ?? "9999").localeCompare(b.on ?? "9999"));
  return (
    <div className="grid gap-8 xl:grid-cols-3">
      <div className="flex min-w-0 flex-col gap-8 xl:col-span-2">
        <NeedsYou workspaceId={workspaceId} campaign={c} role={p.role} />
        <section aria-labelledby="timeline" className="flex flex-col gap-3">
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <h2 id="timeline" className="font-sans text-sm font-semibold">
              Steps
            </h2>
            <span className="text-sm text-muted-foreground">{`${c.planned} ${c.planned === 1 ? "step" : "steps"} · ${c.done} done`}</span>
          </div>
          <ol aria-label="Steps by date" className="flex flex-col">
            {steps.map((s) => (
              <li key={s.key} className="grid grid-cols-1 items-center gap-x-4 gap-y-2 border-t border-border py-3 sm:grid-cols-2">
                <span className="flex min-w-0 items-center gap-3">
                  <span className="w-20 shrink-0 text-sm text-muted-foreground tabular-nums">{s.on ? <time dateTime={s.on}>{dayWords(s.on)}</time> : "No date"}</span>
                  <ChannelMark channel={channelOf(s.type === "dm" ? (s.dmChannel ?? "linkedin") : s.type)} />
                  <span className="min-w-0">
                    <span className="font-medium">{s.title ?? s.key}</span>
                    <span className="text-sm text-muted-foreground">{` · ${kindWords(s)}`}</span>
                  </span>
                </span>
                <StepBar counts={counts[s.key]} fallback={stepLine(s, tracking, progressLine(progress.find((x) => x.stepKey === s.key)))} />
              </li>
            ))}
          </ol>
        </section>
        {/* In the wide column, so its four columns keep their words. */}
        <ByStep steps={results?.steps} />
        <Overlaps workspaceId={workspaceId} id={c.id} />
      </div>
      <div className="flex min-w-0 flex-col gap-8">
        {/* The goal comes first, above what was sent (marketer UX pass, D1). */}
        <Measures tracking={tracking} emailSent={results?.sent.some((s) => s.kind === "email" && s.n > 0)} />
        <dl className="grid grid-cols-2 gap-x-4 gap-y-5">
          {[...resultTiles(results), [`${c.done} of ${c.planned}`, "Steps done"] as const].map(([value, label]) => (
            <div key={label} className="flex flex-col-reverse gap-1">
              <dt className="text-sm text-muted-foreground">{label}</dt>
              <dd className={QUIET.has(label) ? "font-display text-md tabular-nums" : "font-display text-xl tabular-nums"}>{value}</dd>
            </div>
          ))}
        </dl>
        <CampaignNotes key={c.notesRevision} workspaceId={workspaceId} campaign={c} edit={p.edit} />
        <Activity
          workspaceId={workspaceId}
          id={c.id}
          edit={p.edit}
          limit={5}
          more={
            <Link to="/w/$workspaceId/campaigns/$campaignId" params={{ workspaceId, campaignId: c.id }} search={{ tab: "drafts" }} className="text-sm">
              See all on Content
            </Link>
          }
        />
      </div>
    </div>
  );
}

/** How many need approval in this Campaign, from the list's read that the Campaigns beside it already made. */
export const useNeedApproval = (workspaceId: string, id: string) => useQuery(campaignsQuery(workspaceId)).data?.find((l) => l.id === id)?.needApproval ?? 0;
