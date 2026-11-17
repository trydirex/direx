// SPDX-License-Identifier: AGPL-3.0-only
import { Ideas } from "../plans/Ideas";
import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { Dialog, DialogHeader } from "@astryxdesign/core/Dialog";
import { Skeleton } from "@astryxdesign/core/Skeleton";
import { inWorkspace } from "../api/query";
import { EmptyState, Notice, Page } from "../components/layout";
import { QueryBoundary } from "../components/QueryBoundary";
import { Button, buttonVariants } from "@/components/Button";
import { factsQuery } from "../facts/actions";
import { AskBox } from "../ask/Panel";
import { meQuery, workspacesQuery } from "../shell/session";
import { addDays, approveClean, fixLabel, ITEM_MESSAGES, listTime, mayApprove, mayEdit, message, needsYouQuery, toApprove, useWaitingByWorkspace, type Item, type Role } from "./actions";
import { CampaignsCard, ComingUp, MorningBrief } from "./Brief";
import { ApproveList, approvedToast, QueueRow } from "./QueueRow";
import { StateChip } from "./StateChip";

/** "Good morning, Sam" by the browser's hour; with no name, just the greeting. */
export const greeting = (hour: number, name?: string) => {
  const part = hour < 12 ? "morning" : hour < 18 ? "afternoon" : "evening";
  const first = name?.trim().split(/\s+/)[0];
  return first ? `Good ${part}, ${first}` : `Good ${part}`;
};

/** How many waiting Items Home lists; Review has them all. */
export const HOME_ROWS = 5;

/** What waits for a yes, by when it goes out: today (or late), this week, later, then decisions. Soonest first in each. */
export function byDeadline(items: Item[], now: Date) {
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const tomorrow = addDays(today, 1).getTime();
  const week = addDays(today, 7).getTime();
  const t = (i: Item) => (i.at ? new Date(i.at).getTime() : Infinity);
  const sorted = [...items].sort((a, b) => t(a) - t(b));
  const out = sorted.filter(toApprove);
  return [
    { title: "Goes out today", rows: out.filter((i) => t(i) < tomorrow) },
    { title: "Later this week", rows: out.filter((i) => t(i) >= tomorrow && t(i) < week) },
    { title: "Later", rows: out.filter((i) => t(i) >= week) },
    { title: "To decide", rows: sorted.filter((i) => !toApprove(i)) },
  ];
}

/** The first `n` rows across the groups, in order; a group left empty has no heading. */
export const firstRows = (groups: ReturnType<typeof byDeadline>, n: number) => {
  let left = n;
  return groups
    .map((g) => {
      const rows = g.rows.slice(0, left);
      left -= rows.length;
      return { ...g, rows };
    })
    .filter((g) => g.rows.length > 0);
};

/**
 * Home: what is stuck, the first few drafts waiting for a yes (by when they go out, the clean ones
 * ticked to approve together), how today and the campaigns are going, and the week ahead.
 * Review (/review) is the one-at-a-time queue behind "Review all".
 */
