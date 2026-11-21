// SPDX-License-Identifier: AGPL-3.0-only
// Brand's Competitors section (Beta): the competitors the watch reads, the pages given for each one,
// and what Direx could read on each page when it was last checked. Anyone in the Workspace reads it;
// adding, editing, checking and removing need an Owner or Admin.
import { useEffect, useRef, useState, type FormEvent } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { inWorkspace } from "../api/query";
import { Confirm } from "../components/Confirm";
import { Field, Notice, Section } from "../components/layout";
import { QueryBoundary } from "../components/QueryBoundary";
import { useAction } from "../components/useAction";
import { Button } from "@/components/Button";
import { Input } from "@/components/Input";
import { Skeleton } from "@astryxdesign/core/Skeleton";
import type { Role } from "../items/actions";
import { factsQuery } from "./actions";
import {
  addCompetitor,
  changesQuery,
  changeWords,
  checkCompetitor,
  dismissProposal,
  checkWords,
  competitorsQuery,
  editCompetitor,
  findPages,
  findWords,
  foundWords,
  labelWords,
  MAX_COMPETITORS,
  proposalsQuery,
  proposalSource,
  readWords,
  removeCompetitor,
  scanProposals,
  searchCompetitors,
  type Check,
  type Competitor,
  type CompetitorFields,
  type Proposal,
  type Result,
} from "./competitors-actions";

/** Asks once for a scan of the Workspace's site when it has one that was never scanned. */
function useFirstScan(workspaceId: string, manage: boolean) {
  const client = useQueryClient();
  const { data } = useQuery(proposalsQuery(workspaceId));
  const asked = useRef(false);
  useEffect(() => {
    if (!manage || asked.current || !data?.site || data.scannedAt) return;
    asked.current = true;
    void scanProposals(workspaceId).then(() => client.invalidateQueries({ queryKey: inWorkspace(workspaceId, "competitors", "proposals") }));
  }, [data?.site, data?.scannedAt, manage]);
  return data;
}

const SEARCH_WORDS: Record<string, string> = {
  not_available: "Search isn't available on this server.",
  person_data: "A search term can't hold an email address, a web address or a person's name.",
  search_limit: "This Workspace has used its 5 searches for this month.",
  bad_terms: "Give 1 to 3 search terms of 2 to 100 characters.",
};

/** A search for competitors, which Direx pays for, a few a month per Workspace. */
function Search(p: { workspaceId: string; left: number; onDone: () => Promise<unknown> }) {
  const action = useAction(SEARCH_WORDS);
  const [terms, setTerms] = useState(["", "", ""]);
  const kept = terms.map((t) => t.trim()).filter((t) => t.length >= 2);
  const type = (i: number, value: string) => setTerms((all) => all.map((t, j) => (j === i ? value : t)));
  const search = () =>
    void action.run(
      async () => {
        const code = await searchCompetitors(p.workspaceId, kept);
        if (code) return code;
        setTerms(["", "", ""]);
        await p.onDone();
        return null;
      },
      { say: "Search done. What it found is under Proposed." },
    );
  return (
    <details className="text-sm">
      <summary className="cursor-pointer">Search for competitors</summary>
      <div className="mt-2 flex flex-col gap-2">
        <p className="text-muted-foreground">Search the web for companies like yours. {p.left === 1 ? "1 search" : `${p.left} searches`} left this month.</p>
        {terms.map((t, i) => (
          <Field key={i} label={i === 0 ? "Search term" : `Search term ${i + 1} (optional)`}>
            <Input value={t} onChange={(e) => type(i, e.target.value)} maxLength={100} placeholder={i === 0 ? "bank reconciliation software for QuickBooks" : undefined} />
          </Field>
        ))}
        {action.error && <Notice tone="error">{action.error}</Notice>}
        <div>
          <Button size="sm" pending={action.pending} disabled={kept.length === 0 || p.left === 0} onClick={search}>
            Search
          </Button>
        </div>
      </div>
    </details>
  );
}

const listed = (names: string[]) => (names.length < 2 ? names.join("") : `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`);

