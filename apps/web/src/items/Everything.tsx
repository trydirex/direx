// SPDX-License-Identifier: AGPL-3.0-only
// Everything: every Item in the Workspace in every state, newest first, 100 at a time. The filters
// and the open Item live in the address, so a filtered view can be linked. Ticked rows can be approved
// (the clean ones that need approval) or withdrawn together; the open Item keeps its own actions.
import { useEffect, useRef, useState, type ComponentProps, type ComponentType } from "react";
import { useInfiniteQuery, useQuery, useQueryClient } from "@tanstack/react-query";
import { Dialog, DialogHeader } from "@astryxdesign/core/Dialog";
import { MultiSelector } from "@astryxdesign/core/MultiSelector";
import { Button } from "@/components/Button";
import { toast } from "@/components/toast";
import { inWorkspace } from "../api/query";
import { Input, Select } from "../components/Input";
import { EmptyState, Notice, Page } from "../components/layout";
import { QueryBoundary } from "../components/QueryBoundary";
import { campaignsQuery } from "../campaigns/actions";
import { networksQuery } from "../social/actions";
import { approveClean, BULK, cancel, everythingQuery, ITEM_MESSAGES, mayApprove, mayEdit, mayWithdraw, message, STATE_LABEL, TYPES, type ItemState, type ListFilters, type Role } from "./actions";
import type { ItemDialog } from "./ItemPanel";
import { ApproveList, approvedToast, QueueRow } from "./QueueRow";

const ALL = "";
const STATES = (Object.entries(STATE_LABEL) as [ItemState, string][]).map(([value, label]) => ({ value, label }));
const listOf = (s: string | undefined) => (s ? s.split(",") : []);
const joined = (v: string[]) => (v.length ? v.join(",") : undefined);

