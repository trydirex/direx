// SPDX-License-Identifier: AGPL-3.0-only
import { FilterList } from "../components/FilterList";
import { Button, buttonVariants } from "@/components/Button";
import { ProgressBar } from "@astryxdesign/core/ProgressBar";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { Link } from "@tanstack/react-router";
import { EmptyState, Page } from "../components/layout";
import { QueryBoundary } from "../components/QueryBoundary";
import { Skeleton } from "@astryxdesign/core/Skeleton";
import { inWorkspace } from "../api/query";
import { itemQuery, mayApprove, mayEdit, typing, type Role } from "../items/actions";
import { CompanyReview, PageLink } from "./CompanyReview";
import { ReviewChip } from "../items/StateChip";
import { checkAgain, KIND_WORDS, leftOutWords, namesWords, readWords, RUN_WORDS, runQuery, searchName, SIGNAL_WORDS, STATE_WORDS, usd, whileRunning, type Company, type Review, type Run as RunData } from "./actions";

const MESSAGES = { not_found: "We couldn't find that search." };

/** A row of counts, each a label over its number. */
export function Stats(p: { label: string; stats: [string, number][] }) {
  return (
    <dl aria-label={p.label} className="flex flex-wrap gap-2">
      {p.stats.map(([name, n]) => (
        <div key={name} className="flex items-baseline gap-2 rounded-full bg-muted px-3 py-1 text-sm">
          <dt className="text-muted-foreground">{name}</dt>
          <dd className="font-medium tabular-nums">{n.toLocaleString()}</dd>
        </div>
      ))}
    </dl>
  );
}

