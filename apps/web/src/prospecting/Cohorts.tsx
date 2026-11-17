// SPDX-License-Identifier: AGPL-3.0-only
// Cohorts (segments on screen): saved filters over the addresses people kept, and handing who matches
// now to a Campaign. Names, roles and pages came from companies' own sites, so they are shown as text,
// and a page address becomes a link only when it is a web address.
import { useEffect, useState } from "react";
import { useQueries, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate, useRouterState } from "@tanstack/react-router";
import { ApiError, inWorkspace } from "../api/query";
import type { Listed } from "../campaigns/actions";
import { EmptyState, Field, Notice, Page, Section } from "../components/layout";
import { QueryBoundary } from "../components/QueryBoundary";
import { Button, buttonVariants } from "@/components/Button";
import { Input, Select } from "@/components/Input";
import { Dialog, DialogHeader } from "@astryxdesign/core/Dialog";
import { Skeleton } from "@astryxdesign/core/Skeleton";
import { MultiSelector } from "@astryxdesign/core/MultiSelector";
import { Table, TableBody, TableCell, TableHeader, TableHeaderCell, TableRow } from "@astryxdesign/core/Table";
import { COUNTRIES, countryName } from "../outreach/countries";
import { Stats } from "./Run";
import { mayEdit, type Role } from "../items/actions";
import { PageLink } from "./CompanyReview";
import {
  addPreviewQuery,
  addToCampaign,
  campaignChoicesQuery,
  COHORT_CHOICES,
  cohortCountQuery,
  cohortQuery,
  cohortsQuery,
  countCohort,
  filterChips,
  handoverQuery,
  handoverWords,
  KIND_WORDS,
  loadCohort,
  loadHandover,
  newFilter,
  NOT_TAKING,
  presetRuns,
  runsQuery,
  saveCohort,
  sayCohort,
  searchName,
  SIGNAL_WORDS,
  skipWords,
  SOURCE_WORDS,
  VERIFY_WORDS,
  verifyWords,
  whileRunning,
  type Cohort,
  type CohortFilter,
  type CohortPage,
  type Handover as HandoverData,
} from "./actions";

const QUALITY = { kinds: "Address kind", sources: "Source", verification: "Check result" } as const;
const WORDS: Record<keyof typeof COHORT_CHOICES, Record<string, string>> = { signals: SIGNAL_WORDS, kinds: KIND_WORDS, sources: SOURCE_WORDS, verification: VERIFY_WORDS };
const link = "underline underline-offset-4";
const COUNTRY_OPTIONS = COUNTRIES.map((c) => ({ value: c.code, label: c.name }));
const people = (n: number) => (n === 1 ? "1 Person" : `${n.toLocaleString("en-US")} People`);
const chipClass = "rounded-full bg-muted px-3 py-1 text-sm";
/** How long the builder waits after a change before it counts again. */
export const COUNT_AFTER_MS = 400;

/**
 * Whether an address can be written to, from what its row carries: its check, and the rule that a guessed
 * address in Canada never goes over. The Do not contact list and earlier contact show in the add preview.
 */
function canEmail(m: CohortPage["members"][number]): string {
  if (m.source === "guessed" && m.company.country === "CA") return "No, a guessed address in Canada";
  if (m.verificationResult === null) return "Not checked yet";
  if (m.verificationResult === "deliverable") return "Yes";
  if (m.verificationResult === "invalid") return "Not deliverable";
  if (m.verificationResult === "unknown") return "Couldn't be checked";
  return "Can't tell";
}

/** The value once it has stopped changing for a moment. */
function useSettled(value: string, ms: number): string {
  const [settled, setSettled] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setSettled(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return settled;
}

/** Ticks for one list in the filter. Nothing ticked matches any. */
function Ticks<F extends keyof typeof COHORT_CHOICES>(p: { field: F; legend: string; filter: CohortFilter; onChange: (values: string[]) => void }) {
  const chosen: readonly string[] = p.filter[p.field];
  return (
    <fieldset className="flex flex-wrap items-center gap-x-4 gap-y-2">
      <legend className="sr-only">{p.legend}</legend>
      {COHORT_CHOICES[p.field].map((v: string) => (
        <label key={v} className="flex min-h-9 items-center gap-2">
          <input type="checkbox" className="accent-primary" checked={chosen.includes(v)} onChange={(e) => p.onChange(e.target.checked ? [...chosen, v] : chosen.filter((x) => x !== v))} /> {WORDS[p.field][v]}
        </label>
      ))}
    </fieldset>
  );
}

/** One condition of the sentence: what it is about, then its choices. */
function Condition(p: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-2 border-t border-border pt-3 sm:flex-row sm:items-start sm:gap-4">
      <span className="min-w-36 pt-2 text-sm font-medium">{p.label}</span>
      <div className="flex flex-1 flex-col gap-2">{p.children}</div>
    </div>
  );
}

