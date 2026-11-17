// SPDX-License-Identifier: AGPL-3.0-only
import { useState } from "react";
import { DropdownMenu, type DropdownMenuItemData } from "@astryxdesign/core/DropdownMenu";
import { Dialog, DialogHeader } from "@astryxdesign/core/Dialog";
import { Table, TableBody, TableCell, TableHeader, TableHeaderCell, TableRow } from "@astryxdesign/core/Table";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { inWorkspace } from "../api/query";
import { EmptyState, Field, Notice, Page } from "../components/layout";
import { PAGE } from "../components/FilterList";
import { QueryBoundary } from "../components/QueryBoundary";
import { EllipsisIcon } from "lucide-react";
import { Button } from "@/components/Button";
import { buttonVariants } from "@/components/native";
import { Input, Select, Textarea } from "@/components/Input";
import { Skeleton } from "@astryxdesign/core/Skeleton";
import { toast } from "@/components/toast";
import { mayApprove, mayEdit, type Role } from "../items/actions";
import { STATE_STYLE } from "../items/StateChip";
import { Link } from "@tanstack/react-router";
import { dayWords, momentWords } from "../campaigns/actions";
import { addHold, addPerson, addSuppression, endHold, mailboxesQuery, outreachQuery, personHolds, releaseHold, BASIS_WORDS, recordWords, say, SENDER_COUNTRY_NOTE, undoOptOut, verdict, warningWords, writeEmail, type Basis, type EntityType, type Overview, type Verdict } from "./actions";
import { COUNTRIES } from "./countries";
import { Touches } from "./Touches";

const BASES: { value: Basis; label: string }[] = [
  { value: "published_address", label: BASIS_WORDS.published_address },
  { value: "legitimate_interest", label: BASIS_WORDS.legitimate_interest },
  { value: "implied", label: BASIS_WORDS.implied },
  { value: "consent", label: BASIS_WORDS.consent },
];
const ENTITIES: { value: EntityType; label: string }[] = [
  { value: "unknown", label: "Don't know" },
  { value: "corporate", label: "Company" },
  { value: "sole_trader", label: "Sole trader" },
  { value: "partnership", label: "Partnership" },
];
const FORM = "flex flex-wrap items-end gap-3";
type Person = Overview["people"][number];
type Ask = { title: string; body: string; confirm: string; reason?: boolean; run: (reason: string) => Promise<unknown> };

/** Each verdict in the Item chips' colours and shapes: green and a check, Held's linen and bars, Blocked's diamond. */
const VERDICT: Record<Verdict["kind"], { label: string; chip: string; mark: string; bar: string }> = {
  yes: { label: "Can be emailed", chip: STATE_STYLE.sent, mark: "h-2 w-1 rotate-45 border-r-2 border-b-2 border-current", bar: "bg-success" },
  not_now: { label: "Not now", chip: STATE_STYLE.held, mark: "h-2 w-1.5 border-x-2 border-current", bar: "bg-faint" },
  stop: { label: "Asked to stop", chip: STATE_STYLE.blocked, mark: "size-1.5 rotate-45 bg-current", bar: "bg-muted-foreground" },
};
const KINDS = Object.keys(VERDICT) as Verdict["kind"][];

/** A country select whose value is the two-letter code; `none` is the empty choice's words. */
function CountrySelect(p: { name: string; defaultValue?: string; none: string }) {
  return (
    <Select name={p.name} defaultValue={p.defaultValue ?? ""} className="min-w-56">
      <option value="">{p.none}</option>
      {COUNTRIES.map((c) => (
        <option key={c.code} value={c.code}>
          {c.name}
        </option>
      ))}
    </Select>
  );
}

/**
 * People: everyone this Workspace may write to and whether Direx can email them today. What to do about one
 * Person is in their row's menu; who is sending and the CRM webhook are in Settings. Nothing is sent from here.
 */
