// SPDX-License-Identifier: AGPL-3.0-only
import { useEffect, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { isLive, statusLabel } from "../agents/actions";
import { Field, Notice, Page, Section } from "../components/layout";
import { Button } from "@/components/Button";
import { Input, Textarea } from "@/components/Input";
import { mayApprove, mayEdit, type Role } from "../items/actions";
import { dayWords } from "../campaigns/actions";
import {
  draftTerms,
  droppedWords,
  estimate,
  pastedCount,
  perCompanyQuery,
  readTerms,
  runsQuery,
  searchName,
  SEARCH_MAX,
  searchLineWords,
  SIGNAL_WORDS,
  saySearch,
  spentWords,
  sayStart,
  startPasted,
  startSearch,
  termsQuery,
  termsRunQuery,
  usd,
  usdUp,
  centsUp,
  type Estimate,
  type PastedLine,
  type ProposedTerms,
  type SearchBody,
  type SearchLine,
  type Signal,
} from "./actions";

const SIGNALS: Signal[] = ["hiring", "stale_blog"];
const POLL_MS = 3_000;
const link = "underline underline-offset-4";
const companies = (n: number) => (n === 1 ? "1 company" : `${n} companies`);
type Started = { runId: string | null; results: PastedLine[] };
type Found = { runId: string; status: "running" | "done" | "stopped"; searchUsd: number; results: SearchLine[] };
export type SearchState = { available?: boolean; proposed?: ProposedTerms; estimate?: Estimate; found?: Found; note?: string };

function RunLink(p: { workspaceId: string; runId: string; children: React.ReactNode }) {
  return (
    <Link to="/w/$workspaceId/people/find/$runId" params={{ workspaceId: p.workspaceId, runId: p.runId }} className={link}>
      {p.children}
    </Link>
  );
}

/**
 * Find companies by searching from the Strategy, where a search is installed, or from a pasted list of
 * websites. Each company is read once, and nothing is sent from here.
 */
const RUN_STATUS: Record<string, string> = { running: "Running", done: "Done", stopped: "Stopped" };
const when = (iso: string) => new Date(iso).toLocaleString(undefined, { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });

/** The latest runs, each a link to its page, so a run can be found again after leaving this one. */
function PastRuns({ workspaceId }: { workspaceId: string }) {
  const runs = useQuery(runsQuery(workspaceId)).data ?? [];
  if (runs.length === 0) return null;
  return (
    <Section title="Past searches" description="The latest 20, newest first.">
      <ul className="flex flex-col divide-y divide-border">
        {runs.map((r) => (
          <li key={r.id} className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1 py-2">
            <Link to="/w/$workspaceId/people/find/$runId" params={{ workspaceId, runId: r.id }}>
              {searchName({ source: r.source, terms: r.terms, createdAt: r.createdAt })}
            </Link>
            <span className="text-sm text-muted-foreground">
              {`${r.terms.length ? `${when(r.createdAt)} · ` : ""}${RUN_STATUS[r.status] ?? r.status} · ${r.companies} ${r.companies === 1 ? "company" : "companies"} · ${spentWords(r)}`}
            </span>
          </li>
        ))}
      </ul>
    </Section>
  );
}

export function Find(p: { workspaceId: string; role: Role; initial?: Started; search?: SearchState }) {
  const { workspaceId } = p;
  const client = useQueryClient();
  const [started, setStarted] = useState<Started | undefined>(p.initial);
  const [note, setNote] = useState<string>();
  const [pending, setPending] = useState(false);
  const [unavailable, setUnavailable] = useState(false);
  // A pasted list can't be stopped at an amount, so it is priced, not limited: each new company at its worst case.
  // The same answer says whether a company search is installed, so the screen offers a search box only where one works.
  const per = useQuery({ ...perCompanyQuery(workspaceId), enabled: mayEdit(p.role) }).data;
  const available = unavailable ? false : (p.search?.available ?? per?.searchAvailable);
  const [sites, setSites] = useState("");
  const count = pastedCount(sites);
  const about = per && count > 0 ? per.usd * count : undefined;

  async function submit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (!sites.trim()) return setNote("Paste at least one website, one per line.");
    const f = new FormData(e.currentTarget);
    setPending(true);
    const r = await startPasted(workspaceId, {
      websites: String(f.get("websites") ?? "").split("\n"),
      signals: SIGNALS.filter((s) => f.get(s) === "on"),
      confirmedUsd: Number(centsUp(about ?? 0)),
    }).finally(() => setPending(false));
    if (!r.ok) return setNote(sayStart(r.error, r.max));
    setNote(undefined);
    setStarted({ runId: r.runId, results: r.results });
    void client.invalidateQueries({ queryKey: runsQuery(workspaceId).queryKey });
  }

  return (
    <Page
      title="Find companies"
      description={
        <>
          {available === false && "Searching for companies isn't available here, so paste their websites. "}
          {available === true && "Search for companies that fit your Strategy, or paste their websites. "}
          Direx reads each company&apos;s own site once, and you review every company before any address is kept.
        </>
      }
    >
      {available === true && mayEdit(p.role) && <Search workspaceId={workspaceId} role={p.role} initial={p.search} onUnavailable={() => setUnavailable(true)} />}
      <Section title="Paste websites">
        {note && <Notice tone="error">{note}</Notice>}
        {mayApprove(p.role) ? (
          <form onSubmit={submit} className="flex flex-col gap-4">
            <Field label="Websites, one per line">
              <Textarea name="websites" rows={8} autoComplete="off" spellCheck={false} value={sites} onChange={(e) => setSites(e.target.value)} />
            </Field>
            <fieldset className="flex flex-wrap gap-x-4 gap-y-2">
              <legend className="mb-2 text-sm font-medium">Signals to look for</legend>
              {SIGNALS.map((s) => (
                <label key={s} className="flex min-h-9 items-center gap-2">
                  <input type="checkbox" name={s} defaultChecked /> {SIGNAL_WORDS[s]}{" "}
                </label>
              ))}
            </fieldset>
            {about !== undefined && per && (
              <p role="status">
                About {usdUp(about)} for {companies(count)}, at most {usd(per.usd)} each{per.namesFree ? ", since reading names runs on your Claude Code or Codex subscription" : ""}.
              </p>
            )}
            <p className="text-sm text-muted-foreground">
              Pasted websites have no spend limit: Direx reads every new company you paste, at most 200. A company Direx already has isn&apos;t read or charged again.
            </p>
            <div>
              <Button type="submit" pending={pending}>
                Read these companies
              </Button>
            </div>
          </form>
        ) : (
          <p className="text-muted-foreground">Ask an Owner, Admin or Marketer to start a search.</p>
        )}
      </Section>
      {started && (
        <Section title="Each website">
          <div aria-label="What happened to each website" role="group" className="flex flex-col gap-3">
            {started.runId && (
              <p>
                <RunLink workspaceId={workspaceId} runId={started.runId}>
                  Open this search
                </RunLink>
              </p>
            )}
            <ul className="flex flex-col gap-1">
              {started.results.map((l) => (
                <li key={l.line}>
                  <span className="font-medium">{l.website}</span>: {lineWords(l, started.results)}{" "}
                  {l.reason === "already_known" && l.runId && (
                    <RunLink workspaceId={workspaceId} runId={l.runId}>
                      See the search that found it
                    </RunLink>
                  )}
                </li>
              ))}
            </ul>
          </div>
        </Section>
      )}
      <PastRuns workspaceId={workspaceId} />
    </Page>
  );
}

