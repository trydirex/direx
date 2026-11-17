// SPDX-License-Identifier: AGPL-3.0-only
import { useState, type ReactNode } from "react";
import { Button } from "@/components/Button";
import { Input } from "@/components/Input";

/** How many rows show before "Show more", so a list of thousands stays quick. */
export const PAGE = 100;

/**
 * A long list a person needs to find things in: a count for each filter, which doubles as the
 * filter, a search box, and rows a page at a time. Each row is the caller's own block, so it reads
 * the same on a phone as on a wide screen.
 */
export function FilterList<T>(p: {
  /** The plural noun, as in "1,240 People". */
  noun: string;
  /** The list's name for a screen reader, when the noun alone says less. */
  label?: string;
  items: T[];
  id: (t: T) => string;
  /** What the search box matches, lower-cased. */
  text: (t: T) => string;
  filters?: { label: string; test: (t: T) => boolean }[];
  children: (t: T) => ReactNode;
}) {
  const [filter, setFilter] = useState<string>();
  const [search, setSearch] = useState("");
  const [shown, setShown] = useState(PAGE);
  const active = p.filters?.find((f) => f.label === filter);
  const words = search.trim().toLowerCase();
  const rows = p.items.filter((t) => (!active || active.test(t)) && (!words || p.text(t).toLowerCase().includes(words)));
  const count = (n: number) => n.toLocaleString();
  const chip = (label: string, n: number, on: boolean, pick: () => void) => (
    <Button key={label} size="sm" variant={on ? "default" : "outline"} aria-pressed={on} onClick={pick}>
      {`${label} ${count(n)}`}
    </Button>
  );

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2">
        {p.filters && p.filters.length > 0 && (
          <div role="group" aria-label={`Filter ${p.noun}`} className="flex flex-wrap gap-2">
            {chip("All", p.items.length, !active, () => setFilter(undefined))}
            {p.filters.map((f) => chip(f.label, p.items.filter(f.test).length, f.label === filter, () => setFilter(f.label === filter ? undefined : f.label)))}
          </div>
        )}
        <Input type="search" aria-label={`Search ${p.noun}`} placeholder="Search" className="min-w-48 flex-1" value={search} onChange={(e) => setSearch(e.target.value)} />
      </div>
      <p role="status" className="text-sm text-muted-foreground">
        {rows.length === p.items.length ? `${count(rows.length)} ${p.noun}` : `${count(rows.length)} of ${count(p.items.length)} ${p.noun}`}
      </p>
      {rows.length === 0 ? (
        <p className="text-muted-foreground">{`No ${p.noun} match.`}</p>
      ) : (
        <ul aria-label={p.label ?? p.noun} className="flex flex-col divide-y divide-border">
          {rows.slice(0, shown).map((t) => (
            <li key={p.id(t)} className="flex flex-col gap-2 py-3 first:pt-0 last:pb-0">
              {p.children(t)}
            </li>
          ))}
        </ul>
      )}
      {rows.length > shown && (
        <Button variant="outline" size="sm" className="self-start" onClick={() => setShown(shown + PAGE)}>
          {`Show ${count(Math.min(PAGE, rows.length - shown))} more`}
        </Button>
      )}
    </div>
  );
}