/** Setup's line naming the competitors Direx found on the Workspace's site, with a way to add them. */
export function CompetitorsFound(p: { workspaceId: string; role: Role }) {
  const data = useFirstScan(p.workspaceId, p.role === "owner" || p.role === "admin");
  const names = data?.proposals.slice(0, 5).map((x) => x.name) ?? [];
  if (names.length === 0) return null;
  return (
    <p className="text-sm">
      Your site compares you with {listed(names)}.{" "}
      <Link to="/w/$workspaceId/brand/competitors" params={{ workspaceId: p.workspaceId }} className="underline">
        Add them as competitors
      </Link>
    </p>
  );
}

/** The last 4 weeks of Changes, behind a disclosure; nothing at all when there are none. */
function Changes(p: { workspaceId: string; competitor: Competitor }) {
  const { data } = useQuery(changesQuery(p.workspaceId, p.competitor.id));
  if (!data || data.length === 0) return null;
  return (
    <details className="text-sm">
      <summary className="cursor-pointer">Changes in the last 4 weeks ({data.length})</summary>
      <ul aria-label={`Changes at ${p.competitor.name}`} className="mt-2 flex flex-col gap-2">
        {data.map((c) => (
          <li key={c.id}>
            <span className="text-muted-foreground">
              {new Date(c.at).toLocaleDateString(undefined, { day: "numeric", month: "short" })}, {c.source}:
            </span>
            <ul className="list-disc pl-5">
              {changeWords(c).map((line) => (
                <li key={line}>{line}</li>
              ))}
            </ul>
            {c.label !== null && <p className={c.label === "answer" ? "font-medium" : "text-muted-foreground"}>{labelWords(c, data)}</p>}
            {c.itemId && (
              <Link to="/w/$workspaceId/review/$itemId" params={{ workspaceId: p.workspaceId, itemId: c.itemId }}>
                Open the counter-move
              </Link>
            )}
          </li>
        ))}
      </ul>
    </details>
  );
}

const WORDS: Record<string, string> = {
  name_missing: "Give the competitor a name.",
  name_length: "Give the competitor a name of up to 100 characters.",
  no_url: "Add at least one page: pricing, changelog or landing.",
  bad_url: "Each page needs a full web address starting with https://.",
  name_taken: "A competitor with that name is already on the list.",
  too_many: "Up to 5 competitors.",
};
const PAGES = [
  ["pricingUrl", "pricing", "Pricing page"],
  ["changelogUrl", "changelog", "Changelog"],
  ["landingUrl", "landing", "Landing page"],
] as const;
/** The form asks for the landing page first, since Find pages starts from it. */
const FORM_PAGES = [PAGES[2], PAGES[0], PAGES[1]] as const;
type Found = "pricingUrl" | "changelogUrl";
const WEB = /^https?:\/\/\S+\.\S+/i;
const BLANK: CompetitorFields = { name: "", pricingUrl: "", changelogUrl: "", landingUrl: "", comparisonUrl: "" };
const COMPARISON = "Our comparison page (optional)";

