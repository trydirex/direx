// SPDX-License-Identifier: AGPL-3.0-only
// One Item as a line in a queue: what it is, where it belongs and when it sends on top, its title, then
// its warnings and why it is held. Home and Review show the same row.
import { BuildingIcon, CircleDotIcon, FileSearchIcon, LightbulbIcon, MailIcon, MapIcon, NewspaperIcon, Share2Icon } from "lucide-react";
import { useQuery } from "@tanstack/react-query";
import { toast } from "@/components/toast";
import { networksQuery } from "../social/actions";
import { BULK, cancelAll, kindLabel, listTime, sendTime, type Item } from "./actions";
import { StateChip, WarningCount } from "./StateChip";

/**
 * What a bulk approval says yes to, each with when it goes out, for the confirm dialog on Home and
 * Review. Past one request's worth it says only the first go now.
 */
export function ApproveList({ items }: { items: Item[] }) {
  return (
    <>
      <ul aria-label="To approve" className="flex max-h-80 flex-col gap-1 overflow-y-auto pt-2 text-sm">
        {items.slice(0, BULK).map((i) => (
          <li key={i.id} className="flex justify-between gap-4">
            <span className="min-w-0 truncate">{i.title}</span>
            <span className="shrink-0 text-muted-foreground tabular-nums">{i.at ? sendTime(new Date(i.at)) : "Now"}</span>
          </li>
        ))}
      </ul>
      {items.length > BULK && <p className="pt-2 text-sm text-muted-foreground">{`The first ${BULK} are approved now. Approve again for the other ${items.length - BULK}.`}</p>}
    </>
  );
}

const iconFor = (i: Item) => {
  if (i.kind === "company_review") return BuildingIcon;
  if (i.kind === "brief") return FileSearchIcon;
  if (i.kind === "plan_version" || i.kind === "strategy_version" || i.kind === "plan_change" || i.kind === "next_step") return MapIcon;
  if (i.kind.startsWith("fact_") || i.kind.startsWith("lesson_")) return LightbulbIcon;
  if (i.workArea === "newsletter" || i.kind === "newsletter_skipped") return NewspaperIcon;
  if (i.workArea === "outreach") return MailIcon;
  if (i.workArea === "social") return Share2Icon;
  return CircleDotIcon;
};

export function QueueRow({ item: i, workspaceId }: { item: Item; workspaceId: string }) {
  const Icon = iconFor(i);
  // A post's channel is its network's key ("linkedin_page"); people read the network's name.
  const channel = useQuery(networksQuery(workspaceId)).data?.find((n) => n.connection === i.channel)?.label ?? i.channel;
  return (
    <span className="flex w-full min-w-0 flex-col gap-0.5 text-left">
      <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
        <Icon className="size-3.5 shrink-0" aria-hidden />
        <span className="flex min-w-0 flex-1 gap-1 truncate">
          <span>{kindLabel(i)}</span>
          {[i.groupLabel, channel?.toLowerCase() === kindLabel(i).toLowerCase() ? null : channel].filter(Boolean).map((w) => (
            <span key={w}>{`· ${w}`}</span>
          ))}
        </span>
        {i.at && <span className="tabular-nums">{listTime(new Date(i.at))}</span>}
      </span>
      <span className="font-medium wrap-break-word text-foreground">{i.title}</span>
      {/* One warning says itself; more say how many, and the open Item lists them. */}
      {i.warnings.length === 1 ? <span className="text-xs font-medium text-warning">{i.warnings[0]!.text}</span> : <WarningCount count={i.warnings.length} />}
      {i.state !== "needs_approval" && (
        <span>
          <StateChip state={i.state} reason={i.reason} />
        </span>
      )}
    </span>
  );
}

/** "Approved N." after a bulk approve. They leave the queue, so the toast keeps Don't send for all of them (members who may edit). */
export function approvedToast(workspaceId: string, ids: string[], mayStop: boolean, after: () => Promise<unknown>) {
  if (ids.length === 0) return;
  const stop = async () => {
    const stopped = await cancelAll(workspaceId, ids);
    const late = ids.length - stopped;
    toast.add({ title: late === 0 ? `Not sent. ${stopped === 1 ? "It won't" : "They won't"} go out.` : `Stopped ${stopped}. ${late} had already gone out or moved on.` });
    await after();
  };
  toast.add({ title: `Approved ${ids.length}.`, ...(mayStop && { actionProps: { children: "Don't send", onClick: () => void stop() } }) });
}