/** Terms drafted from the Strategy, edited by a person, priced, and searched only for an amount they confirm. */
function Search(p: { workspaceId: string; role: Role; initial?: SearchState; onUnavailable: () => void }) {
  const { workspaceId } = p;
  const [text, setText] = useState(p.initial?.proposed?.terms.join("\n") ?? "");
  const [drafting, setDrafting] = useState<string>();
  const [limit, setLimit] = useState(p.initial?.estimate?.limit ?? 25);
  const [signals, setSignals] = useState<Signal[]>(SIGNALS);
  const [est, setEst] = useState(p.initial?.estimate);
  const [amount, setAmount] = useState((p.initial?.estimate && centsUp(p.initial.estimate.totalUsd)) ?? "");
  const [found, setFound] = useState(p.initial?.found);
  const [note, setNote] = useState(p.initial?.note);
  const [busy, setBusy] = useState<"draft" | "cost" | "run">();
  const approver = mayApprove(p.role);
  const busyWith = <T,>(at: "draft" | "cost" | "run", call: Promise<T>) => {
    setBusy(at);
    return call.finally(() => setBusy(undefined));
  };

  // Terms drafted earlier wait on the server, so coming back to this screen doesn't lose them. While a
  // terms run works in the background, both are checked until its terms, the ones carrying its runId, land.
  const terms = useQuery({ ...termsQuery(workspaceId), refetchInterval: drafting ? POLL_MS : false });
  const termsRun = useQuery({ ...termsRunQuery(workspaceId, drafting ?? ""), enabled: drafting !== undefined, refetchInterval: (q) => (q.state.data && !isLive(q.state.data) ? false : POLL_MS) });
  const proposed = terms.data ?? p.initial?.proposed;

  useEffect(() => {
    const t = terms.data;
    if (!t) return;
    if (t.runId === drafting) {
      setText(t.terms.join("\n"));
      setEst(undefined);
      setDrafting(undefined);
    } else setText((cur) => cur || t.terms.join("\n"));
  }, [terms.data, drafting]);

  useEffect(() => {
    const run = termsRun.data;
    if (!drafting || !run || isLive(run) || run.status === "succeeded") return;
    setNote(`Drafting terms stopped (${statusLabel(run)}). Write them yourself, or try again.`);
    setDrafting(undefined);
  }, [termsRun.data, drafting]);

  // A changed search needs its cost worked out again before it can run.
  const changed =
    <T,>(set: (v: T) => void) =>
    (v: T) => {
      set(v);
      setEst(undefined);
    };

  function refuse(e: { error: string; terms?: string[]; usd?: number }) {
    if (e.error === "not_available") return p.onUnavailable();
    setNote(saySearch(e));
  }

  function body(): SearchBody | undefined {
    const terms = readTerms(text);
    const bad = !terms.length ? "no_terms" : terms.length > SEARCH_MAX.terms ? "too_many_terms" : terms.some((t) => t.length > SEARCH_MAX.termLength) ? "term_too_long" : undefined;
    if (bad) return void setNote(saySearch({ error: bad }));
    return { terms, limit, signals };
  }

  async function draft() {
    setNote(undefined);
    const r = await busyWith("draft", draftTerms(workspaceId));
    if (!r.ok) return refuse(r);
    setDrafting(r.runId);
  }

  async function workOut(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const b = body();
    if (!b) return;
    const r = await busyWith("cost", estimate(workspaceId, b));
    if (!r.ok) return refuse(r);
    setNote(undefined);
    setEst(r.estimate);
    setAmount(centsUp(r.estimate.totalUsd));
  }

  async function run() {
    const b = body();
    if (!b) return;
    const r = await busyWith("run", startSearch(workspaceId, { ...b, confirmedUsd: Number(amount) }));
    if (!r.ok) return refuse(r);
    setNote(undefined);
    setFound({ runId: r.runId, status: r.status, searchUsd: r.searchUsd, results: r.results });
  }

  return (
    <Section title="Search from your Strategy" description="Direx drafts search terms from who your Strategy is for, and you can change them. A term can't name a person or hold an address.">
      {note && <Notice tone="error">{note}</Notice>}
      <div>
        <Button variant="outline" onClick={() => void draft()} disabled={drafting !== undefined} pending={busy === "draft"}>
          Draft terms from the Strategy
        </Button>
      </div>
      {drafting && <Notice>Direx is drafting terms. Nothing is searched yet.</Notice>}
      {proposed && (
        <p className="text-sm text-muted-foreground">
          Terms drafted {dayWords(proposed.proposedAt.slice(0, 10))}.{proposed.objective && <> Objective: {proposed.objective}</>} {droppedWords(proposed)}
        </p>
      )}
      <form onSubmit={(e) => void (est && approver ? (e.preventDefault(), run()) : workOut(e))} className="flex flex-col gap-4">
        <Field label={`Search terms, one per line, at most ${SEARCH_MAX.terms}`}>
          <Textarea name="terms" rows={6} value={text} onChange={(e) => changed(setText)(e.target.value)} required />
        </Field>
        <Field label={`Number of companies, at most ${SEARCH_MAX.companies}`}>
          <Input name="limit" type="number" min={1} max={SEARCH_MAX.companies} step={1} value={limit} onChange={(e) => changed(setLimit)(Number(e.target.value))} required className="max-w-48" />
        </Field>
        <fieldset className="flex flex-wrap gap-x-4 gap-y-2">
          <legend className="mb-2 text-sm font-medium">Signals to look for</legend>
          {SIGNALS.map((s) => (
            <label key={s} className="flex min-h-9 items-center gap-2">
              <input type="checkbox" checked={signals.includes(s)} onChange={(e) => changed(setSignals)(e.target.checked ? [...signals, s] : signals.filter((x) => x !== s))} /> {SIGNAL_WORDS[s]}{" "}
            </label>
          ))}
        </fieldset>
        {est && (
          <p role="status">
            Direx&apos;s estimate: about {usdUp(est.totalUsd)} for {companies(est.limit)}.
          </p>
        )}
        {est && (
          <details className="text-sm">
            <summary className="cursor-pointer">How the estimate is made</summary>
            <div className="mt-2 flex flex-col gap-2">
              <Cost est={est} />
            </div>
          </details>
        )}
        {est && approver && (
          <>
            <Field label="Spend up to, in US dollars">
              <Input name="confirmed" type="number" min={0} step="0.01" value={amount} onChange={(e) => setAmount(e.target.value)} required className="max-w-48" />
            </Field>
            <p className="text-sm text-muted-foreground">Direx reads only as many companies as this covers, and lists the rest as left over. Changing the search above clears the estimate.</p>
          </>
        )}
        {/* One button for those who may search: the first press works out the cost, the second searches for the amount confirmed. */}
        {est && !approver && <p className="text-muted-foreground">You can draft terms and work out the cost. Ask an Owner, Admin or Marketer to start the search.</p>}
        <div>
          <Button type="submit" variant={est && approver ? "default" : "outline"} pending={busy === "cost" || busy === "run"}>
            {!approver ? "Work out the cost" : est ? `Search ${companies(limit)} · up to ${usd(Number(amount) || 0)}` : `Work out the cost of ${companies(limit)}`}
          </Button>
        </div>
      </form>
      {found && <Results found={found} workspaceId={workspaceId} />}
    </Section>
  );
}