/**
 * The filter as a sentence: People who work at a kept company where each condition holds. Ticks in one
 * condition are alternatives. The count updates as the filter changes, and the save button says it.
 */
function FilterForm(p: { workspaceId: string; cohort?: Cohort; runs?: string[]; onSaved: (c: Cohort) => void; onCancel?: () => void }) {
  const [note, setNote] = useState<string>();
  const [pending, setPending] = useState(false);
  const [name, setName] = useState(p.cohort?.name ?? "");
  const [filter, setFilter] = useState<CohortFilter>(p.cohort?.filter ?? newFilter(p.runs));
  const [days, setDays] = useState(filter.signalMaxAgeDays === undefined ? "" : String(filter.signalMaxAgeDays));
  const searches = useQuery(runsQuery(p.workspaceId)).data ?? [];
  // A search older than the latest 20 can still be in the filter, so it stays a choice.
  const searchOptions = [...searches.map((r) => ({ value: r.id, label: searchName(r) })), ...filter.runs.filter((id) => !searches.some((r) => r.id === id)).map((id) => ({ value: id, label: "An earlier search" }))];
  const sent: CohortFilter = { ...filter, ...(days.trim() ? { signalMaxAgeDays: Number(days) } : { signalMaxAgeDays: undefined }) };
  // Compared as text, since `sent` is a new object on every render.
  const settled = useSettled(JSON.stringify(sent), COUNT_AFTER_MS);
  const counted = useQuery({ ...cohortCountQuery(p.workspaceId, JSON.parse(settled) as CohortFilter), retry: false });
  // A count of 0 with a check filter is often addresses not checked yet, so say how many those are.
  const settledFilter = JSON.parse(settled) as CohortFilter;
  const unchecked = useQuery({
    ...cohortCountQuery(p.workspaceId, { ...settledFilter, verification: [] }),
    retry: false,
    enabled: counted.data === 0 && settledFilter.verification.length > 0,
  });
  const set = (field: keyof CohortFilter) => (values: string[]) => setFilter({ ...filter, [field]: values });
  const or = (field: keyof typeof QUALITY, any: string) => (filter[field].length ? filter[field].map((v) => WORDS[field][v] ?? v).join(" or ") : any);
  const checkedOnly = filter.verification.length === 1 && filter.verification[0] === "deliverable";
  const quality = [checkedOnly ? "checked addresses only" : or("verification", "any check result"), or("kinds", "named people and role addresses"), or("sources", "any source")];

  async function submit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setPending(true);
    const r = await saveCohort(p.workspaceId, { name: name.trim(), filter: sent }, p.cohort?.id).finally(() => setPending(false));
    if (!r.ok) return setNote(sayCohort(r.error, r.field));
    setNote(undefined);
    p.onSaved(r.cohort);
  }

  const count = counted.data;
  return (
    <form onSubmit={submit} aria-label={p.cohort ? "Change this segment" : "New segment"} className="flex flex-col gap-4">
      <Field label="Name">
        <Input name="name" required maxLength={200} value={name} onChange={(e) => setName(e.target.value)} />
      </Field>
      <p className="font-medium">People who work at a kept company where</p>
      <Condition label="Signal is">
        <Ticks field="signals" legend="Signals" filter={filter} onChange={set("signals")} />
        <div className="max-w-56">
          <Input type="number" label="Read in the last (days)" hint="Leave empty for any age" min={1} max={3650} step={1} value={days} onChange={(e) => setDays(e.target.value)} />
        </div>
      </Condition>
      <Condition label="Country is any of">
        <MultiSelector label="Countries" isLabelHidden options={COUNTRY_OPTIONS} value={filter.countries} onChange={set("countries")} hasSearch hasClear placeholder="Any country" />
      </Condition>
      <Condition label="Found by search">
        <MultiSelector label="Searches" isLabelHidden options={searchOptions} value={filter.runs} onChange={set("runs")} hasClear placeholder="Any search" />
      </Condition>
      <details className="border-t border-border pt-3">
        <summary className="cursor-pointer text-sm">
          <span className="font-medium">Address quality</span> <span className="text-muted-foreground">{quality.join(" · ")}</span>
        </summary>
        <div className="mt-3 flex flex-col gap-3">
          {(Object.keys(QUALITY) as (keyof typeof QUALITY)[]).map((field) => (
            <Condition key={field} label={QUALITY[field]}>
              <Ticks field={field} legend={QUALITY[field]} filter={filter} onChange={set(field)} />
            </Condition>
          ))}
        </div>
      </details>
      <p className="text-sm text-muted-foreground">Leave a condition empty to match any. A segment is a saved filter, so it grows as you keep more companies.</p>
      {note && <Notice tone="error">{note}</Notice>}
      <p role="status" className="text-sm">
        {counted.isError ? "We couldn't count this filter. Check the days, then try again." : count === undefined ? "Counting…" : `${people(count)} match now.`}
        {count === 0 && !!unchecked.data && ` ${people(unchecked.data)} would match without the check filter: their addresses aren't checked yet, or didn't pass. Change Address quality to include them.`}
      </p>
      <div className="flex flex-wrap gap-2">
        <Button type="submit" pending={pending}>
          {count === undefined ? "Save segment" : `Save segment of ${people(count)}`}
        </Button>
        {p.onCancel && (
          <Button type="button" variant="outline" onClick={p.onCancel}>
            Cancel
          </Button>
        )}
      </div>
    </form>
  );
}

