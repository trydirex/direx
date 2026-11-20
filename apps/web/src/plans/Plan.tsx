// SPDX-License-Identifier: AGPL-3.0-only
import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { inWorkspace } from "../api/query";
import { Notice, Page, Section } from "../components/layout";
import { QueryBoundary } from "../components/QueryBoundary";
import { Button } from "@/components/Button";
import { Input, Select } from "@/components/Input";
import { Skeleton } from "@astryxdesign/core/Skeleton";
import { mayEdit, type Role } from "../items/actions";
import { PlanImpact } from "../campaigns/PlanChange";
import { Measures } from "../campaigns/Overview";
import { factsQuery, type Fact } from "../facts/actions";
import { dayWords } from "../seo/actions";
import { addReading, basisLabel, countedFrom, emptyPlan, markStep, MEASURE_SOURCES, missingWords, newKey, planQuery, readingChanged, savePlan, say, sayDraft, sayRebased, sourceWords, startPlanDraft, submitPlan, type CitedReading, type MeasureSource, type Plan as Loaded, type PlanBody, type Tracking } from "./actions";
import { Assumptions, BasisField, DraftProgress, FIELDSET, KeptDraft, Row, Text, useEdits, WaitingVersion } from "./Fields";

const draftOf = (x: Loaded | undefined): PlanBody => ({ ...emptyPlan(), ...((x?.draft ?? x?.current ?? {}) as Partial<PlanBody>) });
// Names for the fields someone else changed, as the editor labels them.
const FIELD_WORDS: Partial<Record<keyof PlanBody, string>> = { goal: "Goal", audience: "Who", startsOn: "Starts", endsOn: "Ends", steps: "Steps", measures: "Measures", budget: "Budget", assumptions: "What we don't know yet" };
const STATUS_WORDS = { open: "To do", done: "Done", skipped: "Skipped" } as const;
/** "about $400.00"; a currency code Intl doesn't know (typed by hand) keeps its code. */
const money = (cents: number | null, currency: string) => {
  if (cents === null) return "no separate cost";
  try {
    return `about ${new Intl.NumberFormat(undefined, { style: "currency", currency }).format(cents / 100)}`;
  } catch {
    return `about ${(cents / 100).toFixed(2)} ${currency}`;
  }
};