export function Outreach(p: { workspaceId: string; role: Role; initial?: { data: Overview; boxes: { id: string; name: string }[] } }) {
  const { workspaceId, role } = p;
  const client = useQueryClient();
  const outreach = useQuery({ ...outreachQuery(workspaceId), initialData: p.initial?.data });
  const boxes = useQuery({ ...mailboxesQuery(workspaceId), initialData: p.initial?.boxes });
  // Which action is running, and which one was refused, so each shows by its own button.
  const [busy, setBusy] = useState<string>();
  const [failed, setFailed] = useState<{ at: string; text: string }>();
  const reload = () => client.invalidateQueries({ queryKey: inWorkspace(workspaceId) });
  const act = async (at: string, done: string | (() => string), fn: () => Promise<string | null>) => {
    setBusy(at);
    setFailed(undefined);
    try {
      const error = await fn();
      if (error) setFailed({ at, text: say(error) });
      else toast.add({ title: typeof done === "string" ? done : done() });
      await reload();
      return error;
    } finally {
      setBusy(undefined);
    }
  };
  const refused = (at: string) => failed?.at === at && <Notice tone="error">{failed.text}</Notice>;

  const run = (at: string, done: string, fn: (f: FormData) => Promise<string | null>) => async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const form = e.currentTarget;
    if (!(await act(at, done, () => fn(new FormData(form))))) form.reset();
  };
  const text = (f: FormData, k: string) => String(f.get(k) ?? "");
  const canEdit = mayEdit(role);
  const canApprove = mayApprove(role);
  const isAdmin = role === "owner" || role === "admin";
  // Stopping a certain hold leaves the 90-day wait, so it still shows afterwards; that is the point.
  const endAll = async (personId: string) => {
    const running = await personHolds(workspaceId, personId);
    if (!running?.holds.length) return toast.add({ title: "Nothing is running. The 90-day wait after a hold can't be cut short." });
    await act("row", "Stopped holding. Cold email stays off for 90 more days.", async () => {
      for (const h of running.holds) {
        const error = await endHold(workspaceId, h.id);
        if (error) return error;
      }
      return null;
    });
  };

  // One confirm for every row's menu, since a menu item can't carry its own dialog.
  const [ask, setAsk] = useState<Ask>();
  const [asking, setAsking] = useState(false);
  // Write an email or log a call for the Person whose menu opened it.
  const [open, setOpen] = useState<{ kind: "write" | "log"; person: Person }>();
  // Add a Person: email and country first, the rest under More details.
  const [adding, setAdding] = useState(false);
  const openAdd = () => {
    setFailed(undefined);
    setAdding(true);
  };

  /** One row's menu, in the order a marketer reaches for it. One word pair for a hold: "We're talking to them" and "Stop holding". */
  const menu = (x: Person): DropdownMenuItemData[] => {
    const items: (DropdownMenuItemData | false)[] = [
      !x.suppressed && canEdit && { id: "write", label: "Write an email", onClick: () => setOpen({ kind: "write", person: x }) },
      !x.suppressed && canEdit && { id: "call", label: "Log a call or message", onClick: () => setOpen({ kind: "log", person: x }) },
      !x.suppressed &&
        !x.hold &&
        canApprove && {
          id: "hold",
          label: "We're talking to them",
          onClick: () =>
            setAsk({
              title: `Are you talking to ${x.email}?`,
              body: "Their Campaigns stop, and no cold email goes to them until 90 days after you stop holding.",
              confirm: "We're talking to them",
              run: () => act("row", "Their Campaigns stopped.", () => addHold(workspaceId, x.id, "Marked on People")),
            }),
        },
      !!x.hold?.release &&
        canApprove && {
          id: "release",
          label: "Stop holding",
          onClick: () => void act("row", "Stopped holding. Anything it held is checked again before it sends.", () => releaseHold(workspaceId, x.id, x.hold!.release!)),
        },
      x.hold?.reason === "in_conversation" &&
        !x.hold.waitUntil &&
        isAdmin && {
          id: "end",
          label: "Stop holding",
          onClick: () =>
            setAsk({
              title: `Stop holding ${x.email}?`,
              body: "Their Campaigns can resume. Cold email stays off for 90 more days.",
              confirm: "Stop holding",
              run: () => endAll(x.id),
            }),
        },
      !x.suppressed &&
        canEdit && {
          id: "stop",
          label: "Asked to stop",
          onClick: () =>
            setAsk({
              title: `Did ${x.email} ask to stop?`,
              body: "This address gets no more email from this Workspace, from any Campaign.",
              confirm: "Record it",
              run: () => act("row", "Recorded. This address gets no more email.", () => addSuppression(workspaceId, x.email)),
            }),
        },
      x.suppressedBecause === "reply" &&
        role === "owner" && {
          id: "undo",
          label: "Reply misread?",
          onClick: () =>
            setAsk({
              title: `Undo the opt-out for ${x.email}?`,
              body: "Only if the reply was misread. Mail can reach them again, and your reason is kept. A send that was blocked stays blocked.",
              confirm: "Undo opt-out",
              reason: true,
              run: (reason) => act("row", "Undone. Write a new email if you mean to.", () => undoOptOut(workspaceId, x.id, reason)),
            }),
        },
    ];
    return items.filter((i) => !!i);
  };

  const people = outreach.data?.people ?? [];
  return (
    <Page
      title="People"
      description="Everyone this Workspace may write to, and whether Direx can email them today."
      actions={
        people.length > 0 && (
          <>
            {canEdit && (
              <Button variant="outline" onClick={openAdd}>
                Add a Person
              </Button>
            )}
            <Link to="/w/$workspaceId/people/find" params={{ workspaceId }} className={buttonVariants()}>
              Find companies
            </Link>
          </>
        )
      }
    >
      <QueryBoundary query={outreach} skeleton={<Skeleton className="h-96 w-full" />}>
        {(data) => (
          <div className="flex flex-col gap-6">
            {(!data.senderName || !data.postalAddress) && (
              <Notice>
                Emails can&apos;t go out until you add who is sending.{" "}
                <Link to="/w/$workspaceId/settings/sending" params={{ workspaceId }} className="underline underline-offset-4">
                  Add who is sending
                </Link>
              </Notice>
            )}
            {data.people.length === 0 ? (
              <EmptyState
                title="No People yet"
                action={
                  <div className="flex flex-wrap gap-2">
                    <Link to="/w/$workspaceId/people/find" params={{ workspaceId }} className={buttonVariants()}>
                      Find companies
                    </Link>
                    {canEdit && (
                      <Button variant="outline" onClick={openAdd}>
                        Add a Person
                      </Button>
                    )}
                  </div>
                }
              >
                Find companies that fit your plan, then keep the people there you want to write to.
              </EmptyState>
            ) : (
              <>
                <Summary people={data.people} />
                {!data.senderCountry && <p className="text-sm text-muted-foreground">{SENDER_COUNTRY_NOTE}</p>}
                {refused("row")}
                <PeopleTable workspaceId={workspaceId} people={data.people} menu={menu} />
              </>
            )}
            {canEdit && (
              <div className="flex flex-col gap-3">
                <details className="group">
                  <summary className="cursor-pointer font-medium group-open:mb-3">Someone not listed asked to stop</summary>
                  <form className={FORM} onSubmit={run("opt-out", "Recorded. This address gets no more email.", (f) => addSuppression(workspaceId, text(f, "email")))}>
                    <Field label="Their email">
                      <Input name="email" type="email" required autoComplete="off" spellCheck={false} />
                    </Field>
                    <Button type="submit" variant="outline" pending={busy === "opt-out"}>
                      Record it
                    </Button>
                  </form>
                </details>
                {refused("opt-out")}
              </div>
            )}
            <p className="text-sm text-muted-foreground">
              Who emails go out from, and deals from your CRM, are in{" "}
              <Link to="/w/$workspaceId/settings/sending" params={{ workspaceId }} className="underline underline-offset-4">
                Settings, Who is sending
              </Link>
              .
            </p>
          </div>
        )}
      </QueryBoundary>

      {canEdit && (
        <Dialog isOpen={adding} onOpenChange={setAdding} purpose="form" width={640}>
          <DialogHeader title="Add a Person" />
          <form
            className="flex flex-col gap-4 pt-4"
            // A required field under More details opens it, so the browser can point at what is missing.
            onInvalidCapture={(e) => {
              const more = (e.target as HTMLElement).closest("details");
              if (more) more.open = true;
            }}
            onSubmit={async (e) => {
              e.preventDefault();
              const f = new FormData(e.currentTarget);
              let updated = false;
              const error = await act(
                "add",
                () => (updated ? "Updated. That email was already here, so its record was replaced." : "Added."),
                async () => {
                  if (!text(f, "country")) return "no_country";
                  const r = await addPerson(workspaceId, {
                    email: text(f, "email"),
                    country: text(f, "country"),
                    basis: text(f, "basis") as Basis,
                    evidence: text(f, "evidence"),
                    entityType: text(f, "entityType") as EntityType,
                    scope: text(f, "scope") || null,
                    expiresAt: text(f, "expiresAt") || null,
                  });
                  updated = r.updated;
                  return r.error;
                },
              );
              if (!error) setAdding(false);
            }}
          >
            <div className={FORM}>
              <Field label="Email">
                <Input name="email" type="email" required autoComplete="off" spellCheck={false} autoFocus />
              </Field>
              <Field label="Country">
                <CountrySelect name="country" none="Choose a country" />
              </Field>
            </div>
            <details className="group">
              <summary className="cursor-pointer font-medium group-open:mb-3">More details</summary>
              <div className={FORM}>
                <Field label="Why you may contact them">
                  <Select name="basis">
                    {BASES.map((b) => (
                      <option key={b.value} value={b.value}>
                        {b.label}
                      </option>
                    ))}
                  </Select>
                </Field>
                <Field label="Where it came from">
                  {/* True of every Person added here; replace it with the page or list the address came from. */}
                  <Input name="evidence" defaultValue="Added by hand" required />
                </Field>
                <Field label="Type of business">
                  <Select name="entityType">
                    {ENTITIES.map((b) => (
                      <option key={b.value} value={b.value}>
                        {b.label}
                      </option>
                    ))}
                  </Select>
                </Field>
                <Field label="What it covers (a note for you; Direx doesn't check it)">
                  <Input name="scope" maxLength={500} />
                </Field>
                <Field label="That reason ends on">
                  <Input name="expiresAt" type="date" />
                </Field>
              </div>
            </details>
            {refused("add")}
            <div className="flex justify-end gap-2">
              <Button type="button" variant="outline" onClick={() => setAdding(false)}>
                Cancel
              </Button>
              <Button type="submit" pending={busy === "add"}>
                Add Person
              </Button>
            </div>
          </form>
        </Dialog>
      )}

      <Dialog isOpen={!!ask} onOpenChange={(o) => !o && setAsk(undefined)} purpose="form" width={384}>
        <DialogHeader title={ask?.title ?? ""} subtitle={ask?.body} />
        <form
          className="flex flex-col gap-4 pt-4"
          onSubmit={(e) => {
            e.preventDefault();
            const reason = String(new FormData(e.currentTarget).get("reason") ?? "");
            setAsking(true);
            void ask
              ?.run(reason)
              .finally(() => {
                setAsking(false);
                setAsk(undefined);
              });
          }}
        >
          {ask?.reason && (
            <Field label="Why">
              <Input name="reason" maxLength={1000} required />
            </Field>
          )}
          <div className="flex justify-end gap-2">
            <Button type="button" variant="outline" onClick={() => setAsk(undefined)}>
              Cancel
            </Button>
            <Button type="submit" pending={asking}>
              {ask?.confirm}
            </Button>
          </div>
        </form>
      </Dialog>

      <Dialog isOpen={!!open} onOpenChange={(o) => !o && setOpen(undefined)} purpose="form" width={640}>
        <DialogHeader title={open ? (open.kind === "write" ? `Write to ${open.person.email}` : (open.person.name ?? open.person.email)) : ""} subtitle={open?.kind === "write" ? "It waits in Needs approval. Nothing is sent from here." : undefined} />
        {open?.kind === "log" && <Touches workspaceId={workspaceId} people={[open.person]} canEdit={canEdit} />}
        {open?.kind === "write" && (
          <QueryBoundary query={boxes} skeleton={<Skeleton className="h-64 w-full" />}>
            {(list) => (
              <form
                className="flex flex-col gap-4 pt-4"
                onSubmit={async (e) => {
                  e.preventDefault();
                  if (!list.length) return;
                  const f = new FormData(e.currentTarget);
                  const error = await act("write", "Written. It's waiting in Needs approval.", () =>
                    writeEmail(workspaceId, {
                      personId: open.person.id,
                      credentialId: text(f, "credentialId"),
                      touchClass: text(f, "touchClass") as "cold" | "consented_marketing",
                      subject: text(f, "subject"),
                      text: text(f, "text"),
                    }),
                  );
                  if (!error) setOpen(undefined);
                }}
              >
                {list.length === 0 && (
                  <Notice tone="error">
                    Connect a Mailbox first, in{" "}
                    <Link to="/w/$workspaceId/settings/credentials" params={{ workspaceId }} className="underline underline-offset-4">
                      Settings, Email and keys
                    </Link>
                    . Emails go from a Mailbox.
                  </Notice>
                )}
                <div className={FORM}>
                  <Field label="From">
                    <Select name="credentialId" required>
                      {list.map((b) => (
                        <option key={b.id} value={b.id}>
                          {b.name}
                        </option>
                      ))}
                    </Select>
                  </Field>
                  <Field label="Have they agreed to hear from you?">
                    <Select name="touchClass">
                      <option value="cold">No, this is a first email</option>
                      <option value="consented_marketing">Yes, they signed up</option>
                    </Select>
                  </Field>
                </div>
                <Field label="Subject">
                  <Input name="subject" required />
                </Field>
                <Field label="Message">
                  <Textarea name="text" rows={8} required />
                </Field>
                {refused("write")}
                <div className="flex justify-end gap-2">
                  <Button type="button" variant="outline" onClick={() => setOpen(undefined)}>
                    Cancel
                  </Button>
                  <Button type="submit" pending={busy === "write"} disabled={list.length === 0}>
                    Send for approval
                  </Button>
                </div>
              </form>
            )}
          </QueryBoundary>
        )}
      </Dialog>
    </Page>
  );
}

