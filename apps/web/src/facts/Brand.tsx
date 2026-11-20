// SPDX-License-Identifier: AGPL-3.0-only
import { Confirm } from "../components/Confirm";
import { useRef, useState, type ReactNode } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { inWorkspace } from "../api/query";
import { messageForCode } from "../api/messages";
import { Field as Labelled, Notice, Page, Section } from "../components/layout";
import { QueryBoundary } from "../components/QueryBoundary";
import { Button } from "@/components/Button";
import { Input, Textarea } from "@/components/Input";
import { Skeleton } from "@astryxdesign/core/Skeleton";
import type { Run } from "../agents/actions";
import { Runs } from "../agents/Runs";
import { approve, cancel, ITEM_MESSAGES, mayApprove, mayEdit, type Item, type Role } from "../items/actions";
import { Strategy } from "../plans/Strategy";
import { Voice } from "./Voice";
import { Lessons } from "../lessons/Lessons";
import { Competitors } from "./Competitors";
import { factItemsQuery, factsQuery, FIELD_LABEL, retire, save, SINGLE, sourceLabel, suggest, versionsQuery, type Fact, type Field, type NewValue } from "./actions";

// Approving a conflict or proposal goes through its Item, so the Item codes apply here too.
const say = (code: string) => messageForCode(code, { ...ITEM_MESSAGES, blank_value: "Write something first.", value_too_long: "That's too long. A fact takes up to 1,000 characters." });

const day = (iso: string) => new Date(iso).toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" });

/** Says how sure Direx is when it isn't; a fact a person typed is always "high", so this shows only for what Direx read. */
const UNSURE: Record<Fact["confidence"], string | null> = { low: "Direx isn't sure about this", medium: "Direx is fairly sure", high: null };

/** The peach "needs you" mark, the same one an Item waiting for approval wears. */
const NeedsYou = () => <span className="inline-flex shrink-0 items-center rounded-sm bg-peach px-2 py-0.5 text-xs font-medium text-peach-foreground">Needs a decision</span>;

/** Where a fact came from, when Direx read it, and how sure it is: the reason a marketer can trust it. */
function Source({ f }: { f: Fact }) {
  const s = f.source;
  return (
    <p className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm text-muted-foreground">
      {s.url ? (
        <a href={s.url} target="_blank" rel="noreferrer" className="underline underline-offset-2">
          {sourceLabel(s)}
        </a>
      ) : (
        <span>{sourceLabel(s)}</span>
      )}
      {s.retrievedAt && <span>{`Read ${day(s.retrievedAt)}`}</span>}
      {UNSURE[f.confidence] && <span>{UNSURE[f.confidence]}</span>}
      {!f.usable && <NeedsYou />}
    </p>
  );
}