/** How an approved plan is going: its steps' status and its measures, which everyone sees. `copy` adds the budget and open questions for someone with no editor to read them in. */
function Progress(p: { workspaceId: string; id: string; role: Role; body: PlanBody; tracking: Tracking; facts: Fact[]; cited: CitedReading[]; copy: boolean; settle: (code: string | null) => void }) {
  const { workspaceId, id, tracking: t } = p;
  const edit = mayEdit(p.role);
  const factValue = (factId: string) => p.facts.find((f) => f.id === factId)?.value;
  // The measure whose reading is being added.
  const [adding, setAdding] = useState<string>();
  return (
    <>
      <Section title="Steps">
        <p className="text-muted-foreground">
          Planned {t.planned}, done {t.done}, skipped {t.skipped}
        </p>
        <ul className="flex flex-col gap-2">
          {t.steps.map((s) => (
            <li key={s.key} className="flex flex-wrap items-center gap-2">
              {dayWords(s.on)} {s.title}: {STATUS_WORDS[s.status]}{" "}
              {edit && (
                <Select aria-label={`Status of ${s.title}`} value={s.status} onChange={async (e) => p.settle(await markStep(workspaceId, id, s.key, e.target.value as typeof s.status))}>
                  <option value="open">To do</option>
                  <option value="done">Done</option>
                  <option value="skipped">Skipped</option>
                </Select>
              )}
            </li>
          ))}
        </ul>
      </Section>
      {/* Drawn the same way as on Overview (marketer UX pass, D1), with the basis and a reading form under each. */}
      <Measures
        tracking={t}
        after={(m) => (
          <>
            <small className="text-sm text-muted-foreground">{basisLabel(m.basis, factValue, p.cited)}</small>
            {edit && (
              <form
                className="flex flex-wrap items-end gap-2"
                onSubmit={async (e) => {
                  e.preventDefault();
                  const form = e.currentTarget;
                  const data = new FormData(form);
                  setAdding(m.key);
                  try {
                    p.settle(await addReading(workspaceId, id, m.key, { value: data.get("value") as string, observedOn: data.get("observedOn") as string }));
                    form.reset();
                  } finally {
                    setAdding(undefined);
                  }
                }}
              >
                <div className="flex items-center gap-2 text-sm">
                  <Input label="Reading" name="value" required className="h-9 w-32" />
                </div>
                <div className="flex items-center gap-2 text-sm">
                  <Input label="On" name="observedOn" type="date" required className="h-9 w-40" />
                </div>
                <Button type="submit" size="sm" variant="outline" pending={adding === m.key}>
                  Add reading
                </Button>
              </form>
            )}
          </>
        )}
      />
      {p.copy && (
        <Section title="Budget" description="Your own accounts are billed by those providers, not by us.">
        <ul className="flex flex-col gap-1">
          {p.body.budget.map((l, i) => (
            <li key={i}>
              {l.label}: {money(l.amountCents, l.currency)} {l.billedBy === "your_account" && "(your account)"}
            </li>
          ))}
        </ul>
        </Section>
      )}
      {p.copy && p.body.assumptions.length > 0 && (
        <Section title="What we don't know yet">
          <ul className="flex flex-col gap-1">
            {p.body.assumptions.map((a) => (
              <li key={a.text}>
                {a.text} <small className="text-sm text-muted-foreground">assumption</small>
              </li>
            ))}
          </ul>
        </Section>
      )}
    </>
  );
}

/** A plan not approved yet, as someone who can't edit it reads it. */
function DraftView(p: { d: PlanBody; facts: Fact[]; cited: CitedReading[] }) {
  const { d } = p;
  const factValue = (factId: string) => p.facts.find((f) => f.id === factId)?.value;
  return (
    <section aria-label="Draft plan" className="flex flex-col gap-2 rounded-card border border-border bg-card p-6">
      <p className="text-muted-foreground">A draft. It isn't approved yet.</p>
      <p>Goal: {d.goal}</p>
      <p>Who: {d.audience}</p>
      {d.startsOn && d.endsOn && (
        <p>
          {dayWords(d.startsOn)} to {dayWords(d.endsOn)}
        </p>
      )}
      <ul aria-label="Steps" className="flex list-disc flex-col gap-1 pl-5">
        {d.steps.map((s) => (
          <li key={s.key}>
            {s.on && `${dayWords(s.on)} `}
            {s.title}
          </li>
        ))}
      </ul>
      <ul aria-label="Measures" className="flex list-disc flex-col gap-1 pl-5">
        {d.measures.map((m) => (
          <li key={m.key}>
            {m.label}: {m.target}
            {countedFrom(m.source) && `, counted by Direx from ${countedFrom(m.source)}`} <small className="text-sm text-muted-foreground">{basisLabel(m.basis, factValue, p.cited)}</small>
          </li>
        ))}
      </ul>
    </section>
  );
}

/** One campaign's plan: what it should do, the dated steps, and how that's going. */
export function Plan(p: { workspaceId: string; id: string; role: Role; runId?: string; notice?: string; embedded?: boolean; initial?: { plan: Loaded; facts: Fact[] } }) {
  const plan = useQuery({ ...planQuery(p.workspaceId, p.id), initialData: p.initial?.plan });
  const facts = useQuery({ ...factsQuery(p.workspaceId), initialData: p.initial?.facts });
  return (
    // A plan shows only inside its Campaign (ADR 0023), whose "Campaigns" link is the one way back.
    <div className="flex flex-col gap-4">
      <QueryBoundary query={plan} skeleton={<Skeleton className="h-96 w-full" />}>
        {(x) => <Loaded {...p} plan={x} facts={facts.data ?? []} />}
      </QueryBoundary>
    </div>
  );
}