/** A verdict as a chip, with its name always written so colour is never the only signal. */
function VerdictChip(p: { kind: Verdict["kind"]; label: string }) {
  const look = VERDICT[p.kind];
  return (
    <span className={`inline-flex max-w-full items-center gap-1.5 rounded-sm border px-2 py-0.5 text-xs leading-tight font-medium whitespace-nowrap ${look.chip}`}>
      <span aria-hidden className={`shrink-0 ${look.mark}`} />
      {p.label}
    </span>
  );
}

/**
 * The total, split by verdict, with why the rest can't be emailed now. No 30-day growth and no split by
 * source: the overview carries neither when each Person was added nor where they came from.
 */
function Summary(p: { people: Person[] }) {
  const verdicts = p.people.map((x) => verdict(x));
  const of = (k: Verdict["kind"]) => verdicts.filter((v) => v.kind === k);
  const groups = (vs: Verdict[]) => {
    const n = new Map<string, number>();
    for (const v of vs) if (v.group) n.set(v.group, (n.get(v.group) ?? 0) + 1);
    return [...n].map(([g, c]) => `${c.toLocaleString()} ${g}`).join(" · ");
  };
  const sub: Record<Verdict["kind"], string> = { yes: "", not_now: groups(of("not_now")), stop: groups(of("stop")) || "Never emailed again" };
  return (
    <section aria-label="Who can be emailed" className="flex flex-col gap-4 rounded-card border border-border bg-card p-5">
      <p className="font-display text-xl tabular-nums">
        {p.people.length.toLocaleString()} <span className="font-sans text-sm text-muted-foreground">{p.people.length === 1 ? "Person" : "People"}</span>
      </p>
      <div aria-hidden className="flex h-2 overflow-hidden rounded-sm bg-muted">
        {KINDS.map((k) => (
          // Computed layout: each verdict's share of the bar.
          <span key={k} className={VERDICT[k].bar} style={{ width: `${(of(k).length / p.people.length) * 100}%` }} />
        ))}
      </div>
      <dl className="grid gap-4 sm:grid-cols-3">
        {KINDS.map((k) => (
          <div key={k} className="flex flex-col gap-0.5">
            <dt className="flex items-center gap-2 text-sm">
              <span aria-hidden className={`size-2 rounded-sm ${VERDICT[k].bar}`} />
              {VERDICT[k].label}
            </dt>
            <dd className="font-medium tabular-nums">{of(k).length.toLocaleString()}</dd>
            {sub[k] && <dd className="text-sm text-muted-foreground">{sub[k]}</dd>}
          </div>
        ))}
      </dl>
    </section>
  );
}