export function Competitors(p: { workspaceId: string; role: Role }) {
  const client = useQueryClient();
  const query = useQuery(competitorsQuery(p.workspaceId));
  // A competitor's Fact is filed under its name, which Facts keep in lower case.
  const known = useQuery(factsQuery(p.workspaceId)).data?.filter((f) => f.field === "competitor") ?? [];
  const action = useAction(WORDS);
  const [form, setForm] = useState<CompetitorFields>(BLANK);
  // A discovery response needs the latest draft, including edits made before React renders.
  const draft = useRef(form);
  const formContext = useRef(0);
  const updateForm = (next: CompetitorFields) => {
    draft.current = next;
    setForm(next);
  };
  const [editing, setEditing] = useState<string | null>(null);
  // The latest check of each competitor, by id: shown, never stored.
  const [checks, setChecks] = useState<Record<string, Check[]>>({});
  // What Find pages gave: where each filled page came from, pages found for a field already typed, and why it found nothing.
  const [notes, setNotes] = useState<Partial<Record<Found, string>>>({});
  const [offers, setOffers] = useState<Partial<Record<Found, string>>>({});
  const [also, setAlso] = useState<string[]>([]);
  const [findNote, setFindNote] = useState<string | null>(null);
  const [looking, setLooking] = useState(false);
  // The proposal used to fill the form, which adding closes.
  const [proposalId, setProposalId] = useState<string | null>(null);
  const found = useFirstScan(p.workspaceId, p.role === "owner" || p.role === "admin");
  const manage = p.role === "owner" || p.role === "admin";

  /** Runs a change, keeps its checks over the row's older ones source by source, and reloads the list. */
  const change = (write: () => Promise<Result>, say?: string, after?: () => void) =>
    void action.run(
      async () => {
        const r = await write();
        if (r.code) return r.code;
        const { id, checks: fresh } = r;
        if (id) setChecks((all) => ({ ...all, [id]: [...(all[id] ?? []).filter((c) => !fresh.some((f) => f.source === c.source)), ...fresh] }));
        after?.();
        await client.invalidateQueries({ queryKey: inWorkspace(p.workspaceId, "competitors") });
        return null;
      },
      say ? { say } : undefined,
    );
  const forget = () => {
    setNotes({});
    setOffers({});
    setAlso([]);
    setFindNote(null);
  };
  const reset = () => {
    formContext.current++;
    updateForm(BLANK);
    setEditing(null);
    setProposalId(null);
    forget();
  };
  /** Fills the form from a proposal; nothing is saved until Add competitor. */
  const fillFrom = (x: Proposal) => {
    reset();
    updateForm({ ...BLANK, name: x.name, landingUrl: x.site ?? "", comparisonUrl: x.comparisonUrl ?? "" });
    setProposalId(x.id);
  };
  const reloadProposals = () => client.invalidateQueries({ queryKey: inWorkspace(p.workspaceId, "competitors", "proposals") });
  const dismiss = (x: Proposal) =>
    void action.run(async () => (await dismissProposal(p.workspaceId, x.id)) ?? (await reloadProposals(), null), { say: `${x.name} dismissed.` });
  const lookAgain = () => void action.run(async () => (await scanProposals(p.workspaceId)) ?? (await reloadProposals(), null));
  /** A page the person types is theirs: the note saying where Direx found it no longer applies. */
  const typed = (key: keyof CompetitorFields, value: string) => {
    if (key === "landingUrl" && value !== draft.current.landingUrl) formContext.current++;
    updateForm({ ...draft.current, [key]: value });
    if (key === "pricingUrl" || key === "changelogUrl") setNotes(({ [key]: _, ...rest }) => rest);
  };
  /** Fills only empty fields; a typed one keeps its value and gets the found page as an offer. Nothing is saved. */
  const look = async () => {
    // Pages an earlier Find pages filled, and nobody edited since, belong to that address: they go.
    const context = formContext.current;
    const start = { ...draft.current };
    for (const key of Object.keys(notes) as Found[]) start[key] = "";
    updateForm(start);
    forget();
    setLooking(true);
    const r = await findPages(p.workspaceId, start.landingUrl ?? "").finally(() => setLooking(false));
    if (context !== formContext.current) return;
    if (!r.ok) return setFindNote(findWords(r.reason));
    const pages: [Found, (typeof r)["pricing"]][] = [
      ["pricingUrl", r.pricing],
      ["changelogUrl", r.changelog],
    ];
    for (const [key, page] of pages) {
      if (!page) continue;
      const current = draft.current[key]?.trim();
      if (!current) {
        updateForm({ ...draft.current, [key]: page.url });
        setNotes((n) => ({ ...n, [key]: foundWords(page) }));
      } else if (current !== page.url) setOffers((o) => ({ ...o, [key]: page.url }));
    }
    setAlso(r.alsoPricing);
    if (!r.pricing && !r.changelog) setFindNote("No pricing page or changelog found. Add them by hand if they exist.");
  };
  const use = (key: Found) => {
    updateForm({ ...draft.current, [key]: offers[key] ?? "" });
    setOffers(({ [key]: _, ...rest }) => rest);
  };
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (editing) change(() => editCompetitor(p.workspaceId, editing, form), "Saved.", reset);
    else change(() => addCompetitor(p.workspaceId, proposalId ? { ...form, proposalId } : form), "Competitor added.", reset);
  };
  const remove = (c: Competitor) => change(async () => ({ code: await removeCompetitor(p.workspaceId, c.id), id: null, checks: [] }), "Removed.");
  const edit = (c: Competitor) => {
    formContext.current++;
    setEditing(c.id);
    forget();
    updateForm({ name: c.name, pricingUrl: c.pricingUrl ?? "", changelogUrl: c.changelogUrl ?? "", landingUrl: c.landingUrl ?? "", comparisonUrl: c.comparisonUrl ?? "" });
  };

  return (
    <Section
      title="Competitors"
      description={
        <>
          <small className="mr-1 rounded border border-border px-1">Beta</small>
          Direx reads these pages once a week to spot what your competitors change. Give each one's pricing page, changelog and landing page.
        </>
      }
    >
      {action.error && <Notice tone="error">{action.error}</Notice>}
      <QueryBoundary query={query} skeleton={<Skeleton className="h-32 w-full" />}>
        {({ competitors: list, reads }) => (
          <div className="flex flex-col gap-4">
            {(found?.proposals.length ?? 0) > 0 && (
              <section aria-label="Proposed competitors" className="flex flex-col gap-2">
                <h3 className="font-medium">Proposed</h3>
                <ul className="flex flex-col gap-2">
                  {found!.proposals.map((x) => (
                    <li key={x.id} className="flex flex-wrap items-center justify-between gap-2 text-sm">
                      <span>
                        <span className="font-medium">{x.name}</span>{" "}
                        <span className="text-muted-foreground">
                          {x.comparisonUrl ? (
                            <a href={x.comparisonUrl} target="_blank" rel="noopener noreferrer" className="underline">
                              {proposalSource(x)}
                            </a>
                          ) : (
                            proposalSource(x)
                          )}
                        </span>
                      </span>
                      {manage && (
                        <span className="flex gap-2">
                          <Button size="sm" variant="outline" disabled={list.length >= MAX_COMPETITORS} onClick={() => fillFrom(x)} aria-label={`Use ${x.name}`}>
                            Use
                          </Button>
                          <Button size="sm" variant="outline" pending={action.pending} onClick={() => dismiss(x)} aria-label={`Dismiss ${x.name}`}>
                            Dismiss
                          </Button>
                        </span>
                      )}
                    </li>
                  ))}
                </ul>
                {manage && list.length >= MAX_COMPETITORS && <p className="text-sm text-muted-foreground">5 of 5 set. Remove one to add another.</p>}
              </section>
            )}
            {manage && found?.searchAvailable && <Search workspaceId={p.workspaceId} left={found.searchesLeft} onDone={reloadProposals} />}
            {manage && found?.site && (
              <div>
                <Button size="sm" variant="outline" pending={action.pending} onClick={lookAgain}>
                  Look on your site again
                </Button>
              </div>
            )}
            {list.length === 0 && <p className="text-sm text-muted-foreground">No competitors yet.</p>}
            <ul className="flex flex-col gap-4">
              {list.map((c) => (
                <li key={c.id} aria-label={c.name} className="flex flex-col gap-2 border-t border-border pt-4 first:border-t-0 first:pt-0">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <h3 className="font-medium">{c.name}</h3>
                    {manage && (
                      <div className="flex flex-wrap gap-2">
                        <Button size="sm" variant="outline" onClick={() => edit(c)} aria-label={`Edit ${c.name}`}>
                          Edit
                        </Button>
                        <Button size="sm" variant="outline" onClick={() => change(() => checkCompetitor(p.workspaceId, c.id))} pending={action.pending} aria-label={`Check ${c.name} again`}>
                          Check again
                        </Button>
                        <Confirm
                          title={`Remove ${c.name}?`}
                          body="Direx stops reading its pages."
                          confirm="Remove"
                          onConfirm={() => remove(c)}
                          trigger={
                            <Button size="sm" variant="outline" aria-label={`Remove ${c.name}`}>
                              Remove
                            </Button>
                          }
                        />
                      </div>
                    )}
                  </div>
                  <dl className="grid gap-1 text-sm sm:grid-cols-[10rem_1fr]">
                    {PAGES.map(([key, source, label]) => {
                      const url = c[key];
                      if (!url) return null;
                      const check = checks[c.id]?.find((x) => x.source === source);
                      // A read of a URL since edited says nothing about this one.
                      const read = reads.find((r) => r.competitorId === c.id && r.source === source && r.url === url);
                      return (
                        <div key={key} className="contents">
                          <dt className="text-muted-foreground">{label}</dt>
                          <dd className="break-all">
                            {url}
                            {check && <span className="block text-muted-foreground">{checkWords(check)}</span>}
                            {read && <span className="block text-muted-foreground">{readWords(read)}</span>}
                          </dd>
                        </div>
                      );
                    })}
                    {c.comparisonUrl && (
                      <div className="contents">
                        <dt className="text-muted-foreground">Our comparison page</dt>
                        <dd className="break-all">{c.comparisonUrl}</dd>
                      </div>
                    )}
                  </dl>
                  {known
                    .filter((f) => f.subject === c.name.trim().toLowerCase())
                    .map((f) => (
                      <p key={f.id} className="text-sm">
                        <span className="text-muted-foreground">What Direx knows: </span>
                        {f.value}
                      </p>
                    ))}
                  {!c.changelogUrl && <p className="text-sm text-muted-foreground">No changelog: most answerable changes come from changelogs.</p>}
                  <Changes workspaceId={p.workspaceId} competitor={c} />
                </li>
              ))}
            </ul>
            {manage && (
              <form onSubmit={submit} aria-label={editing ? "Edit competitor" : "Add a competitor"} className="flex flex-col gap-2 border-t border-border pt-4">
                <Field label="Name">
                  <Input value={form.name} onChange={(e) => typed("name", e.target.value)} maxLength={100} />
                </Field>
                {FORM_PAGES.map(([key, , label]) => (
                  <div key={key} className="flex flex-col gap-1">
                    <Field label={label} hint={key === "landingUrl" ? undefined : notes[key]}>
                      <Input type="url" value={form[key] ?? ""} onChange={(e) => typed(key, e.target.value)} maxLength={2000} placeholder="https://" />
                    </Field>
                    {key === "landingUrl" && (
                      <div>
                        <Button type="button" size="sm" variant="outline" onClick={() => void look()} pending={looking} disabled={!WEB.test(form.landingUrl ?? "")}>
                          Find pages
                        </Button>
                      </div>
                    )}
                    {key !== "landingUrl" && offers[key] && (
                      <p className="flex flex-wrap items-center gap-2 text-sm">
                        <span className="break-all">Direx found {offers[key]}</span>
                        <Button type="button" size="sm" variant="outline" onClick={() => use(key)} aria-label={`Use the found ${label.toLowerCase()}`}>
                          Use
                        </Button>
                      </p>
                    )}
                    {key === "pricingUrl" && also.length > 0 && <p className="break-all text-sm text-muted-foreground">Other pricing pages: {also.join(", ")}</p>}
                  </div>
                ))}
                {findNote && <Notice tone="info">{findNote}</Notice>}
                <Field label={COMPARISON}>
                  <Input type="url" value={form.comparisonUrl ?? ""} onChange={(e) => typed("comparisonUrl", e.target.value)} maxLength={2000} placeholder="https://" />
                </Field>
                {!editing && list.length >= MAX_COMPETITORS && <p className="text-sm text-muted-foreground">{WORDS.too_many}</p>}
                <div className="flex gap-2">
                  <Button type="submit" size="sm" pending={action.pending} disabled={!form.name.trim() || (!editing && list.length >= MAX_COMPETITORS)}>
                    {editing ? "Save" : "Add competitor"}
                  </Button>
                  {editing && (
                    <Button type="button" size="sm" variant="outline" onClick={reset}>
                      Cancel
                    </Button>
                  )}
                </div>
              </form>
            )}
          </div>
        )}
      </QueryBoundary>
    </Section>
  );
}