function Cost({ est }: { est: Estimate }) {
  const d = est.defaults;
  return (
    <>
      <ul aria-label="Cost" className="flex flex-col gap-1">
        <li>Search: {usdUp(est.searchUsd)}</li>
        <li>
          {est.namesFree
            ? "Reading names: no cost, they run on your Claude Code or Codex subscription"
            : `Reading names, at most: ${usd(est.namesUsd)} (${est.limit} companies at up to ${usd(d.namesUsdPerCompany)} each)`}
        </li>
        <li>
          Checking addresses, at most: {usd(est.verifyUsd)} (up to {d.addressesPerCompany} addresses a company at {usd(d.verifyUsdPerAddress)} each)
        </li>
        <li>Total, at most: {usdUp(est.totalUsd)}</li>
      </ul>
      <p className="text-sm text-muted-foreground">
        Reading names and checking addresses are worst-case bounds: every company is counted at its full limit, so a real search usually costs less. The search figure is the search service&apos;s own
        estimate.
      </p>
    </>
  );
}

function Results({ found, workspaceId }: { found: Found; workspaceId: string }) {
  return (
    <section aria-label="What happened to each company" className="flex flex-col gap-3 border-t border-border pt-4">
      <h3 className="font-medium">Each company found</h3>
      <p>
        <RunLink workspaceId={workspaceId} runId={found.runId}>
          Open this search
        </RunLink>
      </p>
      <p>
        The search is counted at {usd(found.searchUsd)}.{found.status === "stopped" && " The spend limit ran out, so some companies were left over."}
      </p>
      {found.results.length === 0 ? (
        <p>The search found no companies.</p>
      ) : (
        <ul className="flex flex-col gap-1">
          {found.results.map((l) => (
            <li key={l.domain}>
              {l.name ? `${l.name} (${l.domain})` : l.domain}: {searchLineWords(l)}{" "}
              {l.reason === "already_known" && l.runId && (
                <RunLink workspaceId={workspaceId} runId={l.runId}>
                  See the search that found it
                </RunLink>
              )}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function lineWords(l: PastedLine, all: PastedLine[]): string {
  if (l.ok) return "added to this search";
  if (l.reason === "invalid_website") return "not a website Direx can read";
  if (l.reason === "duplicate") return `same company as ${all.find((x) => x.line === l.sameAs)?.website ?? `line ${l.sameAs}`}`;
  return "already known, so it isn't read or charged again";
}
