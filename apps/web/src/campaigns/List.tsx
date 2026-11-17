// SPDX-License-Identifier: AGPL-3.0-only
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { EmptyState, Page } from "../components/layout";
import { QueryBoundary } from "../components/QueryBoundary";
import { Button } from "@/components/Button";
import { Skeleton } from "@astryxdesign/core/Skeleton";
import { Dialog, DialogHeader } from "@astryxdesign/core/Dialog";
import { ChannelMarks } from "../components/ChannelMark";
import { CampaignChip } from "../items/StateChip";
import { cn } from "@/lib/cn";
import { mayEdit, type Role } from "../items/actions";
import { MeasureLine } from "../plans/Fields";
import { NewCampaign } from "../plans/NewCampaign";
import { campaignsQuery, dayWords, type Listed } from "./actions";
import { campaignStatus } from "./Overview";

/** Every Campaign with its status, Drafts included (ADR 0023). A new one starts here. */
const day = dayWords;

/** A Campaign's dates in words: "Sun, 1 Nov to Mon, 30 Nov", or only its start. */
const datesWords = (c: Listed) => (c.startsOn && c.endsOn ? `${day(c.startsOn)} to ${day(c.endsOn)}` : c.startsOn ? `From ${day(c.startsOn)}` : null);

/** The list's groups in order, by what each Campaign needs from a person. Paused sits with the running ones. */
const GROUPS = ["Needs you", "Running and scheduled", "Drafts", "Ended"] as const;
function groupOf(c: Pick<Listed, "needApproval" | "status">): (typeof GROUPS)[number] {
  if (c.needApproval > 0 || c.status === "awaiting_signoff" || c.status === "no_launch_date") return "Needs you";
  if (c.status === "draft") return "Drafts";
  if (c.status === "ended") return "Ended";
  return "Running and scheduled";
}

const TH = "px-4 py-2 font-medium";
const TD = "px-4 py-3 align-top";

export function Campaigns(p: { workspaceId: string; role: Role; initial?: Listed[] }) {
  const { workspaceId } = p;
  const campaigns = useQuery({ ...campaignsQuery(workspaceId), initialData: p.initial });
  const [starting, setStarting] = useState(false);
  return (
    <Page
      title="Campaigns"
      actions={
        mayEdit(p.role) && (
          <Button size="sm" onClick={() => setStarting(true)}>
            New campaign
          </Button>
        )
      }
    >
      <Dialog isOpen={starting} onOpenChange={setStarting} purpose="form" width={448}>
        <DialogHeader title="Start a campaign" />
        {starting && <NewCampaign workspaceId={workspaceId} onCancel={() => setStarting(false)} />}
      </Dialog>
      <QueryBoundary query={campaigns} skeleton={<Skeleton className="h-24 w-full" />}>
        {(list) =>
          list.length === 0 ? (
            <EmptyState
              title="No campaigns yet."
              action={
                mayEdit(p.role) &&
                !starting && (
                  <Button size="sm" onClick={() => setStarting(true)}>
                    Start a campaign
                  </Button>
                )
              }
            >
              A campaign starts with its plan. Direx drafts it from one sentence, and nothing goes out until someone approves it.
            </EmptyState>
          ) : (
            // A wide table scrolls sideways on a phone rather than squeezing its columns.
            <div className="overflow-x-auto rounded-card border border-border bg-card">
              <table aria-label="Campaigns" className="w-full text-left text-sm">
                <thead className="border-b border-border text-xs text-muted-foreground">
                  <tr>
                    <th className={TH}>Campaign</th>
                    <th className={TH}>Status</th>
                    <th className={TH}>Dates</th>
                    <th className={TH}>Main measure</th>
                    <th className={cn(TH, "text-right")}>Waiting on you</th>
                  </tr>
                </thead>
                {GROUPS.map((g) => {
                  const rows = list.filter((c) => groupOf(c) === g);
                  if (!rows.length) return null;
                  return (
                    <tbody key={g}>
                      <tr className="bg-muted">
                        <th colSpan={5} scope="colgroup" className={cn(TH, "text-xs text-muted-foreground")}>
                          {g}
                        </th>
                      </tr>
                      {rows.map((c) => (
                        <tr key={c.id} className="border-t border-border">
                          <td className={TD}>
                            <div className="flex items-start gap-3">
                              <ChannelMarks kinds={c.channels} />
                              <div className="flex min-w-0 flex-col gap-0.5">
                                <Link to="/w/$workspaceId/campaigns/$campaignId" params={{ workspaceId, campaignId: c.id }} className="font-medium">
                                  {c.title}
                                </Link>
                                {c.goal && <span className="line-clamp-2 text-muted-foreground">{c.goal}</span>}
                              </div>
                            </div>
                          </td>
                          <td className={TD}>
                            {/* The list has no anchor day, so a scheduled launch is named by its start date. */}
                            <CampaignChip status={c.status} label={campaignStatus(c)} />
                          </td>
                          <td className={cn(TD, "whitespace-nowrap text-muted-foreground tabular-nums")}>{datesWords(c) ?? "No dates yet"}</td>
                          <td className={TD}>{c.measure ? <MeasureLine measure={c.measure} /> : <span className="text-muted-foreground">Measure not set</span>}</td>
                          <td className={cn(TD, "text-right")}>
                            {c.needApproval > 0 ? (
                              <Link to="/w/$workspaceId/campaigns/$campaignId" params={{ workspaceId, campaignId: c.id }} search={{ tab: "drafts" }} className="whitespace-nowrap rounded-full bg-peach px-3 py-1 text-peach-foreground no-underline tabular-nums">
                                {`${c.needApproval} need approval`}
                              </Link>
                            ) : c.status === "awaiting_signoff" ? (
                              <Link to="/w/$workspaceId/campaigns/$campaignId" params={{ workspaceId, campaignId: c.id }} search={{ tab: "plan" }} className="whitespace-nowrap">
                                Sign off plan
                              </Link>
                            ) : (
                              <span className="text-muted-foreground">{c.status === "no_launch_date" ? "Pick a launch date" : "Nothing waiting"}</span>
                            )}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  );
                })}
              </table>
            </div>
          )
        }
      </QueryBoundary>
    </Page>
  );
}

/** The Campaigns as a narrow list beside one of them, from the `split` width. Silent when the list can't be read: the Campaign beside it is what matters. */
export function CampaignRows(p: { workspaceId: string; current: string; tab: string }) {
  const list = useQuery(campaignsQuery(p.workspaceId)).data;
  if (!list?.length) return null;
  return (
    <nav aria-label="All campaigns" className="hidden self-start split:block">
      <ul className="flex flex-col overflow-hidden rounded-card border border-border bg-card">
        {list.map((c) => (
          <li key={c.id} className="border-b border-border last:border-b-0">
            <Link
              to="/w/$workspaceId/campaigns/$campaignId"
              params={{ workspaceId: p.workspaceId, campaignId: c.id }}
              search={{ tab: p.tab }}
              aria-current={c.id === p.current ? "page" : undefined}
              className={cn("flex flex-col gap-0.5 px-4 py-3 no-underline hover:bg-muted", c.id === p.current && "bg-primary-tint")}
            >
              <span className="flex items-center gap-2">
                <ChannelMarks kinds={c.channels} />
                <span className="font-medium">{c.title}</span>
              </span>
              <span className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                <CampaignChip status={c.status} label={campaignStatus(c)} />
                {[datesWords(c), c.needApproval > 0 && `${c.needApproval} need approval`].filter(Boolean).join(" · ")}
              </span>
            </Link>
          </li>
        ))}
      </ul>
    </nav>
  );
}