/** Who a segment matches, one row each, with a search over address, name and company. */
function Members({ members }: { members: CohortPage["members"] }) {
  const [search, setSearch] = useState("");
  const words = search.trim().toLowerCase();
  const rows = words ? members.filter((m) => `${m.email} ${m.name ?? ""} ${m.company.name ?? ""} ${m.company.domain}`.toLowerCase().includes(words)) : members;
  return (
    <div className="flex flex-col gap-3">
      <Input type="search" aria-label="Search addresses" placeholder="Search" className="min-w-48" value={search} onChange={(e) => setSearch(e.target.value)} />
      <p role="status" className="text-sm text-muted-foreground">
        {rows.length === members.length ? `${members.length.toLocaleString()} addresses` : `${rows.length.toLocaleString()} of ${members.length.toLocaleString()} addresses`}
      </p>
      <div className="overflow-x-auto">
        <Table aria-label="Who it matches">
          <TableHeader>
            <TableRow>
              <TableHeaderCell>Email</TableHeaderCell>
              <TableHeaderCell>Person</TableHeaderCell>
              <TableHeaderCell>Company</TableHeaderCell>
              <TableHeaderCell>Checked</TableHeaderCell>
              <TableHeaderCell>Can email?</TableHeaderCell>
              <TableHeaderCell>Source</TableHeaderCell>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((m) => (
              <TableRow key={m.addressId}>
                <TableCell className="whitespace-normal wrap-break-word">
                  <div className="flex flex-col">
                    <span className="font-medium">{m.email}</span>
                    <span className="text-sm text-muted-foreground">
                      {`${KIND_WORDS[m.kind] ?? m.kind}${m.source === "guessed" ? ", guessed" : ""}`}
                    </span>
                  </div>
                </TableCell>
                <TableCell className="whitespace-normal">{m.name ? `${m.name}${m.role ? ` (${m.role})` : ""}` : <span className="text-muted-foreground">Not named</span>}</TableCell>
                <TableCell className="whitespace-normal">{`${m.company.name ?? m.company.domain}, ${m.company.country ?? "country not known"}`}</TableCell>
                <TableCell className="whitespace-normal">{verifyWords(m)}</TableCell>
                <TableCell className="whitespace-normal">{canEmail(m)}</TableCell>
                <TableCell>
                  <PageLink url={m.evidence.pageUrl}>Where it was found</PageLink>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
    </div>
  );
}

/** A filter as a row of chips, one per condition. */
function Chips({ filter }: { filter: CohortFilter }) {
  return (
    <ul aria-label="Who it picks" className="flex flex-wrap gap-2">
      {filterChips(filter, countryName).map((c) => (
        <li key={c} className={chipClass}>
          {c}
        </li>
      ))}
    </ul>
  );
}

/** The Workspace's cohorts and a form for a new one, or one cohort when an id is given. */
export function Cohorts(p: { workspaceId: string; role: Role; id?: string; initial?: { cohorts?: Cohort[]; cohort?: CohortPage; campaigns?: Listed[] } }) {
  if (p.id) return <OneCohort workspaceId={p.workspaceId} role={p.role} id={p.id} initial={p.initial?.cohort} campaigns={p.initial?.campaigns} />;
  return <AllCohorts workspaceId={p.workspaceId} role={p.role} initial={p.initial?.cohorts} />;
}

function AllCohorts(p: { workspaceId: string; role: Role; initial?: Cohort[] }) {
  const { workspaceId } = p;
  const navigate = useNavigate();
  // A link from a search's page can name searches for a new segment to start from (see presetRuns).
  const runs = presetRuns(useRouterState({ select: (s) => s.location.searchStr }));
  const cohorts = useQuery({ ...cohortsQuery(workspaceId), initialData: p.initial });
  // Each segment's size now, from the same count the builder uses; a failed count just shows no size.
  const sizes = useQueries({
    queries: (cohorts.data ?? []).map((c) => ({
      queryKey: inWorkspace(workspaceId, "prospecting", "cohorts", c.id, "count"),
      queryFn: async () => {
        const r = await countCohort(workspaceId, c.filter);
        return r.ok ? r.count : null;
      },
    })),
  });
  const editing = mayEdit(p.role);
  // Arriving from a search's "Make a segment", the builder is already open and set to that search.
  const [building, setBuilding] = useState(runs.length > 0);
  const newButton = editing && !building && <Button onClick={() => setBuilding(true)}>New segment</Button>;
  return (
    <Page
      title="Segments"
      actions={newButton}
      description={
        <>
          A segment picks out the People at companies you kept, by Signal, country and search. Add one to a Campaign to write to who it matches.{" "}
          <Link to="/w/$workspaceId/people/find" params={{ workspaceId }} className={link}>
            Find companies
          </Link>
        </>
      }
    >
      {!editing && <p className="text-muted-foreground">Viewers can see segments but not change them. Ask an Owner or Admin for a different role.</p>}
      {building && (
        <Section title="New segment">
          <FilterForm workspaceId={workspaceId} runs={runs} onCancel={() => setBuilding(false)} onSaved={(c) => void navigate({ to: "/w/$workspaceId/people/cohorts/$cohortId", params: { workspaceId, cohortId: c.id } })} />
        </Section>
      )}
      <QueryBoundary query={cohorts} skeleton={<Skeleton className="h-24 w-full" />}>
        {(list) =>
          list.length === 0 ? (
            <EmptyState
              title="No segments yet"
              action={
                <div className="flex flex-wrap gap-2">
                  {newButton}
                  <Link to="/w/$workspaceId/people/find" params={{ workspaceId }} className={buttonVariants({ variant: newButton ? "outline" : "default" })}>
                    Find companies
                  </Link>
                </div>
              }
            >
              A segment is a saved filter, like &apos;Hiring firms in the UK&apos;. It grows as you keep companies.
            </EmptyState>
          ) : (
            <ul className="flex flex-col divide-y divide-border rounded-card border border-border bg-card">
              {list.map((c, i) => {
                const size = sizes[i]?.data;
                return (
                  <li key={c.id} className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 p-4">
                    <span className="flex flex-col gap-1">
                      <Link to="/w/$workspaceId/people/cohorts/$cohortId" params={{ workspaceId, cohortId: c.id }} className={`${link} font-medium`}>
                        {c.name}
                      </Link>
                      <span className="text-sm text-muted-foreground">{filterChips(c.filter, countryName).join(" · ")}</span>
                    </span>
                    {typeof size === "number" && <span className="text-sm tabular-nums">{people(size)}</span>}
                  </li>
                );
              })}
            </ul>
          )
        }
      </QueryBoundary>
    </Page>
  );
}

function OneCohort(p: { workspaceId: string; role: Role; id: string; initial?: CohortPage; campaigns?: Listed[] }) {
  const { workspaceId } = p;
  const editing = mayEdit(p.role);
  const client = useQueryClient();
  const navigate = useNavigate();
  const cohort = useQuery({ ...cohortQuery(workspaceId, p.id), initialData: p.initial });
  const campaigns = useQuery({ ...campaignChoicesQuery(workspaceId), initialData: p.campaigns, enabled: editing });
  const [campaignId, setCampaignId] = useState("");
  // What adding would do, read once a Campaign is chosen and before the button is pressed.
  const preview = useQuery({ ...addPreviewQuery(workspaceId, p.id, campaignId), enabled: editing && !!campaignId });
  const [note, setNote] = useState<string>();
  const [adding, setAdding] = useState(false);
  const [open, setOpen] = useState(false);
  // Pages after the first, read on Show more, as on a hand-over.
  const [more, setMore] = useState<{ members: CohortPage["members"]; next: string | null }>();
  const [loading, setLoading] = useState(false);

  async function add() {
    setAdding(true);
    const r = await addToCampaign(workspaceId, p.id, campaignId).finally(() => setAdding(false));
    if (!r.ok) return setNote(r.error === "not_found" ? NOT_TAKING : sayCohort(r.error));
    await navigate({ to: "/w/$workspaceId/people/handovers/$handoverId", params: { workspaceId, handoverId: r.handoverId } });
  }

  return (
    <QueryBoundary query={cohort} messages={{ not_found: "We couldn't find that segment." }} skeleton={<Skeleton className="h-96 w-full" />}>
      {(c) => {
        const list = campaigns.data ?? [];
        const chosen = list.find((x) => x.id === campaignId);
        const members = [...c.members, ...(more?.members ?? [])];
        const next = more ? more.next : c.next;
        const showMore = async () => {
          if (!next) return;
          setLoading(true);
          const r = await loadCohort(workspaceId, p.id, next).finally(() => setLoading(false));
          if (r) setMore({ members: [...(more?.members ?? []), ...r.members], next: r.next });
        };
        // The button promises what the preview says, never the segment's whole size.
        const addLabel = !chosen ? "Add to the Campaign" : preview.data ? `Add about ${people(preview.data.added)} to ${chosen.title}` : `Add to ${chosen.title}`;
        return (
          <Page
            title={c.name}
            actions={
              <>
                {editing && (
                  <>
                    <Button onClick={() => setOpen(true)}>Add to a Campaign</Button>
                    {/* A new Campaign can't take a segment yet, so this opens Campaigns; add the segment once its plan is approved. */}
                    <Link to="/w/$workspaceId/campaigns" params={{ workspaceId }} className={buttonVariants({ variant: "outline" })}>
                      Go to Campaigns
                    </Link>
                  </>
                )}
                <Link to="/w/$workspaceId/people/cohorts" params={{ workspaceId }} className={`${link} self-center`}>
                  All segments
                </Link>
              </>
            }
          >
            <Chips filter={c.filter} />
            <div role="status">
              <Stats
                label="This segment now"
                stats={[
                  ["People", c.count],
                  ["Checked deliverable", c.deliverable],
                  ["In a Campaign", c.inCampaign],
                ]}
              />
            </div>
            <Section title="Used by">
              {c.usedBy.length === 0 ? (
                <p className="text-muted-foreground">Not in a Campaign yet.</p>
              ) : (
                <ul className="flex flex-col divide-y divide-border">
                  {c.usedBy.map((u) => (
                    <li key={u.campaignId} className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 py-2">
                      <Link to="/w/$workspaceId/campaigns/$campaignId" params={{ workspaceId, campaignId: u.campaignId }} className={`${link} font-medium`}>
                        {u.title}
                      </Link>
                      <span className="text-sm text-muted-foreground tabular-nums">{`${people(u.people)} added, last on ${new Date(u.lastAddedAt).toLocaleDateString(undefined, { day: "numeric", month: "short" })}`}</span>
                    </li>
                  ))}
                </ul>
              )}
            </Section>
            {members.length > 0 && (
              <Section title={members.length < c.count ? `The first ${members.length}` : "Everyone it matches"}>
                <Members members={members} />
                {next && (
                  <div>
                    <Button variant="outline" pending={loading} onClick={() => void showMore()}>
                      Show more
                    </Button>
                  </div>
                )}
              </Section>
            )}

            {editing ? (
              <>
                <Dialog isOpen={open} onOpenChange={setOpen} purpose="form" width={448}>
                  <DialogHeader title="Add to a Campaign" />
                  <div className="flex flex-col gap-4">
                    {/* A list that can't be read says so, rather than reading as "No Campaign yet". */}
                    <QueryBoundary query={campaigns} skeleton={<Skeleton className="h-24 w-full" />}>
                    {(list) => list.length === 0 ? (
                      <EmptyState
                        title="No Campaign yet"
                        action={
                          <Link to="/w/$workspaceId/campaigns" params={{ workspaceId }} className={buttonVariants({ variant: "outline" })}>
                            Go to Campaigns
                          </Link>
                        }
                      >
                        There&apos;s no Campaign to add them to yet. Make one, then come back.
                      </EmptyState>
                    ) : (
                      <>
                        <Field label="Campaign">
                          <Select value={campaignId} onChange={(e) => setCampaignId(e.target.value)}>
                            <option value="">Choose a Campaign</option>
                            {list.map((x) => (
                              <option key={x.id} value={x.id}>
                                {x.title}
                              </option>
                            ))}
                          </Select>
                        </Field>
                        <p className="text-sm text-muted-foreground">Only addresses that check deliverable go over, and you&apos;ll see what happened to each one.</p>
                        {campaignId && <AddPreview query={preview} />}
                        {note && <Notice tone="error">{note}</Notice>}
                        <div className="flex justify-end gap-2 pt-4">
                          <Button variant="outline" onClick={() => setOpen(false)}>
                            Cancel
                          </Button>
                          <Button disabled={!chosen || preview.isPending || preview.data?.added === 0 || (preview.error instanceof ApiError && preview.error.status === 404)} pending={adding} onClick={() => void add()}>
                            {addLabel}
                          </Button>
                        </div>
                      </>
                    )}
                    </QueryBoundary>
                  </div>
                </Dialog>
                <Section title="Change this segment">
                  <FilterForm workspaceId={workspaceId} cohort={c} onSaved={() => void client.invalidateQueries({ queryKey: inWorkspace(workspaceId) })} />
                </Section>
              </>
            ) : (
              <p className="text-muted-foreground">Viewers can see segments but not change them or add them to a Campaign. Ask an Owner or Admin for a different role.</p>
            )}
          </Page>
        );
      }}
    </QueryBoundary>
  );
}

/** "About X would be added, Y left out", with the left-outs grouped by reason. */
function AddPreview({ query }: { query: { data?: { added: number; skipped: { reason: string; count: number }[] }; isPending: boolean; isError: boolean; error: unknown } }) {
  if (query.error instanceof ApiError && query.error.status === 404) return <Notice tone="error">{NOT_TAKING}</Notice>;
  if (query.isError) return <p className="text-sm text-muted-foreground">We couldn&apos;t work out how many would be added. You can still add them.</p>;
  if (!query.data) return <p role="status" className="text-sm text-muted-foreground">Working out who would be added…</p>;
  const skipped = query.data.skipped.reduce((n, s) => n + s.count, 0);
  return (
    <div role="status" className="flex flex-col gap-1">
      <p className="font-medium">{`About ${people(query.data.added)} would be added, ${skipped.toLocaleString("en-US")} left out.`}</p>
      {skipped > 0 && (
        <ul className="list-inside list-disc text-sm text-muted-foreground">
          {query.data.skipped.map((s) => (
            <li key={s.reason}>{skipWords(s)}</li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** A hand-over's progress and what happened to each address, a page at a time. */
export function Handover(p: { workspaceId: string; id: string; initial?: HandoverData }) {
  const { workspaceId } = p;
  // The hand-over runs in the background, so the screen checks again until it's done.
  const query = useQuery({ ...handoverQuery(workspaceId, p.id), initialData: p.initial, refetchInterval: whileRunning((d: HandoverData) => d.status) });
  // Pages after the first, read on Show more; the first page refreshes with each check.
  const [more, setMore] = useState<{ results: HandoverData["results"]; next: string | null }>();
  const [loading, setLoading] = useState(false);

  return (
    <QueryBoundary query={query} messages={{ not_found: "We couldn't find that hand-over." }} skeleton={<Skeleton className="h-96 w-full" />}>
      {(h) => {
        const n = h.counts;
        const results = [...h.results, ...(more?.results ?? [])];
        const handled = results.filter((r) => r.status !== "left_out");
        const leftOut = new Map<string, HandoverData["results"]>();
        for (const r of results) if (r.status === "left_out") leftOut.set(r.reason ?? "", [...(leftOut.get(r.reason ?? "") ?? []), r]);
        const firstConflict = results.find((r) => r.conflictItemId)?.conflictItemId;
        const next = more ? more.next : h.next;
        const showMore = async () => {
          if (!next) return;
          setLoading(true);
          const r = await loadHandover(workspaceId, p.id, next).finally(() => setLoading(false));
          if (r) setMore({ results: [...(more?.results ?? []), ...r.results], next: r.next });
        };
        return (
          <Page
            title={h.status === "running" ? `Adding ${h.cohortName} to ${h.campaignTitle}` : h.status === "failed" ? `Adding ${h.cohortName} to ${h.campaignTitle} stopped` : `Added ${h.cohortName} to ${h.campaignTitle}`}
            description={h.status === "running" ? "In progress. This page updates as Direx works through the segment." : undefined}
            actions={
              <>
                {n.conflict > 0 &&
                  (firstConflict ? (
                    <Link to="/w/$workspaceId/review/$itemId" params={{ workspaceId, itemId: firstConflict }} className={buttonVariants()}>
                      {n.conflict} need your decision
                    </Link>
                  ) : (
                    <Link to="/w/$workspaceId" params={{ workspaceId }} className={buttonVariants()}>
                      {n.conflict} need your decision
                    </Link>
                  ))}
                <Link to="/w/$workspaceId/people/cohorts/$cohortId" params={{ workspaceId, cohortId: h.cohortId }} className={link}>
                  Back to the segment
                </Link>
                <Link to="/w/$workspaceId/campaigns/$campaignId" params={{ workspaceId, campaignId: h.campaignId }} className={link}>
                  Open the Campaign
                </Link>
              </>
            }
          >
            {h.status === "failed" && (
              <p role="alert">
                It stopped before the end: {h.failureReason}. Everyone counted below was handed over. Start it again from the segment to carry on; anyone already in the Campaign is left as they are.
              </p>
            )}
            <div role="status">
              <Stats
                label="So far"
                stats={[
                  ["Added", n.added],
                  ["Already in Direx", n.joined],
                  ["Needs your decision", n.conflict],
                  ["Left out", n.leftOut],
                ]}
              />
            </div>
            {results.length === 0 ? (
              <EmptyState title="No addresses handled yet">Each address shows here as Direx adds it or leaves it out.</EmptyState>
            ) : (
              <>
                {handled.length > 0 && (
                  <ul aria-label="Each address" className="flex flex-col divide-y divide-border rounded-card border border-border bg-card">
                    {handled.map((r) => (
                      <li key={r.addressId} className="p-4 wrap-break-word">
                        {r.email}: {handoverWords(r)}
                        {r.conflictItemId && (
                          <>
                            {" "}
                            <Link to="/w/$workspaceId/review/$itemId" params={{ workspaceId, itemId: r.conflictItemId }} className={link}>
                              Decide
                            </Link>
                          </>
                        )}
                      </li>
                    ))}
                  </ul>
                )}
                {/* Left out, grouped by why, so one cause shows once with everyone it covered. */}
                {[...leftOut].map(([reason, group]) => (
                  <section key={reason} aria-label={handoverWords(group[0]!)} className="flex flex-col gap-2">
                    <h3 className="font-medium">
                      {handoverWords(group[0]!)} <span className="text-muted-foreground tabular-nums">({group.length})</span>
                    </h3>
                    <ul className="flex flex-col divide-y divide-border rounded-card border border-border bg-card">
                      {group.map((r) => (
                        <li key={r.addressId} className="p-4 wrap-break-word">
                          {r.email}
                        </li>
                      ))}
                    </ul>
                  </section>
                ))}
              </>
            )}
            {next && (
              <div>
                <Button variant="outline" pending={loading} onClick={() => void showMore()}>
                  Show more
                </Button>
              </div>
            )}
          </Page>
        );
      }}
    </QueryBoundary>
  );
}
