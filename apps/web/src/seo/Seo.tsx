// SPDX-License-Identifier: AGPL-3.0-only
import { Link } from "@tanstack/react-router";
import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { inWorkspace } from "../api/query";
import { EmptyState, Field, Notice, Page } from "../components/layout";
import { zoneQuery } from "../credentials/actions";
import { QueryBoundary } from "../components/QueryBoundary";
import { Skeleton } from "@astryxdesign/core/Skeleton";
import { Button } from "@/components/Button";
import { toast } from "@/components/toast";
import { useAction } from "../components/useAction";
import { mayEdit, type Role } from "../items/actions";
import { StateChip } from "../items/StateChip";
import { Select } from "@/components/Input";
import { messageForCode } from "../api/messages";
import { saveApp } from "../social/actions";
import { Wizard } from "../social/Wizard";
import {
  API_LIBRARY,
  CONNECTION,
  googleAppSteps,
  briefsQuery,
  candidatesQuery,
  changeWords,
  rankChangeWords,
  chooseProperty,
  connect,
  connectError,
  dayWords,
  helpedWords,
  historyQuery,
  momentWords,
  pathOf,
  runBriefs,
  say,
  searchConsoleQuery,
  skippedWords,
  stoppedWords,
  summaryQuery,
  rowStates,
  waitingKey,
  writeBrief,
  type BriefHistory,
  type History,
  type BriefsState,
  type Candidates,
  type Refusal,
  type SearchConsole,
  type Summary,
} from "./actions";

/** How many of each kind the page lists; the rest are counted. */
const SHOWN = 5;
const CARD = "flex flex-col gap-4 rounded-card border border-border bg-card p-6";

