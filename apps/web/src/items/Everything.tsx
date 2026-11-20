// SPDX-License-Identifier: AGPL-3.0-only
// Everything: every Item in the Workspace in every state, newest first, 100 at a time. The filters
// and the open Item live in the address, so a filtered view can be linked. Read-only: the open Item
// keeps its own actions.
import { useEffect, useRef, useState, type ComponentProps, type ComponentType } from "react";
import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import { MultiSelector } from "@astryxdesign/core/MultiSelector";
import { Button } from "@/components/Button";
import { Input, Select } from "../components/Input";
import { EmptyState, Page } from "../components/layout";
import { QueryBoundary } from "../components/QueryBoundary";
import { campaignsQuery } from "../campaigns/actions";
import { networksQuery } from "../social/actions";
import { everythingQuery, ITEM_MESSAGES, listTime, STATE_LABEL, TYPES, type ItemState, type ListFilters, type Role } from "./actions";
import type { ItemDialog } from "./ItemPanel";
import { QueueRow } from "./QueueRow";
import { StateChip } from "./StateChip";

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
      <QueryBoundary query={query} messages={ITEM_MESSAGES}>
        {(data) => {
          const items = data.pages.flatMap((page) => page.items);
          if (items.length === 0)
            return filtered ? (
              <EmptyState title="Nothing matches these filters" action={<Button variant="outline" onClick={clear}>Clear filters</Button>} />
            ) : (
              <EmptyState title="Nothing here yet">Emails, posts and approvals show here as they're made.</EmptyState>
            );
          return (
            <>
              <ul aria-label="Everything" className="flex flex-col divide-y divide-border rounded-card border border-border bg-card">
                {items.map((i) => (
                  <li key={i.id}>
                    <button type="button" className="flex w-full cursor-pointer flex-col items-start gap-1 border-0 bg-transparent px-4 py-3 text-left hover:bg-accent" aria-current={i.id === p.item || undefined} onClick={() => p.onItem(i.id)}>
                      <QueueRow item={i} workspaceId={p.workspaceId} />
                      {/* QueueRow leaves Needs approval out, since its queue holds nothing else; here every state shows. */}
                      {i.state === "needs_approval" && <span><StateChip state={i.state} /></span>}
                      {!i.at && <span className="text-xs text-muted-foreground tabular-nums">{`Made ${listTime(new Date(i.createdAt))}`}</span>}
                    </button>
                  </li>
                ))}
              </ul>
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