export function Everything(p: {
  workspaceId: string;
  role: Role;
  ItemView: ComponentType<ComponentProps<typeof ItemDialog>>;
  filters: ListFilters;
  /** Called with the filters that changed; the route keeps them in the address. */
  onFilters: (f: ListFilters) => void;
  /** The open Item, if any. */
  item?: string | undefined;
  onItem: (id: string | undefined) => void;
}) {
  const f = p.filters;
  const query = useInfiniteQuery(everythingQuery(p.workspaceId, f));
  const campaigns = useQuery(campaignsQuery(p.workspaceId)).data ?? [];
  const networks = useQuery(networksQuery(p.workspaceId)).data ?? [];

  // Words wait 300 ms after the last key, so each key doesn't read the list again.
  const [words, setWords] = useState(f.q ?? "");
  const wait = useRef<ReturnType<typeof setTimeout>>(undefined);
  useEffect(() => () => clearTimeout(wait.current), []);
  const type = (text: string) => {
    setWords(text);
    clearTimeout(wait.current);
    wait.current = setTimeout(() => p.onFilters({ q: text.trim() || undefined }), 300);
  };
  // Back, a link or Clear filters can change the words from outside; the box follows.
  const [shownQ, setShownQ] = useState(f.q);
  if (f.q !== shownQ) {
    clearTimeout(wait.current);
    setShownQ(f.q);
    if ((f.q ?? "") !== words.trim()) setWords(f.q ?? "");
  }

  const filtered = Boolean(f.state || f.channel || f.type || f.campaign || f.q);
  const clear = () => {
    clearTimeout(wait.current);
    setWords("");
    p.onFilters({ state: undefined, channel: undefined, type: undefined, campaign: undefined, q: undefined });
  };
  const channels = [{ value: "email", label: "Email" }, ...networks.map((n) => ({ value: n.connection, label: n.label }))];
  const types = TYPES.map(([label, keys]) => ({ value: keys.join(","), label }));
  // A type's keys travel as one comma list, so the picker shows each type whose keys are all chosen.
  const chosenTypes = types.filter((t) => listOf(t.value).every((k) => listOf(f.type).includes(k))).map((t) => t.value);

  const client = useQueryClient();
  const approver = mayApprove(p.role);
  const editor = mayEdit(p.role);
  const items = query.data?.pages.flatMap((page) => page.items) ?? [];
  // Ticked ids. Every count comes from the loaded rows, so a row a filter hides drops out of them.
  const [chosen, setChosen] = useState<string[]>([]);
  // Once a filter's rows have loaded, ticks on rows it hides are dropped, so clearing it doesn't bring them back.
  const kept = query.isSuccess ? chosen.filter((id) => items.some((i) => i.id === id)) : chosen;
  if (kept.length !== chosen.length) setChosen(kept);
  const ticked = items.filter((i) => chosen.includes(i.id));
  const approvable = approver ? ticked.filter((i) => i.state === "needs_approval" && i.clean) : [];
  // The same rule as the open Item's "Don't send": a reply or a plan change needs its own answer.
  const withdrawable = editor ? ticked.filter(mayWithdraw) : [];
  const firstShown = items.slice(0, BULK).map((i) => i.id);
  const allShown = firstShown.length > 0 && firstShown.every((id) => chosen.includes(id));
  const tick = (id: string, on: boolean) => setChosen(on ? (chosen.length < BULK ? [...chosen, id] : chosen) : chosen.filter((c) => c !== id));
  // While a confirm's request runs, its dialog can't be closed, so the cleanup after it can't clear a newer selection.
  const [confirming, setConfirming] = useState<"approve" | "withdraw">();
  const [pending, setPending] = useState(false);
  const [refused, setRefused] = useState<string>();
  const refresh = () => client.invalidateQueries({ queryKey: inWorkspace(p.workspaceId) });
  async function act() {
    setPending(true);
    try {
      if (confirming === "approve") {
        try {
          const r = await approveClean(p.workspaceId, approvable);
          // An error answer comes back as no results at all, rather than as a throw.
          if (r.ids.length === 0 && r.refused.length === 0) throw new Error("no results");
          approvedToast(p.workspaceId, r.ids, editor, refresh);
          setRefused(r.refused.length > 0 ? `${r.refused.length} didn't go through: ${message(r.refused[0]!.reason)}` : undefined);
        } catch {
          setRefused("Couldn't confirm the approvals. Check the refreshed list before trying again.");
        }
      } else {
        // Wait for every request, even if one loses its connection, before reading the list again.
        const results = await Promise.allSettled(withdrawable.map((i) => cancel(p.workspaceId, i.id)));
        const done = results.filter((r) => r.status === "fulfilled" && r.value === null).length;
        const failed = results.filter((r) => r.status === "rejected").length;
        const late = results.length - done - failed;
        if (done > 0) toast.add({ title: `Withdrew ${done}.` });
        setRefused([
          late > 0 ? `${late} couldn't be withdrawn. They may have gone out already.` : "",
          failed > 0 ? `Couldn't confirm ${failed} withdrawal${failed === 1 ? "" : "s"}. Check the refreshed list before trying again.` : "",
        ].filter(Boolean).join(" ") || undefined);
      }
      setChosen([]);
      await refresh();
    } finally {
      setPending(false);
      setConfirming(undefined);
    }
  }

  return (
    <Page title="Everything" description="Every email, post and approval in this Workspace, newest first.">
      <fieldset className="flex flex-wrap items-end gap-2">
        <legend className="sr-only">Filter</legend>
        <MultiSelector label="State" isLabelHidden options={STATES} value={listOf(f.state)} onChange={(v: string[]) => p.onFilters({ state: joined(v) })} hasClear placeholder="Any state" />
        <MultiSelector label="Channel" isLabelHidden options={channels} value={listOf(f.channel)} onChange={(v: string[]) => p.onFilters({ channel: joined(v) })} hasClear placeholder="Any channel" />
        <MultiSelector label="Type" isLabelHidden options={types} value={chosenTypes} onChange={(v: string[]) => p.onFilters({ type: joined(v.flatMap(listOf)) })} hasClear placeholder="Any type" />
        {campaigns.length > 0 && (
          <Select aria-label="Campaign" value={f.campaign ?? ALL} onChange={(e) => p.onFilters({ campaign: e.target.value || undefined })}>
            <option value={ALL}>All campaigns</option>
            {campaigns.map((c) => (
              <option key={c.id} value={c.id}>{c.title}</option>
            ))}
          </Select>
        )}
        <Input type="search" aria-label="Search titles and campaigns" placeholder="Search titles and campaigns" maxLength={100} hint="Up to 100 characters" value={words} onChange={(e) => type(e.target.value)} />
        {filtered && (
          <Button variant="ghost" size="sm" onClick={clear}>
            Clear filters
          </Button>
        )}
      </fieldset>
      <Dialog isOpen={confirming === "approve"} onOpenChange={(open) => !open && !pending && setConfirming(undefined)} purpose="form" width={448}>
        <DialogHeader title={`Approve ${approvable.length}?`} />
        <ApproveList items={approvable} />
        <div className="flex justify-end gap-2 pt-4">
          <Button variant="outline" disabled={pending} onClick={() => setConfirming(undefined)}>
            Cancel
          </Button>
          <Button pending={pending} onClick={() => void act()}>{`Approve ${approvable.length}`}</Button>
        </div>
      </Dialog>
      <Dialog isOpen={confirming === "withdraw"} onOpenChange={(open) => !open && !pending && setConfirming(undefined)} purpose="form" width={448}>
        <DialogHeader title={`Withdraw ${withdrawable.length}?`} />
        <p className="pt-2 text-sm">They won't go out, and they show as Cancelled.</p>
        <ul aria-label="To withdraw" className="flex max-h-80 flex-col gap-1 overflow-y-auto pt-2 text-sm">
          {withdrawable.map((i) => (
            <li key={i.id} className="truncate">
              {i.title}
            </li>
          ))}
        </ul>
        <div className="flex justify-end gap-2 pt-4">
          <Button variant="outline" disabled={pending} onClick={() => setConfirming(undefined)}>
            Keep them
          </Button>
          <Button pending={pending} onClick={() => void act()}>{`Withdraw ${withdrawable.length}`}</Button>
        </div>
      </Dialog>
      {refused && <Notice tone="error">{refused}</Notice>}
      <QueryBoundary query={query} messages={ITEM_MESSAGES}>
        {() => {
          if (items.length === 0)
            return filtered ? (
              <EmptyState title="Nothing matches these filters" action={<Button variant="outline" onClick={clear}>Clear filters</Button>} />
            ) : (
              <EmptyState title="Nothing here yet">Emails, posts and approvals show here as they're made.</EmptyState>
            );
          return (
            <>
              <div className="rounded-card border border-border bg-card">
                {/* Stays at the top while the list scrolls, so the bulk actions are always in reach. */}
                <div className="sticky top-0 z-10 flex min-h-12 flex-wrap items-center gap-x-4 gap-y-2 rounded-t-card border-b border-border bg-card px-4 py-2">
                  {(approver || editor) && (
                    <label className="flex min-h-8 cursor-pointer items-center gap-3 text-sm font-medium">
                      <input type="checkbox" className="size-4 accent-primary" checked={allShown} onChange={(e) => setChosen(e.target.checked ? firstShown : [])} />
                      Select all shown
                    </label>
                  )}
                  <span aria-live="polite" className="text-sm text-muted-foreground tabular-nums">
                    {ticked.length > 0 ? `${ticked.length} selected` : `${items.length}${query.hasNextPage ? "+" : ""} shown`}
                  </span>
                  {ticked.length > 0 && (
                    <span className="ml-auto flex flex-wrap gap-2">
                      <Button size="sm" variant="ghost" onClick={() => setChosen([])}>
                        Clear selection
                      </Button>
                      {withdrawable.length > 0 && (
                        <Button size="sm" variant="outline" onClick={() => setConfirming("withdraw")}>
                          {`Withdraw ${withdrawable.length}`}
                        </Button>
                      )}
                      {approvable.length > 0 && (
                        <Button size="sm" onClick={() => setConfirming("approve")}>
                          {`Approve ${approvable.length}`}
                        </Button>
                      )}
                    </span>
                  )}
                </div>
                <ul aria-label="Everything" className="flex flex-col divide-y divide-border">
                  {items.map((i) => {
                    const on = chosen.includes(i.id);
                    const open = i.id === p.item;
                    return (
                      // The open or ticked row takes the clay tint; any other row warms to linen under the pointer.
                      <li key={i.id} className={`flex items-stretch transition-colors duration-150 last:rounded-b-card ${open || on ? "bg-primary-tint" : "hover:bg-accent"}`}>
                        {(approver || editor) && (
                          // The whole left strip ticks the row, so the target is the row's height, not the 16px box.
                          <label className="flex shrink-0 cursor-pointer items-start pt-3.5 pr-1 pl-4">
                            <input
                              type="checkbox"
                              className="size-4 accent-primary"
                              aria-label={`Select ${i.title}`}
                              checked={on}
                              disabled={!on && chosen.length >= BULK}
                              onChange={(e) => tick(i.id, e.target.checked)}
                            />
                          </label>
                        )}
                        <button
                          type="button"
                          className="flex min-h-0 min-w-0 flex-1 cursor-pointer rounded-none border-0 bg-transparent px-4 py-3 text-left font-normal focus-visible:-outline-offset-2"
                          aria-current={open || undefined}
                          onClick={() => p.onItem(i.id)}
                        >
                          <QueueRow item={i} workspaceId={p.workspaceId} wide />
                        </button>
                      </li>
                    );
                  })}
                </ul>
              </div>
              {query.hasNextPage && (
                <Button variant="outline" className="self-start" pending={query.isFetchingNextPage} onClick={() => void query.fetchNextPage()}>
                  Show more
                </Button>
              )}
            </>
          );
        }}
      </QueryBoundary>
      <p.ItemView workspaceId={p.workspaceId} id={p.item} role={p.role} onClose={() => p.onItem(undefined)} />
    </Page>
  );
}