/** People, one row each: whether Direx can email them and why, who they are, the latest Campaign, the last email and whether they replied. */
function PeopleTable(p: { workspaceId: string; people: Person[]; menu: (x: Person) => DropdownMenuItemData[] }) {
  // FilterList's chips and search, over table rows rather than its list blocks.
  const [filter, setFilter] = useState<string>();
  const [search, setSearch] = useState("");
  const [shown, setShown] = useState(PAGE);
  const filters = [
    ...KINDS.map((k) => ({ label: VERDICT[k].label, test: (x: Person) => verdict(x).kind === k })),
    { label: "Newsletter", test: (x: Person) => !!x.newsletterSince },
  ];
  const active = filters.find((f) => f.label === filter);
  const words = search.trim().toLowerCase();
  const rows = p.people.filter((x) => (!active || active.test(x)) && (!words || `${x.email} ${x.name ?? ""} ${x.company ?? ""}`.toLowerCase().includes(words)));
  // Pills, not buttons, so a filter never looks like an action (DESIGN.md, Radius).
  const chip = (label: string, n: number, on: boolean, pick: () => void) => (
    <button key={label} type="button" aria-pressed={on} onClick={pick} className={`h-8 rounded-full px-3 text-sm font-medium tabular-nums ${on ? "bg-foreground text-background" : "border border-border bg-card hover:bg-muted"}`}>
      {`${label} ${n.toLocaleString()}`}
    </button>
  );
  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2">
        <div role="group" aria-label="Filter" className="flex flex-wrap gap-2">
          {chip("All", p.people.length, !active, () => setFilter(undefined))}
          {filters.map((f) => chip(f.label, p.people.filter(f.test).length, f.label === filter, () => setFilter(f.label === filter ? undefined : f.label)))}
        </div>
        <Input type="search" aria-label="Search People" placeholder="Name, email or company" className="min-w-48 flex-1" value={search} onChange={(e) => setSearch(e.target.value)} />
      </div>
      <p role="status" className="text-sm text-muted-foreground">
        {rows.length === p.people.length ? `${rows.length.toLocaleString()} ${rows.length === 1 ? "Person" : "People"}` : `${rows.length.toLocaleString()} of ${p.people.length.toLocaleString()} People`}
      </p>
      {rows.length === 0 ? (
        <p className="text-muted-foreground">No People match.</p>
      ) : (
        // Tables are 14px; the rest of the page stays at 15px.
        <div className="overflow-x-auto text-sm">
          {/* Columns split the width evenly unless sized, so the menu column is narrow and Person gets the room. */}
          <Table aria-label="People" className="min-w-3xl">
            <TableHeader>
              <TableRow>
                <TableHeaderCell className="w-1/4">Person</TableHeaderCell>
                <TableHeaderCell>Can email?</TableHeaderCell>
                <TableHeaderCell>Allowed by</TableHeaderCell>
                {/* Narrow screens drop these two; the company moves under the person. */}
                <TableHeaderCell className="hidden lg:table-cell">Company</TableHeaderCell>
                <TableHeaderCell className="hidden lg:table-cell">Campaign</TableHeaderCell>
                <TableHeaderCell>Last email</TableHeaderCell>
                <TableHeaderCell>Reply</TableHeaderCell>
                {/* Astryx gives header cells max-width 0 for truncation, which would shrink the menu column to nothing.
                    Relative so the hidden label stays inside the scroll box instead of widening the page on phones. */}
                <TableHeaderCell style={{ width: "4.5rem", maxWidth: "none", position: "relative" }}>
                  <span className="sr-only">Actions</span>
                </TableHeaderCell>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.slice(0, shown).map((x) => {
                const items = p.menu(x);
                const v = verdict(x);
                const warnings = x.suppressed ? [] : warningWords(x, true);
                return (
                  <TableRow key={x.id}>
                    <TableCell className="wrap-break-word whitespace-normal">
                      <div className="flex flex-col">
                        {x.name && <span className="font-medium">{x.name}</span>}
                        <span className={x.name ? "text-muted-foreground" : "font-medium"}>{x.email}</span>
                        {x.company && <span className="text-muted-foreground lg:hidden">{x.company}</span>}
                      </div>
                    </TableCell>
                    <TableCell className="whitespace-normal">
                      <div className="flex flex-col items-start gap-1">
                        <VerdictChip kind={v.kind} label={v.label} />
                        {/* A quoted reply can run long: two lines here, the whole of it on hover and in the Item. */}
                        {v.reason && (
                          <span title={v.reason} className="line-clamp-2 text-muted-foreground">
                            {v.reason}
                          </span>
                        )}
                      </div>
                    </TableCell>
                    <TableCell className="whitespace-normal">
                      <div className="flex flex-col gap-1">
                        {x.suppressed ? <span className="text-muted-foreground">No longer applies</span> : <span>{recordWords(x)}</span>}
                        {warnings.length > 0 && (
                          <details className="text-muted-foreground">
                            <summary className="cursor-pointer">To check ({warnings.length})</summary>
                            {warnings.map((w) => (
                              <p key={w}>{w}</p>
                            ))}
                          </details>
                        )}
                        {x.newsletterSince && (
                          <details className="text-muted-foreground">
                            <summary className="cursor-pointer">Newsletter subscriber</summary>
                            Since {dayWords(x.newsletterSince.slice(0, 10))}, so no cold email without your yes.
                          </details>
                        )}
                      </div>
                    </TableCell>
                    <TableCell className="hidden whitespace-normal lg:table-cell">{x.company ?? <span className="text-muted-foreground">Not known</span>}</TableCell>
                    <TableCell className="hidden whitespace-normal lg:table-cell">
                      {x.campaign ? (
                        <Link to="/w/$workspaceId/campaigns/$campaignId" params={{ workspaceId: p.workspaceId, campaignId: x.campaign.id }} className="underline underline-offset-4">
                          {x.campaign.title}
                        </Link>
                      ) : (
                        <span className="text-muted-foreground">None</span>
                      )}
                    </TableCell>
                    <TableCell className="whitespace-normal tabular-nums">{x.lastEmailAt ? momentWords(x.lastEmailAt) : <span className="text-muted-foreground">Never</span>}</TableCell>
                    <TableCell className={x.replied ? "whitespace-normal" : "whitespace-normal text-muted-foreground"}>{x.replied ? "Replied" : "No reply"}</TableCell>
                    <TableCell>{items.length > 0 && <DropdownMenu button={{ label: `Actions for ${x.email}`, icon: <EllipsisIcon aria-hidden className="size-4" />, isIconOnly: true, variant: "ghost", size: "sm" }} items={items} />}</TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </div>
      )}
      {rows.length > shown && (
        <Button variant="outline" size="sm" className="self-start" onClick={() => setShown(shown + PAGE)}>
          {`Show ${Math.min(PAGE, rows.length - shown).toLocaleString()} more`}
        </Button>
      )}
    </div>
  );
}