/** Search Console for the Workspace: connect it, pick a property, and check its last 28 days. */
export function Seo(p: { workspaceId: string; role: Role; notice?: string; initial?: { state: SearchConsole; summary?: Summary | Refusal; candidates?: Candidates | Refusal; briefs?: BriefsState; history?: History } }) {
  const { workspaceId, role } = p;
  const client = useQueryClient();
  const state = useQuery({ ...searchConsoleQuery(workspaceId), initialData: p.initial?.state });
  const ready = !!state.data?.siteUrl && !state.data.refusal;
  const sum = useQuery({ ...summaryQuery(workspaceId), enabled: ready, initialData: p.initial?.summary });
  const week = useQuery({ ...briefsQuery(workspaceId), enabled: ready, initialData: p.initial?.briefs });
  const cands = useQuery({ ...candidatesQuery(workspaceId), enabled: ready, initialData: p.initial?.candidates });
  const past = useQuery({ ...historyQuery(workspaceId), enabled: ready, initialData: p.initial?.history });
  // Times read in the Workspace time zone; UTC until it loads or when it can't be read.
  const zone = useQuery(zoneQuery(workspaceId)).data?.timeZone ?? "UTC";
  const [changing, setChanging] = useState(false);
  const [error, setError] = useState<string | undefined>(p.notice ? connectError(p.notice) : undefined);
  const connecting = useAction();
  const saving = useAction();
  const running = useAction();
  const writing = useAction();

  const manage = role === "owner" || role === "admin";
  const mayConnect = mayEdit(role);
  const start = () =>
    connecting.run(async () => {
      setError((await connect(workspaceId)) ?? undefined);
      return null;
    });

  const saveOwnApp = async (f: { clientId: string; clientSecret: string }) => {
    const code = await saveApp(workspaceId, { connection: CONNECTION, label: "Search Console" }, f);
    setError(code ? messageForCode(code, { duplicate_key: "This Workspace already has a Google app for Search Console." }) : undefined);
    if (code) return;
    toast.add({ title: "Saved. Connect Search Console now." });
    await client.invalidateQueries({ queryKey: searchConsoleQuery(workspaceId).queryKey });
  };

  const submit = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const siteUrl = String(new FormData(e.currentTarget).get("siteUrl"));
    await saving.run(async () => {
      const refusal = await chooseProperty(workspaceId, siteUrl);
      setError(refusal ? say(refusal) : undefined);
      if (!refusal) {
        toast.add({ title: "Saved." });
        setChanging(false);
        await client.invalidateQueries({ queryKey: inWorkspace(workspaceId) });
      }
      return null;
    });
  };

  const refused = (r: Refusal) => (
    <Notice tone="error">
      {say(r)}
      {r.reason === "api_disabled" && r.selfHost && (
        <>
          {" "}
          <a href={API_LIBRARY}>Open the Search Console API in Google Cloud</a>
        </>
      )}
      {r.reason === "needs_reconnecting" && mayConnect && (
        <>
          {" "}
          <Button size="sm" variant="outline" pending={connecting.pending} onClick={() => void start()}>
            Reconnect
          </Button>
        </>
      )}
    </Notice>
  );

  const run = () =>
    running.run(async () => {
      const r = await runBriefs(workspaceId);
      if (typeof r === "string") setError(r);
      else client.setQueryData(briefsQuery(workspaceId).queryKey, { note: r, ranThisWeek: true });
      return null;
    });

  const write = (page: string, query: string) =>
    writing.run(async () => {
      const r = await writeBrief(workspaceId, page, query);
      setError(r ?? undefined);
      // The server now lists it as being written, so a reload or another tab sees the same.
      if (!r) await client.invalidateQueries({ queryKey: historyQuery(workspaceId).queryKey });
      return null;
    });
  // The page header carries the site, Change site and the run button once a site's numbers can be read.
  const site = ready && !changing ? state.data!.siteUrl : null;
  const numbers = !!sum.data && !("reason" in sum.data);
  const mayRunNow = site && numbers && manage && week.data && !(week.data.note && week.data.ranThisWeek);
  const row = mayConnect ? { ...(past.data ? rowStates(past.data) : { waiting: new Set<string>(), writing: new Set<string>() }), pending: writing.pending, onWrite: write } : undefined;

  return (
    <Page
      title={
        <>
          SEO <small className="rounded-sm border border-dashed border-faint px-2 py-0.5 align-middle font-sans text-xs font-medium text-muted-foreground">Beta</small>
        </>
      }
      description={site && `Site: ${site}`}
      actions={
        site && (
          <>
            {manage && (
              <Button variant="outline" onClick={() => setChanging(true)}>
                Change site
              </Button>
            )}
            {mayRunNow && (
              <Button pending={running.pending} onClick={() => void run()}>
                Write this week's Briefs now
              </Button>
            )}
          </>
        )
      }
    >
      {error && <Notice tone="error">{error}</Notice>}
      <QueryBoundary query={state} skeleton={<Skeleton className="h-24 w-full" />}>
        {(s) =>
          !s.connected ? (
            <div className="flex max-w-2xl flex-col items-start gap-4">
              <p>Connect Search Console so Direx can read search data for one site you pick. Direx only reads it, and never changes anything there.</p>
              {!mayConnect ? (
                <p className="text-muted-foreground">A Viewer can't connect it.</p>
              ) : s.app?.source === null ? (
                <p className="text-muted-foreground">Search Console needs a Google app first. {manage ? "Set one up below." : "Ask an Owner or Admin to set one up here."}</p>
              ) : (
                <Button pending={connecting.pending} onClick={() => void start()}>
                  Connect Search Console
                </Button>
              )}
              {manage && s.app && s.app.source !== "own" && (
                <Wizard
                  label="Google Cloud"
                  title={s.app.source === null ? "Set up a Google app for Search Console" : "Use this Workspace's own Google app (optional)"}
                  wizard={googleAppSteps(s.app.callbackUrl)}
                  save={saveOwnApp}
                />
              )}
            </div>
          ) : s.refusal ? (
            refused(s.refusal)
          ) : s.siteUrl && !changing ? (
            <QueryBoundary query={sum} skeleton={<Skeleton className="h-12 w-full" />}>
              {(total) =>
                "reason" in total ? (
                  refused(total)
                ) : (
                  <>
                    <div className="flex flex-col gap-3">
                      <dl className="flex max-w-2xl flex-wrap gap-x-12 gap-y-4">
                        {(
                          [
                            ["Clicks", "Times people clicked through from search", total.clicks, total.previous?.clicks],
                            ["Impressions", "Times you showed up in search", total.impressions, total.previous?.impressions],
                          ] as const
                        ).map(([label, hint, value, before]) => {
                          const change = changeWords(value, before, total.previous);
                          return (
                            <div key={label} className="flex flex-col gap-1">
                              <dt className="text-sm text-muted-foreground">{label}</dt>
                              <dd className="font-display text-xl tabular-nums">{n(value)}</dd>
                              {change && <dd className="text-sm text-muted-foreground tabular-nums">{change}</dd>}
                              <dd className="text-sm text-muted-foreground">{hint}</dd>
                            </div>
                          );
                        })}
                        {total.position !== null && (
                          <div className="flex flex-col gap-1">
                            <dt className="text-sm text-muted-foreground">Average rank</dt>
                            <dd className="flex items-end gap-3">
                              <span className="font-display text-xl tabular-nums">{rank(total.position)}</span>
                              <RankLine days={total.daily} />
                            </dd>
                            {rankChangeWords(total.position, total.previous?.position) && <dd className="text-sm text-muted-foreground">{rankChangeWords(total.position, total.previous?.position)}</dd>}
                            <dd className="text-sm text-muted-foreground">Where your pages placed in search, on average</dd>
                          </div>
                        )}
                      </dl>
                      <p className="text-sm text-muted-foreground">{`${dayWords(total.startDate)} to ${dayWords(total.endDate)}. Search Console data ends 3 days ago.`}</p>
                    </div>
                    <QueryBoundary query={week} skeleton={<Skeleton className="h-24 w-full" />}>
                      {(w) => <WeeksBriefs workspaceId={workspaceId} zone={zone} state={w} />}
                    </QueryBoundary>
                    <QueryBoundary query={cands} skeleton={<Skeleton className="h-64 w-full" />}>
                      {(c) => ("reason" in c ? refused(c) : <CandidateLists c={c} row={row} />)}
                    </QueryBoundary>
                    <QueryBoundary query={past} skeleton={<Skeleton className="h-24 w-full" />}>
                      {(h) => <Briefs history={h.briefs} />}
                    </QueryBoundary>
                  </>
                )
              }
            </QueryBoundary>
          ) : !manage ? (
            <EmptyState title="No site is chosen yet">Only an Admin or Owner can choose one.</EmptyState>
          ) : !s.properties?.length ? (
            <EmptyState title="No site to pick">This Google account can't see any site in Search Console. Add your site there first, then come back.</EmptyState>
          ) : (
            <form className="flex flex-wrap items-end gap-3" onSubmit={submit}>
              <Field label="Site">
                <Select name="siteUrl" defaultValue={s.siteUrl ?? s.properties[0]!.siteUrl}>
                  {s.properties.map((x) => (
                    <option key={x.siteUrl} value={x.siteUrl}>
                      {x.siteUrl}
                    </option>
                  ))}
                </Select>
              </Field>
              <Button type="submit" pending={saving.pending}>
                Save
              </Button>
            </form>
          )
        }
      </QueryBoundary>
    </Page>
  );
}