export function Home(p: { workspaceId: string; role: Role; initial?: { items: Item[]; count: number } }) {
  const w = { workspaceId: p.workspaceId };
  const client = useQueryClient();
  const query = useQuery({ ...needsYouQuery(p.workspaceId), initialData: p.initial });
  // A Workspace with nothing on Brand yet hasn't been set up, so Home points there.
  const unset = useQuery(factsQuery(p.workspaceId)).data?.length === 0;
  const name = useQuery(meQuery).data?.name;
  // An agency's other clients with something waiting, so nothing sits unseen in a Workspace not open.
  const workspaces = useQuery(workspacesQuery).data ?? [];
  const waiting = useWaitingByWorkspace(workspaces.map((x) => x.id));
  const elsewhere = workspaces.filter((x) => x.id !== p.workspaceId && waiting[x.id]! > 0);
  const now = new Date();
  const all = query.data?.items ?? [];
  // Held or blocked: something has to be fixed before it can go, so it sits above the drafts.
  const stuck = all.filter((i) => i.state !== "needs_approval");
  const groups = byDeadline(
    all.filter((i) => i.state === "needs_approval"),
    now,
  );
  const shown = firstRows(groups, HOME_ROWS);
  const listed = shown.flatMap((g) => g.rows);
  const first = groups.slice(0, 3).find((g) => g.rows[0]?.at)?.rows[0];
  const approver = mayApprove(p.role);
  // Clean drafts start ticked; a person unticks what they want to read first.
  const [unticked, setUnticked] = useState<string[]>([]);
  const ticked = listed.filter((i) => i.clean && toApprove(i) && !unticked.includes(i.id));
  const [confirming, setConfirming] = useState(false);
  const [pending, setPending] = useState(false);
  const [refused, setRefused] = useState<string>();
  async function approveTicked() {
    setPending(true);
    try {
      const r = await approveClean(p.workspaceId, ticked);
      approvedToast(p.workspaceId, r.ids, mayEdit(p.role), () => client.invalidateQueries({ queryKey: inWorkspace(p.workspaceId) }));
      setRefused(r.refused.length > 0 ? `${r.refused.length} didn't go through: ${message(r.refused[0]!.reason)}` : undefined);
      await client.invalidateQueries({ queryKey: inWorkspace(p.workspaceId) });
    } finally {
      setPending(false);
      setConfirming(false);
    }
  }

  const count = query.data?.count ?? 0;
  const description = [
    now.toLocaleDateString("en-GB", { weekday: "long", day: "numeric", month: "long" }),
    count > 0 && `${count} ${count === 1 ? "needs" : "need"} you${first?.at ? `, the first goes out ${listTime(new Date(first.at))}` : ""}`,
  ]
    .filter(Boolean)
    .join(" · ");

  return (
    <Page title={greeting(now.getHours(), name)} description={description}>
      <Dialog isOpen={confirming} onOpenChange={setConfirming} purpose="form" width={448}>
        <DialogHeader title={`Approve ${ticked.length}?`} />
        <ApproveList items={ticked} />
        <div className="flex justify-end gap-2 pt-4">
          <Button variant="outline" onClick={() => setConfirming(false)}>
            Cancel
          </Button>
          <Button pending={pending} onClick={() => void approveTicked()}>{`Approve ${ticked.length}`}</Button>
        </div>
      </Dialog>
      {refused && <Notice tone="error">{refused}</Notice>}
      {/* Setup sits above the queue, never instead of it: what already waits stays one click away. */}
      {unset && (
        <EmptyState
          title="Set up this Workspace"
          action={
            <Link to="/w/$workspaceId/setup" params={w} className={buttonVariants()}>
              Start setup
            </Link>
          }
        >
          Tell Direx about your business, and it can plan and write for you.
        </EmptyState>
      )}
      {(!unset || count > 0) && (
        <>
          <AskBox />
          <div className="grid items-start gap-6 split:grid-cols-3">
            <section aria-labelledby="needs-you" className="flex min-w-0 flex-col gap-3 split:col-span-2">
              <div className="flex flex-wrap items-baseline justify-between gap-2">
                <h2 id="needs-you">{query.data ? `Needs you (${count})` : "Needs you"}</h2>
                {count > 0 && (
                  <Link to="/w/$workspaceId/review" params={w} className="text-sm underline underline-offset-4">
                    {`Review all ${count}`}
                  </Link>
                )}
              </div>
              {elsewhere.length > 0 && (
                <p className="flex flex-wrap gap-x-3 gap-y-1 text-sm text-muted-foreground">
                  <span>Also waiting:</span>
                  {elsewhere.map((x) => (
                    <Link key={x.id} to="/w/$workspaceId" params={{ workspaceId: x.id }}>
                      {`${x.name} (${waiting[x.id]})`}
                    </Link>
                  ))}
                </p>
              )}
              <QueryBoundary query={query} skeleton={<Skeleton className="h-64 w-full" />} messages={ITEM_MESSAGES}>
                {() => (
                  <>
                    {stuck.length > 0 && (
                      <ul aria-label="Needs a fix" className="flex flex-col gap-2">
                        {stuck.map((i) => (
                          <li key={i.id} className="flex items-start gap-3 rounded-card bg-muted px-4 py-3">
                            {/* The title gets the width; a long reason wraps under it rather than squeezing it. */}
                            <div className="flex min-w-0 flex-1 flex-col items-start gap-1.5">
                              <span className="font-medium wrap-break-word">{i.title}</span>
                              <StateChip state={i.state} reason={i.reason} />
                            </div>
                            <Link to="/w/$workspaceId/review/$itemId" params={{ ...w, itemId: i.id }} className={`shrink-0 ${buttonVariants({ variant: "outline", size: "sm" })}`}>
                              {fixLabel(i)}
                            </Link>
                          </li>
                        ))}
                      </ul>
                    )}
                    {listed.length === 0 ? (
                      stuck.length === 0 && (
                        <EmptyState
                          title="Nothing is waiting for you"
                          action={
                            <Link to="/w/$workspaceId/calendar" params={w} className={buttonVariants({ variant: "outline" })}>
                              Open the Calendar
                            </Link>
                          }
                        >
                          Drafts that need your yes show up here. What you approved is on the Calendar.
                        </EmptyState>
                      )
                    ) : (
                      <div className="flex flex-col rounded-card border border-border bg-card">
                        {shown.map((g) => (
                          <section key={g.title} aria-label={g.title} className="flex flex-col">
                            <h3 className="px-4 pt-3 pb-1 font-sans text-xs font-medium tracking-wide text-muted-foreground uppercase">{g.title}</h3>
                            <ul className="flex flex-col divide-y divide-border">
                              {g.rows.map((i) => (
                                <li key={i.id} className="flex items-start gap-3 px-4 py-3">
                                  {approver && i.clean && toApprove(i) && (
                                    <input
                                      type="checkbox"
                                      className="mt-1 size-4 shrink-0 accent-primary"
                                      aria-label={`Approve ${i.title} with the others`}
                                      checked={!unticked.includes(i.id)}
                                      onChange={(e) => setUnticked(e.target.checked ? unticked.filter((id) => id !== i.id) : [...unticked, i.id])}
                                    />
                                  )}
                                  <Link to="/w/$workspaceId/review/$itemId" params={{ ...w, itemId: i.id }} aria-label={`Open ${i.title}`} className="min-w-0 flex-1 no-underline hover:[&_.font-medium]:underline">
                                    <QueueRow item={i} workspaceId={p.workspaceId} />
                                  </Link>
                                </li>
                              ))}
                            </ul>
                          </section>
                        ))}
                        {/* Only with something in it: an empty footer reads as a blank row in the card. */}
                        {((approver && ticked.length > 0) || count > listed.length + stuck.length) && (
                          <div className="flex flex-wrap items-center justify-between gap-3 border-t border-border px-4 py-3">
                            {approver && ticked.length > 0 ? <Button onClick={() => setConfirming(true)}>{`Approve ${ticked.length} ticked`}</Button> : <span />}
                            {count > listed.length + stuck.length && (
                              <Link to="/w/$workspaceId/review" params={w} className="text-sm underline underline-offset-4">
                                {`${count - listed.length - stuck.length} more in Review`}
                              </Link>
                            )}
                          </div>
                        )}
                      </div>
                    )}
                  </>
                )}
              </QueryBoundary>
            </section>
            <div className="flex min-w-0 flex-col gap-6">
              <MorningBrief workspaceId={p.workspaceId} />
              <CampaignsCard workspaceId={p.workspaceId} />
            </div>
          </div>
          <Ideas workspaceId={p.workspaceId} edit={mayEdit(p.role)} />
          <ComingUp workspaceId={p.workspaceId} />
        </>
      )}
    </Page>
  );
}