/** Earlier versions of a fact, read only once someone opens it. The API sends every version, so the one shown above is left out. */
function History(p: { workspaceId: string; id: string; version: number }) {
  const [open, setOpen] = useState(false);
  const rows = useQuery({ ...versionsQuery(p.workspaceId, p.id), enabled: open, select: (all) => all.filter((v) => v.version !== p.version) });
  return (
    <details className="text-sm" open={open} onToggle={(e) => setOpen(e.currentTarget.open)}>
      <summary className="cursor-pointer py-1 text-muted-foreground">History</summary>
      {rows.isError && <p className="mt-2 text-muted-foreground">Direx couldn't read the history just now.</p>}
      {rows.data?.length === 0 && <p className="mt-2 text-muted-foreground">No earlier versions.</p>}
      <ol className="mt-2 flex flex-col gap-1 pl-4 wrap-break-word">
        {rows.data?.map((v) => (
          <li key={v.version}>{`${v.value} (${sourceLabel(v.source)}, ${day(v.at)})`}</li>
        ))}
      </ol>
    </details>
  );
}

/** An example per field, shown in an empty box so a first fact has a shape to follow. */
const EXAMPLE: Record<Field, string> = {
  what_you_sell: "Bookkeeping for independent coffee shops",
  who_buys: "Owners of one to five coffee shops in the UK",
  tone: "Warm and plain, no jargon",
  price: "$290",
  claim: "Set up in one afternoon",
  never_say: "cheap",
  competitor: "Pricing page, read Mon 16 Nov: Enterprise, contact sales",
};

/** One line under each field's title on what Direx does with it. */
const HINT: Partial<Record<Field, string>> = {
  what_you_sell: "Drafts describe the business with this.",
  who_buys: "Drafts are written for these people.",
  tone: "How drafts should sound, in a few words.",
  price: "The only prices a draft may quote.",
  claim: "The only claims a draft may make about results.",
  never_say: "Words and promises no draft may use.",
};

/** What an empty field costs, said only where the checks show it; the rest just ask for it. */
const EMPTY: Partial<Record<Field, string>> = {
  price: "Not set. Until you add one, Direx can't check a price in a draft against yours.",
  never_say: "Not set. Until you add some, Direx flags no words in drafts.",
};

/** The box label on a list's add form, so it never reads the same as the Add button beside it. */
const ADD_LABEL: Partial<Record<Field, string>> = { price: "Price", claim: "New claim", never_say: "Word or phrase" };

/** Edits one value. A Contributor's save is a suggestion, which a person then accepts. */
function ValueForm(p: { label: string; placeholder?: string; initial?: string; pending?: boolean; onSave: (value: string) => void; onCancel?: () => void }) {
  const [value, setValue] = useState(p.initial ?? "");
  return (
    <form
      className="flex flex-col gap-3"
      onSubmit={(e) => {
        e.preventDefault();
        p.onSave(value);
      }}
    >
      <Labelled label={p.label}>
        <Textarea value={value} required placeholder={p.placeholder} onChange={(e) => setValue(e.target.value)} />
      </Labelled>
      <div className="flex gap-2">
        <Button type="submit" size="sm" pending={p.pending}>
          Save
        </Button>
        {p.onCancel && (
          <Button type="button" size="sm" variant="outline" onClick={p.onCancel}>
            Cancel
          </Button>
        )}
      </div>
    </form>
  );
}

/** The list's groups, in the order a marketer checks them. Each key opens one panel. */
const SAY: Field[] = ["what_you_sell", "who_buys", "price", "claim", "never_say"];
type Key = Field | "voice" | "lessons" | "competitors" | "strategy" | `item:${string}`;

/** What a Workspace is allowed to say about itself, and where each fact came from: a list on one side, the chosen part on the other. */
export function Brand(p: { workspaceId: string; role: Role; open?: "lessons" | "competitors"; initial?: { facts: Fact[]; conflicts: Item[]; proposals: Item[]; runs?: Run[] } }) {
  const { workspaceId, role } = p;
  const client = useQueryClient();
  const facts = useQuery({ ...factsQuery(workspaceId), initialData: p.initial?.facts });
  const waiting = useQuery({ ...factItemsQuery(workspaceId), initialData: p.initial && { conflicts: p.initial.conflicts, proposals: p.initial.proposals } });
  const [chosen, setChosen] = useState<Key | undefined>(p.open);
  const detail = useRef<HTMLDivElement>(null);
  const [editing, setEditing] = useState<string>();
  // Which action is running, and which one was refused, so each shows by its own buttons.
  const [busy, setBusy] = useState<string>();
  const [failed, setFailed] = useState<{ at: string; text: string }>();
  const decide = mayApprove(role);
  const verb = decide ? "Edit" : "Suggest a change";

  const reload = () => client.invalidateQueries({ queryKey: inWorkspace(workspaceId) });
  /** Runs one change. A refusal keeps the form open with what was typed, so nothing is lost; returns the refusal code. */
  async function act(at: string, fn: () => Promise<string | null>) {
    setBusy(at);
    setFailed(undefined);
    try {
      const code = await fn();
      if (code) setFailed({ at, text: say(code) });
      else setEditing(undefined);
      await reload();
      return code;
    } finally {
      setBusy(undefined);
    }
  }
  const refused = (at: string) => failed?.at === at && <Notice tone="error">{failed.text}</Notice>;
  const write = (at: string, v: NewValue, expectedVersion?: number) => act(at, () => (decide ? save(workspaceId, { ...v, expectedVersion }) : suggest(workspaceId, v)));

  const row = (f: Fact, alone: boolean) => (
    <div key={f.id} className="flex flex-col gap-2 border-t border-border pt-3 first:border-t-0 first:pt-0">
      <p className={alone ? "text-md wrap-break-word" : "wrap-break-word"}>
        {f.subject && f.field === "price" ? `${f.subject}: ` : ""}
        {f.value}
      </p>
      <Source f={f} />
      {editing === f.id ? (
        <ValueForm label={FIELD_LABEL[f.field]} initial={f.value} pending={busy === f.id} onSave={(value) => void write(f.id, { field: f.field, subject: f.subject || undefined, value }, f.version)} onCancel={() => setEditing(undefined)} />
      ) : (
        <div className="flex flex-wrap gap-2">
          {mayEdit(role) && (
            <Button size="sm" variant="outline" aria-label={`${verb}: ${f.value}`} onClick={() => setEditing(f.id)}>
              {verb}
            </Button>
          )}
          {decide && (
            <Confirm
              title={`Remove "${f.value}"?`}
              body="Direx stops using it in what it writes."
              confirm="Remove"
              onConfirm={() => act(f.id, () => retire(workspaceId, f.id))}
              trigger={
                <Button size="sm" variant="ghost" aria-label={`Remove ${f.value}`}>
                  Remove
                </Button>
              }
            />
          )}
        </div>
      )}
      {refused(f.id)}
      <History key={`${f.id}:${f.version}`} workspaceId={workspaceId} id={f.id} version={f.version} />
    </div>
  );

  const addForm = (field: Field) => (
    <form
      className="flex flex-wrap items-end gap-3 border-t border-border pt-4"
      onSubmit={(e) => {
        e.preventDefault();
        const form = e.currentTarget;
        const data = new FormData(form);
        // Cleared only when it was saved, so a refusal leaves the words to fix.
        void write(field, { field, subject: (data.get("subject") as string | null) ?? undefined, value: data.get("value") as string }).then((code) => !code && form.reset());
      }}
    >
      {field === "price" && (
        <Labelled label="For">
          <Input name="subject" required placeholder="per audit" />
        </Labelled>
      )}
      <Labelled label={ADD_LABEL[field] ?? "Add"}>
        <Input name="value" required placeholder={EXAMPLE[field]} />
      </Labelled>
      <Button type="submit" variant="outline" pending={busy === field}>
        Add
      </Button>
    </form>
  );

  const fieldPanel = (list: Fact[], field: Field, toDecision?: () => void) => {
    const rows = list.filter((x) => x.field === field);
    const one = SINGLE.includes(field);
    return (
      <Section key={field} title={FIELD_LABEL[field]} description={HINT[field]}>
        {rows.map((f) => row(f, one))}
        {toDecision && rows.some((f) => !f.usable) && (
          <Button size="sm" variant="outline" className="self-start" onClick={toDecision}>
            See the decision
          </Button>
        )}
        {rows.length === 0 && <p className="text-muted-foreground">{EMPTY[field] ?? "Not set. Add it so drafts can use it."}</p>}
        {one && rows.length === 0 && mayEdit(role) && <ValueForm label={FIELD_LABEL[field]} placeholder={`For example: ${EXAMPLE[field]}`} pending={busy === field} onSave={(value) => void write(field, { field, value })} />}
        {!one && mayEdit(role) && addForm(field)}
        {refused(field)}
        {rows.length > 0 && <p className="text-sm text-muted-foreground">Drafts not yet sent that use a changed fact go back for review.</p>}
      </Section>
    );
  };

  const decisionPanel = (i: Item, conflict: boolean) => (
    <Section key={i.id} title={conflict ? "Needs a decision" : "Add this?"} description={conflict ? "Two answers disagree. Drafts leave this out until you choose." : "Direx found this, or a teammate suggested it. Nothing changes until it's accepted."}>
      <div aria-label={i.title} role="group" className="flex flex-col gap-3">
        <p className="font-medium">{i.title}</p>
        <Warnings item={i} />
        {decide && conflict && (
          <div className="flex flex-wrap gap-2">
            <Button size="sm" aria-label={`Keep the current one for ${i.title}`} pending={busy === i.id} onClick={() => void act(i.id, () => approve(workspaceId, i, "keep"))}>
              Keep the current one
            </Button>
            <Button size="sm" variant="outline" aria-label={`Use the new one for ${i.title}`} pending={busy === i.id} onClick={() => void act(i.id, () => approve(workspaceId, i, "use_new"))}>
              Use the new one
            </Button>
            <Button size="sm" variant="outline" aria-label={`Don't mention ${i.title}`} pending={busy === i.id} onClick={() => void act(i.id, () => approve(workspaceId, i, "remove"))}>
              Don't mention this
            </Button>
          </div>
        )}
        {decide && !conflict && (
          <div className="flex flex-wrap gap-2">
            <Button size="sm" aria-label={`Accept ${i.title}`} pending={busy === i.id} onClick={() => void act(i.id, () => approve(workspaceId, i))}>
              Accept
            </Button>
            <Button size="sm" variant="outline" aria-label={`Dismiss ${i.title}`} pending={busy === i.id} onClick={() => void act(i.id, () => cancel(workspaceId, i.id))}>
              Dismiss
            </Button>
          </div>
        )}
        {!decide && <p className="text-sm text-muted-foreground">An Owner, Admin or Marketer decides this.</p>}
        {refused(i.id)}
      </div>
    </Section>
  );

  /** One list entry: its name, a line of what it holds, and the peach mark when it needs someone. */
  const entry = (key: Key, current: Key, label: string, summary: string, needsYou = false) => (
    <li key={key}>
      <Button
        variant="ghost"
        aria-label={`Open ${label}`}
        aria-current={key === current ? "true" : undefined}
        onClick={() => {
          setChosen(key);
          setEditing(undefined);
          // On a phone the panel sits above the list, so bring it into view or the tap seems to do nothing.
          requestAnimationFrame(() => {
            const el = detail.current;
            if (el && el.getBoundingClientRect().top < 0) {
              el.scrollIntoView({ block: "start" });
              el.focus({ preventScroll: true });
            }
          });
        }}
        className={`h-auto w-full flex-col items-start gap-1 rounded-none border-l-2 px-4 py-3 text-left font-normal whitespace-normal ${key === current ? "border-foreground bg-muted" : "border-transparent"}`}
      >
        <span className="flex w-full items-center justify-between gap-2">
          <span className="font-medium">{label}</span>
          {needsYou && <NeedsYou />}
        </span>
        <span className="line-clamp-1 w-full text-sm text-muted-foreground">{summary}</span>
      </Button>
    </li>
  );
  const group = (title: string, entries: ReactNode[], count?: string) => (
    <section key={title} aria-label={title} className="flex flex-col gap-2">
      <h2 className="flex items-baseline justify-between gap-2 text-sm font-medium text-muted-foreground">
        {title}
        {count && <span className="font-normal">{count}</span>}
      </h2>
      <ul className="flex flex-col divide-y divide-border overflow-hidden rounded-card border border-border bg-card">{entries}</ul>
    </section>
  );
  const summary = (list: Fact[], field: Field) => {
    const rows = list.filter((x) => x.field === field);
    if (rows.length === 0) return "Not set.";
    return rows.map((f) => (f.field === "price" && f.subject ? `${f.subject}: ${f.value}` : f.value)).join(" · ");
  };

  return (
    <Page title="Brand" description="What every draft is allowed to say, and how it should sound. Each fact shows where it came from.">
      <Runs workspaceId={workspaceId} role={role} onSettled={() => void reload()} initial={p.initial?.runs} compact />

      <QueryBoundary query={facts} skeleton={<Skeleton className="h-96 w-full" />}>
        {(list) => (
          <QueryBoundary query={waiting} skeleton={<Skeleton className="h-96 w-full" />}>
            {({ conflicts, proposals }) => {
              const items = [...conflicts.map((i) => ({ i, conflict: true })), ...proposals.map((i) => ({ i, conflict: false }))];
              // A decided Item leaves the list, so a choice that has gone falls back to the first thing waiting.
              const known = chosen && (!chosen.startsWith("item:") || items.some((x) => `item:${x.i.id}` === chosen));
              const current: Key = known ? chosen : items[0] ? `item:${items[0].i.id}` : "what_you_sell";
              const open = items.find((x) => `item:${x.i.id}` === current);
              const needs = (field: Field) => list.some((f) => f.field === field && !f.usable);
              // ponytail: a conflict's Item carries no field, so its title ("Who buys: needs a decision") names it; send factId on the Item to drop this.
              const conflictOn = (field: Field) => {
                const c = conflicts.find((i) => i.title.startsWith(`${FIELD_LABEL[field]}:`));
                return c && (() => setChosen(`item:${c.id}`));
              };
              return (
                <div className="grid gap-6 split:grid-cols-3">
                  <nav aria-label="Brand sections" className="order-last flex min-w-0 flex-col gap-5 self-start split:order-first">
                    {items.length > 0 && group(`Waiting on you (${items.length})`, items.map((x) => entry(`item:${x.i.id}`, current, x.i.title, x.conflict ? "Two answers disagree" : "Add this?")))}
                    {group(
                      "What we say",
                      SAY.map((f) => entry(f, current, FIELD_LABEL[f], summary(list, f), needs(f))),
                      // ponytail: counts only the parts the facts list answers; Voice, Competitors and Strategy load their own data, so their groups show no count.
                      `${SAY.filter((f) => list.some((x) => x.field === f)).length} of ${SAY.length} set`,
                    )}
                    {group("How we sound", [entry("tone", current, FIELD_LABEL.tone, summary(list, "tone"), needs("tone")), entry("voice", current, "Voice", "Examples and word swaps"), entry("lessons", current, "Lessons", "Notes from your edits")])}
                    {group("Market", [entry("competitors", current, "Competitors", "Pages Direx reads once a week"), entry("strategy", current, "Strategy", "Who you're for, positioning and channels")])}
                  </nav>
                  <div ref={detail} tabIndex={-1} className="flex min-w-0 flex-col gap-6 outline-none split:col-span-2">
                    {open && decisionPanel(open.i, open.conflict)}
                    {current === "voice" && <Voice workspaceId={workspaceId} role={role} />}
                    {current === "lessons" && <Lessons workspaceId={workspaceId} role={role} embedded />}
                    {current === "competitors" && <Competitors workspaceId={workspaceId} role={role} />}
                    {current === "strategy" && <Strategy workspaceId={workspaceId} role={role} facts={list} />}
                    {(SAY.includes(current as Field) || current === "tone") && fieldPanel(list, current as Field, conflictOn(current as Field))}
                  </div>
                </div>
              );
            }}
          </QueryBoundary>
        )}
      </QueryBoundary>
    </Page>
  );
}

/** One line per warning, so two or three of them don't run together into one sentence. */
function Warnings(p: { item: { warnings: { text: string }[] } }) {
  if (p.item.warnings.length === 0) return null;
  return (
    <ul aria-label="Warnings" className="flex list-disc flex-col gap-1 pl-5 text-sm text-muted-foreground">
      {p.item.warnings.map((w) => (
        <li key={w.text}>{w.text}</li>
      ))}
    </ul>
  );
}