const n = (x: number) => x.toLocaleString("en");
const PageLink = (p: { url: string }) => <a href={p.url}>{pathOf(p.url)}</a>;

const NUM = "text-right tabular-nums";
const ROW = "border-t border-border align-top *:px-3 *:py-2";
/** Search Console's average position as the whole-number rank a person reads. */
const rank = (position: number) => Math.round(position);

/** A table with bare cells: each row styles its cells with ROW, as BriefView's rows do. */
function Table(p: { label: string; head: [string, boolean?][]; children: React.ReactNode }) {
  return (
    <div className="overflow-x-auto rounded-card border border-border">
      <table aria-label={p.label} className="w-full text-left text-sm">
        <thead className="bg-muted">
          <tr className="*:px-3 *:py-2 *:font-medium">
            {p.head.map(([h, num]) => (
              <th key={h} className={num ? "text-right" : undefined}>
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>{p.children}</tbody>
      </table>
    </div>
  );
}

/** One kind of candidate: its top few as table rows, how many more there are, or one line when there are none. */
function Kind<T>(p: { title: string; about: string; none: string; head: [string, boolean?][]; list: { total: number; top: T[] }; rows: (x: T, i: number) => React.ReactNode }) {
  const more = p.list.total - Math.min(SHOWN, p.list.top.length);
  return (
    <section aria-label={p.title} className={CARD}>
      <h2>{p.title}</h2>
      <p className="text-sm text-muted-foreground">{p.about}</p>
      {p.list.total === 0 ? (
        <p>{p.none}</p>
      ) : (
        <>
          <Table label={p.title} head={p.head}>
            {p.list.top.slice(0, SHOWN).map(p.rows)}
          </Table>
          {more > 0 && <p className="text-sm text-muted-foreground">{`and ${n(more)} more`}</p>}
        </>
      )}
    </section>
  );
}

/** What a candidate row needs for its Write a Brief button; absent for a Viewer. */
type RowActions = { waiting: ReadonlySet<string>; writing: ReadonlySet<string>; pending: boolean; onWrite: (page: string, query: string) => Promise<unknown> };

/** A row's Write a Brief, or why there's none: one already waits, or this one is being written. */
function WriteCell({ row, page, query }: { row?: RowActions; page: string; query: string }) {
  if (!row) return null;
  const k = waitingKey(page, query);
  return (
    <td className="text-right">
      {row.waiting.has(k) || row.writing.has(k) ? (
        <Button size="sm" variant="outline" disabled>
          {row.waiting.has(k) ? "Brief waiting on you" : "Writing the Brief"}
        </Button>
      ) : (
        <Button size="sm" pending={row.pending} onClick={() => void row.onWrite(page, query)}>
          Write a Brief
        </Button>
      )}
    </td>
  );
}

/** Each day's average rank as a small line, with a better rank drawn higher. Decoration: the number beside it says it. */
function RankLine({ days }: { days: { date: string; position: number }[] }) {
  if (days.length < 2) return null;
  const [w, h] = [96, 28];
  const ranks = days.map((d) => d.position);
  const [best, worst] = [Math.min(...ranks), Math.max(...ranks)];
  const y = (r: number) => (worst === best ? h / 2 : 2 + ((r - best) / (worst - best)) * (h - 4));
  const points = days.map((d, i) => `${((i / (days.length - 1)) * w).toFixed(1)},${y(d.position).toFixed(1)}`).join(" ");
  return (
    <svg aria-hidden width={w} height={h} viewBox={`0 0 ${w} ${h}`} className="text-muted-foreground">
      <polyline points={points} fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" />
    </svg>
  );
}

/** A pair's rank in the 28 days before, or that it wasn't shown then. */
function RankBefore({ position }: { position: number | null }) {
  return <td className={NUM}>{position === null ? <span className="text-muted-foreground">Not shown</span> : rank(position)}</td>;
}

/** What the weekly Briefs choose from, each row with Write a Brief. Brand searches are left out. */
function CandidateLists({ c, row }: { c: Candidates; row?: RowActions }) {
  const act: [string, boolean?][] = row ? [[""]] : [];
  return (
    <>
      <Kind
        title="Close to page one: small wins"
        about="Searches where a page ranks 8 to 20, so a few places would put it on page one."
        none="No search has a page ranked 8 to 20 that showed up 20 or more times."
        head={[["Search"], ["Page"], ["Shown", true], ["Rank now", true], ["28 days ago", true], ...act]}
        list={c.nearPageOne}
        rows={(x, i) => (
          <tr key={i} className={ROW}>
            <td>{x.query}</td>
            <td>
              <PageLink url={x.page} />
            </td>
            <td className={NUM}>{n(x.impressions)}</td>
            <td className={NUM}>{rank(x.position)}</td>
            <RankBefore position={x.positionBefore} />
            <WriteCell row={row} page={x.page} query={x.query} />
          </tr>
        )}
      />
      <Kind
        title="Losing traffic"
        about={`Pages shown 30% less or worse, ${dayWords(c.previous.startDate)} to ${dayWords(c.previous.endDate)} against the 28 days since.`}
        none="No page is shown 30% less than before."
        head={[["Page"], ["Top search"], ["Shown before", true], ["Shown now", true], ...act]}
        list={c.slipping}
        rows={(x, i) => (
          <tr key={i} className={ROW}>
            <td>
              <PageLink url={x.page} />
            </td>
            <td>{x.query}</td>
            <td className={NUM}>{n(x.impressionsBefore)}</td>
            <td className={NUM}>{n(x.impressionsNow)}</td>
            <WriteCell row={row} page={x.page} query={x.query} />
          </tr>
        )}
      />
      <Kind
        title="Two of your pages competing for the same search"
        about="Searches where two or more of your pages each showed up 10 or more times."
        none="No search has two of your pages competing for it."
        head={[["Search"], ["Page"], ["Shown", true], ["Rank now", true], ["28 days ago", true], ...act]}
        list={c.competing}
        rows={(x, i) =>
          x.pages.map((pg, j) => (
            <tr key={`${i}-${pg.page}`} className={ROW}>
              <td>{j === 0 ? x.query : ""}</td>
              <td>
                <PageLink url={pg.page} />
              </td>
              <td className={NUM}>{n(pg.impressions)}</td>
              <td className={NUM}>{rank(pg.position)}</td>
              <RankBefore position={pg.positionBefore} />
              {/* A competing search's Brief is for its top page, which names the others. */}
              {j === 0 ? <WriteCell row={row} page={pg.page} query={x.query} /> : row && <td />}
            </tr>
          ))
        }
      />
    </>
  );
}

/** This week's Briefs: what's being written and what couldn't be read. The button to start them early is in the page header. */
function WeeksBriefs(p: { workspaceId: string; zone: string; state: BriefsState }) {
  const { note, ranThisWeek } = p.state;
  const at = note && momentWords(note.at, p.zone);
  return (
    <section aria-label="This week's Briefs" className={CARD}>
      <h2>This week's Briefs</h2>
      <p className="text-sm text-muted-foreground">Each Monday Direx writes up to 3 Briefs from the lists below. Each one quotes the page and waits for you in Review.</p>
      {note && ranThisWeek ? (
        <>
          {note.started.length > 0 ? (
            <>
              <p>{`Started ${at!.day}${note.by === "person" ? " by hand" : ""}. They appear in Review when they're written:`}</p>
              <Table label="Briefs started" head={[["Page"], ["Search"]]}>
                {note.started.map((b) => (
                  <tr key={b.page} className={ROW}>
                    <td>
                      <PageLink url={b.page} />
                    </td>
                    <td>{b.query}</td>
                  </tr>
                ))}
              </Table>
              <p>
                <Link to="/w/$workspaceId/review" params={{ workspaceId: p.workspaceId }}>Open Review</Link>
              </p>
            </>
          ) : (
            <p>
              {note.stopped
                ? stoppedWords(note.stopped)
                : `This week's run began at ${at!.clock} ${p.zone} time and hasn't started a Brief yet. It may still be going. If not, there's nothing new to brief this week: every page listed already has a recent Brief. You can run it again 10 minutes after it began.`}
            </p>
          )}
          {note.skipped.length > 0 && (
            <ul aria-label="Pages not read" className="flex flex-col gap-2 text-sm text-muted-foreground">
              {note.skipped.map((s) => (
                <li key={s.page}>
                  <PageLink url={s.page} />
                  {`: not read, because ${skippedWords(s.reason)}.`}
                </li>
              ))}
            </ul>
          )}
        </>
      ) : (
        <p className="text-muted-foreground">This week's Briefs haven't been written yet.</p>
      )}
    </section>
  );
}

/** Every Brief so far, newest first: where it stands, the clicks that picked it, and whether it helped. */
function Briefs({ history }: { history: BriefHistory[] }) {
  const today = new Date().toISOString().slice(0, 10);
  return (
    <section aria-label="Briefs" className={CARD}>
      <h2>Briefs</h2>
      <p className="text-sm text-muted-foreground">Clicks before are for the search on the page over the 28 days that picked the Brief. Whether it helped shows 28 days after you approve it.</p>
      {history.length === 0 ? (
        <p>No Briefs yet.</p>
      ) : (
        <Table label="Briefs" head={[["Page"], ["Search"], ["Written"], ["State"], ["Clicks before", true], ["Clicks after", true], ["Did it help"]]}>
          {history.map((b) => (
            <tr key={b.itemId} className={ROW}>
              <td>
                <PageLink url={b.page} />
              </td>
              <td>{b.query}</td>
              <td>{dayWords(b.createdAt.slice(0, 10))}</td>
              <td>
                <StateChip state={b.state} />
              </td>
              <td className={NUM}>{b.before ? n(b.before.clicks) : ""}</td>
              <td className={NUM}>{b.after === null ? "" : n(b.after)}</td>
              <td>{helpedWords(b, today)}</td>
            </tr>
          ))}
        </Table>
      )}
    </section>
  );
}