function Loaded(p: { workspaceId: string; id: string; role: Role; runId?: string; notice?: string; embedded?: boolean; plan: Loaded; facts: Fact[] }) {
  const { workspaceId, id, role, plan, facts } = p;
  const client = useQueryClient();
  const edits = useEdits(draftOf(plan), plan.draftRevision);
  const { draft } = edits;
  const [error, setError] = useState<string | undefined>(p.notice && sayDraft(p.notice));
  const [saved, setSaved] = useState(false);
  const set = (patch: Partial<PlanBody>) => {
    setSaved(false);
    edits.set(patch);
  };
  const [runId, setRunId] = useState(p.runId);
  // Redraft, save and submit wait on each other.
  const [pending, setPending] = useState(false);
  async function busy(action: () => Promise<unknown>) {
    setPending(true);
    try {
      await action();
    } finally {
      setPending(false);
    }
  }
  const setLine = <K extends "steps" | "measures" | "budget">(key: K, i: number, patch: Partial<PlanBody[K][number]>) =>
    set({ [key]: (draft[key] as PlanBody[K][number][]).map((x, n) => (n === i ? { ...x, ...patch } : x)) } as Partial<PlanBody>);
  const dropLine = (key: "steps" | "measures" | "budget", i: number) => set({ [key]: (draft[key] as unknown[]).filter((_, n) => n !== i) } as Partial<PlanBody>);

  async function load() {
    await client.invalidateQueries({ queryKey: inWorkspace(workspaceId) });
    edits.clear();
  }

  async function settle(code: string | null, missing = "") {
    setSaved(false);
    setError(code ? `${say(code)}${missing && ` Still needed: ${missing}.`}` : undefined);
    await load();
  }
  async function save() {
    const r = await savePlan(workspaceId, id, edits.revision, draft);
    if (r.error === "stale_revision") {
      // Typed edits stay; the latest draft shows under them and the next save goes against it.
      const latest = await client.fetchQuery({ ...planQuery(workspaceId, id), staleTime: 0 }).catch(() => undefined);
      setError(latest ? sayRebased(edits.rebase(draftOf(latest), latest.draftRevision).flatMap((k) => FIELD_WORDS[k] ?? [])) : say(r.error));
    } else if (r.error) setError(say(r.error));
    return r.revision;
  }
  async function submit() {
    const revision = await save();
    if (revision === undefined) return;
    const r = await submitPlan(workspaceId, id, revision);
    await settle(r.error, r.missing ? missingWords(r.missing, FIELD_WORDS) : "");
  }

  const current = plan.current as PlanBody | null;
  return (
    <Page title={plan.title} description={plan.request} embedded={p.embedded}>
      {error && <Notice tone="error">{error}</Notice>}
      {runId && <DraftProgress workspaceId={workspaceId} runId={runId} onDone={() => void load()} />}
      {plan.notes.map((n, i) => (
        <Notice key={i}>{n.kind === "strategy_changed" ? "The Strategy has changed since this plan was approved." : n.kind === "reading_changed" ? readingChanged("plan", n.readingId, plan.citedReadings) : "A brand fact this plan relies on has changed."}</Notice>
      ))}
      {current && (
        <>
          {/* Someone who can edit reads the plan in its editor below (D5); this copy is for everyone else. */}
          {!mayEdit(role) && (
          <div className="flex flex-col gap-1">
            <p>
              Goal: {current.goal} <small className="text-sm text-muted-foreground">Used for reporting. It isn't a promise.</small>
            </p>
            <p>Who: {current.audience}</p>
            <p className="text-muted-foreground">
              {dayWords(current.startsOn)} to {dayWords(current.endsOn)}
              {plan.waiting && `, version ${plan.currentVersion}`}
            </p>
          </div>
          )}
          <Progress workspaceId={workspaceId} id={id} role={role} body={current} tracking={plan.tracking as Tracking} facts={facts} cited={plan.citedReadings} copy={!mayEdit(role)} settle={settle} />
        </>
      )}
      {plan.waiting && <WaitingVersion workspaceId={workspaceId} role={role} waiting={plan.waiting} templates={draft.steps.filter((s) => s.template).length} note="Approving lets Direx write the drafts. Each draft still comes to you before it goes out." settle={settle} />}

      <KeptDraft
        workspaceId={workspaceId}
        target={{ target: "plan", id }}
        revision={plan.draftRevision}
        edit={mayEdit(role)}
        onDone={() => void settle(null)}
        preview={(b) => {
          const d = b as PlanBody;
          return (
            <>
              <p>Goal: {d.goal}</p>
              <p>Who: {d.audience}</p>
              <p>
                {d.startsOn && d.endsOn ? `${dayWords(d.startsOn)} to ${dayWords(d.endsOn)}, ` : ""}{d.steps.length} {d.steps.length === 1 ? "step" : "steps"}
              </p>
            </>
          );
        }}
      />

      {!mayEdit(role) && !current && !!plan.draft && <DraftView d={draft} facts={facts} cited={plan.citedReadings} />}
      {mayEdit(role) && (
        <details open className="rounded-card border border-border bg-card p-6">
          <summary className="cursor-pointer font-medium">Edit plan</summary>
          <div className="mt-4 flex flex-col gap-4">
            {plan.request && (
              <div className="flex flex-wrap items-center gap-2">
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  pending={pending}
                  onClick={() =>
                    void busy(async () => {
                      const r = await startPlanDraft(workspaceId, id);
                      if (r.error) setError(sayDraft(r.error));
                      else setRunId(r.runId);
                    })
                  }
                >
                  {draft.goal ? "Redraft" : "Draft it for me"}
                </Button>
                {current && <small className="text-sm text-muted-foreground"> Redrafting writes a whole new plan, not an edit of this one, so steps the Campaign already has count as removed. To change one step, edit it below.</small>}
              </div>
            )}
            <Text label="Goal" value={draft.goal} onChange={(goal) => set({ goal })} />
            <small className="-mt-2 text-sm text-muted-foreground">Used for reporting. It isn't a promise.</small>
            <Text label="Who" long value={draft.audience} onChange={(audience) => set({ audience })} />
            <Text label="Starts" type="date" value={draft.startsOn} onChange={(startsOn) => set({ startsOn })} />
            <Text label="Ends" type="date" value={draft.endsOn} onChange={(endsOn) => set({ endsOn })} />
            <fieldset className={FIELDSET}>
              <legend className="px-1 text-sm font-medium">Steps</legend>
              {draft.steps.map((s, i) => (
                <div key={s.key} className="flex flex-col gap-2">
                  <div className="flex flex-wrap items-center gap-2">
                    <Input aria-label="Step date" type="date" className="w-40" value={s.on} onChange={(e) => setLine("steps", i, { on: e.target.value })} />
                    <Input aria-label="Step" className="flex-1" value={s.title} onChange={(e) => setLine("steps", i, { title: e.target.value })} />
                    <Button type="button" size="sm" variant="outline" aria-label={`Remove step ${i + 1}`} onClick={() => dropLine("steps", i)}>
                      Remove
                    </Button>
                  </div>
                  {/* Approving the plan approves this text; the step's Campaign starts with it. */}
                  {s.template && (
                    <details>
                      <summary>Email: {s.template.subject}</summary>
                      <p className="whitespace-pre-wrap">{s.template.text}</p>
                    </details>
                  )}
                </div>
              ))}
              <Row>
                <Button type="button" size="sm" variant="outline" onClick={() => set({ steps: [...draft.steps, { key: newKey(), on: draft.startsOn, title: "" }] })}>
                  Add a step
                </Button>
              </Row>
            </fieldset>
            {current && <PlanImpact workspaceId={workspaceId} planId={id} refresh={`${plan.draftRevision}:${plan.currentVersion}`} />}
            <fieldset className={FIELDSET}>
              <legend className="px-1 text-sm font-medium">Measures</legend>
              {draft.measures.map((m, i) => (
                <div key={m.key} className="flex flex-wrap items-center gap-2">
                  <Input aria-label="Measure" className="flex-1" value={m.label} onChange={(e) => setLine("measures", i, { label: e.target.value })} />
                  <Input aria-label="Target" className="w-48 max-w-full" value={m.target} onChange={(e) => setLine("measures", i, { target: e.target.value })} />
                  <BasisField value={m.basis} facts={facts} cited={plan.citedReadings} onChange={(basis) => setLine("measures", i, { basis })} />
                  {/* A different source starts a new reading history; old readings stay with the old key. */}
                  <Select aria-label={`Where measure ${i + 1}'s number comes from`} value={m.source ?? "external"} onChange={(e) => setLine("measures", i, { source: e.target.value as MeasureSource, key: newKey() })}>
                    {MEASURE_SOURCES.map((s) => (
                      <option key={s} value={s}>
                        {sourceWords(s)}
                      </option>
                    ))}
                  </Select>
                  <Button type="button" size="sm" variant="outline" aria-label={`Remove measure ${i + 1}`} onClick={() => dropLine("measures", i)}>
                    Remove
                  </Button>
                </div>
              ))}
              <Row>
                <Button type="button" size="sm" variant="outline" onClick={() => set({ measures: [...draft.measures, { key: newKey(), label: "", target: "", basis: { kind: "assumption" } }] })}>
                  Add a measure
                </Button>
              </Row>
            </fieldset>
            <fieldset className={FIELDSET}>
              <legend className="px-1 text-sm font-medium">Budget</legend>
              {draft.budget.map((l, i) => (
                <div key={i} className="flex flex-wrap items-center gap-2">
                  <Input aria-label="Budget line" className="flex-1" value={l.label} onChange={(e) => setLine("budget", i, { label: e.target.value })} />
                  <Input aria-label="Amount" type="number" min="0" step="0.01" className="w-32" value={l.amountCents === null ? "" : l.amountCents / 100} onChange={(e) => setLine("budget", i, { amountCents: e.target.value === "" ? null : Math.round(Number(e.target.value) * 100) })} />
                  <Input aria-label="Currency" className="w-24" autoComplete="off" spellCheck={false} value={l.currency} onChange={(e) => setLine("budget", i, { currency: e.target.value.toUpperCase() })} />
                  <Select aria-label="Billed by" value={l.billedBy} onChange={(e) => setLine("budget", i, { billedBy: e.target.value as typeof l.billedBy })}>
                    <option value="your_account">Your account</option>
                    <option value="direx">Direx</option>
                  </Select>
                  <Button type="button" size="sm" variant="outline" aria-label={`Remove budget line ${i + 1}`} onClick={() => dropLine("budget", i)}>
                    Remove
                  </Button>
                </div>
              ))}
              <Row>
                <Button type="button" size="sm" variant="outline" onClick={() => set({ budget: [...draft.budget, { label: "", amountCents: null, currency: "USD", billedBy: "your_account" }] })}>
                  Add a budget line
                </Button>
              </Row>
            </fieldset>
            <Assumptions rows={draft.assumptions} onChange={(assumptions) => set({ assumptions })} />
            <Row>
              <Button
                variant="outline"
                pending={pending}
                onClick={() =>
                  void busy(async () => {
                    if ((await save()) === undefined) return;
                    await settle(null);
                    setSaved(true);
                  })
                }
              >
                Save draft
              </Button>
              <Button pending={pending} onClick={() => void busy(submit)}>
                Send for sign-off
              </Button>
            </Row>
            {saved && !error && <Notice>Draft saved.</Notice>}
          </div>
        </details>
      )}
    </Page>
  );
}
