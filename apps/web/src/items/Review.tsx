// SPDX-License-Identifier: AGPL-3.0-only
import { useEffect, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { inWorkspace } from "../api/query";
import { EmptyState, Notice, Page } from "../components/layout";
import { QueryBoundary } from "../components/QueryBoundary";
import { Button, buttonVariants, Key } from "@/components/Button";
import { Dialog, DialogHeader } from "@astryxdesign/core/Dialog";
import { Skeleton } from "@astryxdesign/core/Skeleton";
import { toast } from "@/components/toast";
import { factsQuery } from "../facts/actions";
import { useCommands } from "../shell/commands";
import { approve as approveOne, approveClean, BULK, cancel, itemQuery, ITEM_MESSAGES, kindLabel, mayApprove, mayEdit, message, needsYouQuery, reviewRatesQuery, STATE_LABEL, toApprove, typing, type BulkResult, type Item, type Role } from "./actions";
import { ItemPanel, usePlanGone } from "./ItemPanel";
import { ApproveList, approvedToast, QueueRow } from "./QueueRow";
import { Postmark } from "./StateChip";

/** The record an Item's group names (`campaign:<id>…` or `plan:<id>`), so a row links straight to it. Older Items have none. */
export const named = (groupKey: string | null, kind: "campaign" | "plan") => groupKey?.match(new RegExp(`^${kind}:([^:]+)`))?.[1];

/** The queue with skipped Items moved to the end, last skipped last. */
export const backOfQueue = (items: Item[], skipped: string[]) => [...items.filter((i) => !skipped.includes(i.id)), ...skipped.flatMap((id) => items.filter((i) => i.id === id))];

/** The queue in the order Review shows it: what goes out ("To approve") first, then what to decide. */
export const grouped = (items: Item[]) => [...items.filter(toApprove), ...items.filter((i) => !toApprove(i))];


/**
 * Review: what needs this person, as a queue beside the open Item, the first one open. J and K move, A
 * approves, E goes to the edit, S skips; each is also a button. One tap approves everything with no
 * warnings. Below 1100px the open Item sits above the queue. Home shows the first few and links here.
 */
export function Review(p: { workspaceId: string; role: Role;
  /** The Item to open on, from a link (/review/$itemId); it shows even if it has left the queue. */
  open?: string;
  /** Called with the Item on screen each time it changes, so the address follows J and K and a reload opens it again. */
  onOpen?: (id: string) => void;
  initial?: { items: Item[]; count: number } }) {
  const w = { workspaceId: p.workspaceId };
  const client = useQueryClient();
  const query = useQuery({ ...needsYouQuery(p.workspaceId), initialData: p.initial });
  // A Workspace with nothing on Brand yet hasn't been set up, so the empty Home points there.
  const unset = useQuery(factsQuery(p.workspaceId)).data?.length === 0;
  // Skipped Items go to the back of the queue, in the order they were skipped; only this screen remembers.
  const [skipped, setSkipped] = useState<string[]>([]);
  const all = grouped(backOfQueue(query.data?.items ?? [], skipped));
  // One kind at a time ("Emails"), or everything; J, K and S move within what is shown.
  const [kind, setKind] = useState<string>();
  const items = kind ? all.filter((i) => kindLabel(i) === kind) : all;
  const kinds = [...new Set(all.map(kindLabel))];
  // The Item shown and where it sat, so it stays on screen (as Scheduled, say) after it leaves the list.
  const [at, setAt] = useState<{ id: string; index: number }>();
  if (!at && (p.open ?? items[0])) {
    const id = p.open ?? items[0]!.id;
    setAt({ id, index: Math.max(0, items.findIndex((i) => i.id === id)) });
  }
  // A new link while Review is open opens its Item; the address changing to the Item already shown does nothing.
  const [linked, setLinked] = useState(p.open);
  if (p.open !== linked) {
    setLinked(p.open);
    if (p.open && p.open !== at?.id) setAt({ id: p.open, index: Math.max(0, items.findIndex((i) => i.id === p.open)) });
  }
  useEffect(() => {
    if (at && at.id !== p.open) p.onOpen?.(at.id);
  }, [at?.id]);
  // E only does something where the Item on screen can still change and this person may change it.
  const shown = useQuery({ ...itemQuery(p.workspaceId, at?.id ?? ""), enabled: !!at }).data?.item;
  const editable = mayEdit(p.role) && !!shown && (shown.state === "draft" || shown.state === "needs_approval" || shown.state === "scheduled" || shown.state === "held");
  const panel = useRef<HTMLDivElement>(null);
  // Whether this person saw the queue with something in it, so emptying it can say they cleared it.
  const hadSome = useRef(false);
  if (all.length > 0) hadSome.current = true;

  const found = at ? items.findIndex((i) => i.id === at.id) : -1;
  const pos = found !== -1 ? found : (at?.index ?? 0) - 0.5;
  // After a change to the Item on screen, once the queue is read again: if it left the queue
  // (approved, say), the next one takes its place, and after the last the queue is cleared.
  // A toast says where the one that left went ("Scheduled", not "Sent"), since it is no longer on screen.
  const [changed, setChanged] = useState<string>();
  async function stop(id: string) {
    const refused = await cancel(p.workspaceId, id);
    toast.add({ title: refused ? message(refused) : "Not sent. It won't go out." });
    await client.invalidateQueries({ queryKey: inWorkspace(p.workspaceId) });
  }
  // In an effect, not the render: the toast is another component's state, and a render may run twice.
  useEffect(() => {
    if (!changed || changed !== at?.id) return;
    setChanged(undefined);
    const n = Math.ceil(pos);
    if (found === -1) {
      const left = client.getQueryData(itemQuery(p.workspaceId, changed).queryKey)?.item;
      // A send that is now Scheduled gets its postmark, with when it goes out.
      if (left)
        toast.add({
          title:
            left.state === "scheduled" && left.at ? (
              <span className="flex items-center gap-3">
                {left.title}
                <Postmark at={new Date(left.at)} />
              </span>
            ) : (
              // A notice is dismissed, not cancelled: the toast says what its button said.
              `${left.title}: ${left.state === "cancelled" && left.kind !== "action" ? "Dismissed" : STATE_LABEL[left.state]}`
            ),
          // It has left the queue, so the toast keeps the way to stop it: the same cancel as Don't send, while the ledger allows it.
          ...(left.state === "scheduled" && mayEdit(p.role) && { actionProps: { children: "Don't send", onClick: () => void stop(left.id) } }),
        });
      setAt(items[n] ? { id: items[n].id, index: n } : items[0] ? { id: items[0].id, index: 0 } : undefined);
    }
  }, [changed, at?.id]);
  // The next Item loads while this one is read, so J opens it at once.
  const upNext = items[Math.floor(pos) + 1]?.id;
  useEffect(() => {
    if (upNext) void client.prefetchQuery(itemQuery(p.workspaceId, upNext));
  }, [upNext]);
  // Only this reviewer's own pace; it warns and blocks nothing.
  const fast = useQuery(reviewRatesQuery(p.workspaceId)).data?.warning;
  const go = (n: number) => items[n] && setAt({ id: items[n].id, index: n });
  const next = () => go(Math.floor(pos) + 1);
  const previous = () => go(Math.ceil(pos) - 1);
  const approve = () => panel.current?.querySelector<HTMLButtonElement>('[aria-keyshortcuts="A"]')?.click();
  // Only a company review has a reject of its own; R does nothing on anything else.
  const company = all.find((i) => i.id === at?.id)?.kind === "company_review";
  const reject = () => panel.current?.querySelector<HTMLButtonElement>('[aria-keyshortcuts="R"]')?.click();
  // E opens the Item's text editor where it has one, otherwise the first field (a time, the rewrite box).
  const edit = () => {
    const editor = panel.current?.querySelector<HTMLButtonElement>("[data-edit-text]");
    if (editor) editor.click();
    else panel.current?.querySelector<HTMLElement>("input, textarea, select")?.focus();
  };
  const skip = () => {
    if (!at) return;
    // Move on to the one after it (or back to the top), and send this one to the back.
    const after = items[Math.floor(pos) + 1] ?? items.find((i) => i.id !== at.id);
    const back = [...skipped.filter((id) => id !== at.id), at.id];
    setSkipped(back);
    if (after) setAt({ id: after.id, index: grouped(backOfQueue(query.data?.items ?? [], back)).findIndex((i) => i.id === after.id) });
  };

  const keys: Record<string, () => void> = { j: next, k: previous, a: approve, s: skip, ...(editable ? { e: edit } : {}), ...(company ? { r: reject } : {}) };
  // The palette offers these only while an Item is open.
  useCommands(!at ? [] : [
    { id: "review:next", label: "Next", keys: "J", group: "Review", run: next },
    { id: "review:previous", label: "Previous", keys: "K", group: "Review", run: previous },
    { id: "review:approve", label: "Approve", keys: "A", group: "Review", run: approve },
    ...(editable ? [{ id: "review:edit", label: "Edit", keys: "E", group: "Review", run: edit }] : []),
    { id: "review:skip", label: "Skip", keys: "S", group: "Review", run: skip },
    ...(company ? [{ id: "review:reject", label: "Reject the company", keys: "R", group: "Review", run: reject }] : []),
  ]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!at || e.ctrlKey || e.metaKey || e.altKey || typing(e.target)) return;
      const run = keys[e.key.toLowerCase()];
      if (!run) return;
      e.preventDefault();
      run();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  // One post goes to each of its networks as its own Item; they share the step's group, so the open one
  // can be approved with the rest of its post in one go.
  const open = all.find((i) => i.id === at?.id);
  const together = open?.workArea === "social" && open.groupKey ? all.filter((i) => i.workArea === "social" && i.groupKey === open.groupKey && i.state === "needs_approval") : [];
  const [approvingTogether, setApprovingTogether] = useState(false);
  async function approveTogether() {
    setApprovingTogether(true);
    try {
      const codes = await Promise.all(together.map((i) => approveOne(p.workspaceId, i)));
      const refusedCodes = codes.filter((c): c is string => c !== null);
      approvedToast(p.workspaceId, together.filter((_, n) => codes[n] === null).map((i) => i.id), mayEdit(p.role), () => client.invalidateQueries({ queryKey: inWorkspace(p.workspaceId) }));
      setRefused(refusedCodes.length > 0 ? `${refusedCodes.length} didn't go through: ${message(refusedCodes[0]!)}` : undefined);
      await client.invalidateQueries({ queryKey: inWorkspace(p.workspaceId) });
    } finally {
      setApprovingTogether(false);
    }
  }

  // Only what is shown: with "Posts" picked, the emails that also have no warnings wait.
  const clean = items.filter((i) => i.state === "needs_approval" && i.clean);
  const going = Math.min(clean.length, BULK);
  const [confirming, setConfirming] = useState(false);
  const [pending, setPending] = useState(false);
  const [refused, setRefused] = useState<string>();
  async function approveAll() {
    setPending(true);
    try {
      const r: BulkResult = await approveClean(p.workspaceId, clean);
      approvedToast(p.workspaceId, r.ids, mayEdit(p.role), () => client.invalidateQueries({ queryKey: inWorkspace(p.workspaceId) }));
      setRefused(r.refused.length > 0 ? `${r.refused.length} didn't go through: ${message(r.refused[0]!.reason)}` : undefined);
      await client.invalidateQueries({ queryKey: inWorkspace(p.workspaceId) });
    } finally {
      setPending(false);
      setConfirming(false);
    }
  }

  const control = (label: string, key: string, run: () => void) => (
    <Button size="sm" variant="outline" label={label} aria-keyshortcuts={key} onClick={run}>
      {label} <Key>{key}</Key>
    </Button>
  );

  return (
    <Page
      title="Review"
      description="One draft at a time. Each button shows its key."
      actions={
        <Link to="/w/$workspaceId" params={w} className={buttonVariants({ variant: "outline" })}>
          Back to Home
        </Link>
      }
    >
      <Dialog isOpen={confirming} onOpenChange={setConfirming} purpose="form" width={448}>
        <DialogHeader title={`Approve ${going} with no warnings?`} />
        <ApproveList items={clean} />
        <div className="flex justify-end gap-2 pt-4">
          <Button variant="outline" onClick={() => setConfirming(false)}>
            Cancel
          </Button>
          <Button pending={pending} onClick={() => void approveAll()}>{`Approve ${going}`}</Button>
        </div>
      </Dialog>
      {refused && <Notice tone="error">{refused}</Notice>}
      <section aria-labelledby="waiting" className="flex flex-col gap-4">
        {/* A Contributor or Viewer can't approve, so the queue isn't theirs to clear. */}
        <h2 id="waiting">{(mayApprove(p.role) ? "Waiting for you" : "Waiting for approval") + (query.data ? ` (${query.data.count})` : "")}</h2>
        <QueryBoundary query={query} skeleton={<Skeleton className="h-96 w-full" />} messages={ITEM_MESSAGES}>
          {() =>
            !at ? (
              unset ? (
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
              ) : (
                <EmptyState
                  title={hadSome.current ? "All caught up" : "Nothing is waiting for you"}
                  action={
                    <div className="flex flex-wrap gap-2">
                      {hadSome.current && (
                        <Link to="/w/$workspaceId/campaigns" params={w} className={buttonVariants()}>
                          Plan next week's posts
                        </Link>
                      )}
                      <Link to="/w/$workspaceId/calendar" params={w} className={buttonVariants({ variant: "outline" })}>
                        Open the Calendar
                      </Link>
                    </div>
                  }
                >
                  {hadSome.current ? "You cleared the queue. What you approved is on the Calendar." : "Drafts that need your yes show up here."}
                </EmptyState>
              )
            ) : (
              <div className="grid gap-6 split:grid-cols-3">
                <div className="order-last flex min-w-0 flex-col gap-3 self-start split:order-first">
                  {(kinds.length > 1 || (clean.length > 0 && mayApprove(p.role))) && (
                    <div className="flex flex-wrap items-center gap-2">
                      {kinds.length > 1 && (
                        <div role="group" aria-label="Show" className="flex flex-wrap gap-1.5">
                          {[undefined, ...kinds].map((k) => (
                            <Button key={k ?? "all"} size="xs" variant={kind === k ? "default" : "outline"} className="rounded-full" aria-pressed={kind === k} onClick={() => setKind(k)}>
                              {`${k ?? "All"} ${k ? all.filter((i) => kindLabel(i) === k).length : all.length}`}
                            </Button>
                          ))}
                        </div>
                      )}
                      {clean.length > 0 && mayApprove(p.role) && (
                        <Button size="sm" onClick={() => setConfirming(true)}>
                          {`Approve ${clean.length} with no warnings`}
                        </Button>
                      )}
                    </div>
                  )}
                  {/* Only this reviewer's own pace; a quiet line, it blocks nothing. */}
                  {fast && <p className="text-sm text-muted-foreground">You're moving quickly today. The warnings are worth a glance before the rest.</p>}
                  <nav aria-label="Queue" className="flex min-w-0 flex-col gap-3">
                    {/* Things that go out first, then decisions; J and K walk both in this order. An empty group has no heading. */}
                    {[
                      { title: "To approve", rows: items.filter(toApprove) },
                      { title: "To decide", rows: items.filter((i) => !toApprove(i)) },
                    ].map(
                      (g) =>
                        g.rows.length > 0 && (
                          <section key={g.title} aria-label={g.title} className="flex flex-col gap-2">
                            <h2 className="text-sm font-medium text-muted-foreground">{`${g.title} (${g.rows.length})`}</h2>
                            <ul className="flex flex-col divide-y divide-border rounded-card border border-border bg-card">
                              {g.rows.map((i) => (
                                <li key={i.id} className="flex flex-col items-start gap-1 first:rounded-t-card last:rounded-b-card">
                                  {/* Everything here needs you, so the row says what it is; a chip shows only when something else is true, like Held. */}
                                  <Button
                                    variant="ghost"
                                    aria-label={`Open ${i.title}`}
                                    aria-current={i.id === at.id ? "true" : undefined}
                                    className={`h-auto w-full justify-start rounded-none px-4 py-3 text-left font-normal whitespace-normal border-l-2 ${i.id === at.id ? "border-foreground bg-muted" : "border-transparent"}`}
                                    onClick={() => setAt({ id: i.id, index: items.indexOf(i) })}
                                  >
                                    <QueueRow item={i} workspaceId={p.workspaceId} />
                                  </Button>
                                  <RowLink item={i} workspaceId={p.workspaceId} />
                                </li>
                              ))}
                            </ul>
                          </section>
                        ),
                    )}
                  </nav>
                </div>
                <div ref={panel} className="flex min-w-0 flex-col gap-4 rounded-card border border-border bg-card p-6 split:col-span-2">
                  <ItemPanel
                    key={at.id}
                    workspaceId={p.workspaceId}
                    id={at.id}
                    role={p.role}
                    keys
                    onChange={() => setChanged(at.id)}
                    toolbar={
                      <>
                        {together.length > 1 && mayApprove(p.role) && (
                          <Button variant="outline" pending={approvingTogether} onClick={() => void approveTogether()}>
                            {together.length === 2 ? "Approve both" : `Approve all ${together.length}`}
                          </Button>
                        )}
                        {control("Previous", "K", previous)}
                        {control("Next", "J", next)}
                        {editable && control("Edit", "E", edit)}
                        {control("Skip", "S", skip)}
                        <span aria-live="polite" className="ml-auto text-sm text-muted-foreground">
                          {found !== -1 ? `${found + 1} of ${items.length}` : `${items.length} left`}
                        </span>
                      </>
                    }
                  />
                </div>
              </div>
            )
          }
        </QueryBoundary>
      </section>
    </Page>
  );
}

/** Where a row's work is finished, when that is outside the Item: a Campaign's People tab, a plan, an issue. */
function RowLink({ item: i, workspaceId }: { item: Item; workspaceId: string }) {
  const w = { workspaceId };
  const cls = "px-4 pb-3 text-sm";
  if (i.kind === "campaign_conflict")
    return named(i.groupKey, "campaign") ? (
      <Link className={cls} to="/w/$workspaceId/campaigns/$campaignId" params={{ ...w, campaignId: named(i.groupKey, "campaign")! }} search={{ tab: "people" }}>
        Choose on the campaign's People tab
      </Link>
    ) : (
      <Link className={cls} to="/w/$workspaceId/campaigns" params={w}>
        Choose on the campaign's People tab
      </Link>
    );
  if (i.kind === "plan_version") return <PlanRowLink planId={named(i.groupKey, "plan")} workspaceId={workspaceId} />;
  if (i.kind === "strategy_version")
    return (
      <Link className={cls} to="/w/$workspaceId/brand" params={w}>
        Read it on Brand
      </Link>
    );
  if (i.workArea === "newsletter" && i.kind !== "newsletter_skipped")
    return (
      <Link className={cls} to="/w/$workspaceId/newsletter/$issueId" params={{ ...w, issueId: i.id }}>
        Write and preview it
      </Link>
    );
  return null;
}

/** A plan_version row's link to its Campaign's Plan tab, through the plan's link, or word that its draft was deleted (ADR 0023). */
function PlanRowLink({ planId, workspaceId }: { planId: string | undefined; workspaceId: string }) {
  const w = { workspaceId };
  const cls = "px-4 pb-3 text-sm";
  if (usePlanGone(workspaceId, planId)) return <p className={cls}>This draft was deleted.</p>;
  return planId ? (
    <Link className={cls} to="/w/$workspaceId/plans/$planId" params={{ ...w, planId }}>
      Read the plan
    </Link>
  ) : (
    <Link className={cls} to="/w/$workspaceId/campaigns" params={w}>
      Read it in Campaigns
    </Link>
  );
}