/** Addresses the checking service hasn't answered, usually because it refused (no checks left), and the way to ask again. */
function Unchecked(p: { workspaceId: string; runId: string; count: number; onQueued: () => void }) {
  const [state, setState] = useState<"idle" | "pending" | "queued" | "failed">("idle");
  async function again() {
    setState("pending");
    try {
      await checkAgain(p.workspaceId, p.runId);
      setState("queued");
      p.onQueued();
    } catch {
      setState("failed");
    }
  }
  return (
    <div role="status" className="flex flex-wrap items-center gap-3">
      <p>
        {p.count} email {p.count === 1 ? "address" : "addresses"} couldn't be verified because your verification credits ran out. Top up, then check again.
      </p>
      <Button variant="outline" pending={state === "pending"} onClick={() => void again()}>
        Check again
      </Button>
      {state === "queued" && <span className="text-muted-foreground">Checking again. This page updates when it's done.</span>}
      {state === "failed" && <span className="text-destructive">That didn't go through. Try again.</span>}
    </div>
  );
}

/** One company's review, opened in place on the search's page. */
function ReviewHere(p: { workspaceId: string; itemId: string; role: Role; onSettle: () => void }) {
  const query = useQuery(itemQuery(p.workspaceId, p.itemId));
  const d = query.data;
  if (!d) return query.isError ? <p className="text-destructive">This review didn&apos;t load. Try again, or review it in Needs you.</p> : <Skeleton className="h-40 w-full" />;
  return <CompanyReview key={d.item.revision} workspaceId={p.workspaceId} item={d.item} review={d.content as Review} role={p.role} keys onSettle={p.onSettle} />;
}

/** One run's progress, and every company in it with what was read and why anything was left out. */
export function Run(p: { workspaceId: string; id: string; role: Role; initial?: { run: RunData; companies: Company[] } }) {
  const { workspaceId } = p;
  const client = useQueryClient();
  // Reads finish in the background, so the screen checks again until the run settles.
  const query = useQuery({ ...runQuery(workspaceId, p.id), initialData: p.initial, refetchInterval: whileRunning((d: { run: RunData }) => d.run.status) });
  // One company at a time opens into its review. A keeps and R rejects it, unless a field has the keys.
  const [open, setOpen] = useState<string>();
  const panel = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      const key = e.key.toLowerCase();
      if ((key !== "a" && key !== "r") || e.ctrlKey || e.metaKey || e.altKey || typing(e.target)) return;
      const button = panel.current?.querySelector<HTMLButtonElement>(`[aria-keyshortcuts="${key.toUpperCase()}"]`);
      if (!button || button.disabled) return;
      e.preventDefault();
      button.click();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open]);
  // After a decision the next company waiting opens, so a search can be reviewed in one pass.
  const settled = async (waiting: Company[], id: string) => {
    const after = waiting[waiting.findIndex((c) => c.id === id) + 1];
    setOpen(after?.reviewItemId ? after.id : undefined);
    void client.invalidateQueries({ queryKey: inWorkspace(workspaceId, "items") });
    await query.refetch();
  };

  return (
    <QueryBoundary query={query} messages={MESSAGES} skeleton={<Skeleton className="h-96 w-full" />}>
      {({ run, companies }) => {
        const g = run.progress;
        const waiting = companies.filter((c) => c.state === "in_review");
        const kept = companies.filter((c) => c.state === "accepted").length;
        const first = waiting[0];
        const approver = mayApprove(p.role);
        return (
          <Page
            title={searchName(run)}
            description={`${run.source === "pasted" ? "Pasted websites" : "Search"}: ${RUN_WORDS[run.status] ?? run.status}`}
            actions={
              <>
                {first &&
                  (first.reviewItemId ? (
                    <Link to="/w/$workspaceId/review/$itemId" params={{ workspaceId, itemId: first.reviewItemId }} className={buttonVariants({ variant: "outline" })}>
                      Review {waiting.length === 1 ? "1 company" : `${waiting.length} companies`} in Needs you
                    </Link>
                  ) : (
                    <Link to="/w/$workspaceId" params={{ workspaceId }} className={buttonVariants({ variant: "outline" })}>
                      Review {waiting.length === 1 ? "1 company" : `${waiting.length} companies`} in Needs you
                    </Link>
                  ))}
                <Link to="/w/$workspaceId/people/find" params={{ workspaceId }} className="underline underline-offset-4">
                  Find more companies
                </Link>
              </>
            }
          >
            <div className="flex flex-col gap-3">
              <ProgressBar label={`${g.read + g.notRead} of ${g.companies} companies read`} value={g.read + g.notRead} max={Math.max(g.companies, 1)} />
              <Stats
                label="This search so far"
                stats={[
                  ["Found", g.companies],
                  ["Waiting for you", waiting.length],
                  ["Kept", kept],
                ]}
              />
              <p role="status" className="text-sm text-muted-foreground">
                {g.read} read, {g.notRead} not read, {g.readPending} still to read. Names read for {g.namesDone}, skipped for {g.namesSkipped}, {g.namesPending} still being read.
              </p>
              <p className="text-sm text-muted-foreground">
                {run.source === "pasted" ? `Direx estimated about ${usd(run.confirmedUsd)}. Pasted websites have no spend limit.` : `Spend up to ${usd(run.confirmedUsd)}.`} Paid to outside services so far:{" "}
                {usd(run.vendorCostUsd)}. Model cost for reading names isn&apos;t counted here yet.
              </p>
              {run.unchecked > 0 && <Unchecked workspaceId={workspaceId} runId={run.id} count={run.unchecked} onQueued={() => void query.refetch()} />}
            </div>
            {kept > 0 && mayEdit(p.role) && (
              <div className="flex flex-wrap items-center gap-3 rounded-card bg-peach p-4 text-peach-foreground">
                <p className="flex-1">
                  You kept {kept === 1 ? "1 company" : `${kept} companies`}. Turn them into a segment, then add it to a Campaign.
                </p>
                <Link to="/w/$workspaceId/people/cohorts" params={{ workspaceId }} search={{ runs: run.id }} className={buttonVariants()}>
                  Make a segment from the {kept === 1 ? "1 kept company" : `${kept} kept companies`}
                </Link>
              </div>
            )}
            {approver && waiting.some((c) => c.reviewItemId) && (
              <p className="text-sm text-muted-foreground">Open a company to review it here, then press A to keep it or R to reject it.</p>
            )}
            {companies.length === 0 ? (
              <EmptyState title="No companies yet">Each company shows here once Direx starts reading its site.</EmptyState>
            ) : (
              <FilterList
                noun="companies"
                items={companies}
                id={(c) => c.id}
                text={(c) => `${c.name ?? ""} ${c.domain}`}
                filters={[
                  { label: STATE_WORDS.in_review!, test: (c) => c.state === "in_review" },
                  { label: STATE_WORDS.accepted!, test: (c) => c.state === "accepted" },
                  { label: STATE_WORDS.rejected!, test: (c) => c.state === "rejected" },
                  { label: "Couldn't read", test: (c) => c.readStatus === "not_read" },
                ]}
              >
                {(c) => {
                  const leftOut = c.addresses.filter((a) => a.leftOutReason);
                  return (
                    <>
                      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                        <strong className="font-medium">{c.name ?? c.domain}</strong>
                        {c.name && <span className="text-sm text-muted-foreground">{c.domain}</span>}
                        <ReviewChip state={c.state} label={STATE_WORDS[c.state] ?? c.state} />
                        {c.readStatus === "read" && <span className="text-sm tabular-nums">{c.addresses.length === 1 ? "1 address" : `${c.addresses.length} addresses`}</span>}
                        {c.state === "in_review" &&
                          (c.reviewItemId ? (
                            <Button size="sm" variant="outline" aria-expanded={open === c.id} aria-controls={`review-${c.id}`} onClick={() => setOpen(open === c.id ? undefined : c.id)}>
                              {open === c.id ? "Close the review" : "Review"}
                            </Button>
                          ) : (
                            <Link to="/w/$workspaceId" params={{ workspaceId }} className="text-sm underline underline-offset-4">
                              Review it in Needs you
                            </Link>
                          ))}
                      </div>
                      <p className="text-sm text-muted-foreground">
                        {readWords(c)}. {namesWords(c.namesStatus, c.namesReason)}.
                      </p>
                      {c.signals.length > 0 && (
                        <ul aria-label={`Signals at ${c.domain}`} className="flex flex-col gap-1 text-sm">
                          {c.signals.map((s, n) => (
                            <li key={n}>
                              <span className="font-medium">{SIGNAL_WORDS[s.type] ?? s.type}</span>: <q>{s.quote}</q> <PageLink url={s.pageUrl}>on this page</PageLink>, read {s.observedOn}
                            </li>
                          ))}
                        </ul>
                      )}
                      {leftOut.length > 0 && (
                        <ul aria-label={`Left out at ${c.domain}`} className="flex flex-col gap-1 pl-4 text-sm text-muted-foreground">
                          {leftOut.map((a) => (
                            <li key={a.email}>
                              {a.email} ({KIND_WORDS[a.kind] ?? a.kind}) left out: {leftOutWords(a.leftOutReason!)}
                            </li>
                          ))}
                        </ul>
                      )}
                      {open === c.id && c.reviewItemId && (
                        <div id={`review-${c.id}`} ref={panel} className="rounded-card border border-border p-3">
                          <ReviewHere workspaceId={workspaceId} itemId={c.reviewItemId} role={p.role} onSettle={() => void settled(waiting, c.id)} />
                        </div>
                      )}
                    </>
                  );
                }}
              </FilterList>
            )}
          </Page>
        );
      }}
    </QueryBoundary>
  );
}
