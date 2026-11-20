// SPDX-License-Identifier: AGPL-3.0-only
// The pieces a Strategy and a plan share: labelled text, the basis of a claim, assumptions, a measure
// against its target, and the waiting Item with its approve button.
import { useEffect, useState, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { cancelRun, costWords, isLive, runDetail, untested, type RunDetail } from "../agents/actions";
import { approve, cancel, mayApprove, type Role } from "../items/actions";
import type { Fact } from "../facts/actions";
import { Field, Notice } from "../components/layout";
import { Button } from "@/components/Button";
import { ProgressBar } from "@astryxdesign/core/ProgressBar";
import { Input, Select, Textarea } from "@/components/Input";
import { basisLabel, dismissOffer, draftOutcome, measureWords, offerQuery, takeOffer, type Basis, type CitedReading, type DraftOffer, type OfferTarget } from "./actions";

const POLL_MS = 2000;

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
/**
 * Unsaved edits, kept as the fields changed and laid over the draft as last loaded, with the revision
 * and draft they began from. When someone else saved first (stale_revision), `rebase` lays the same
 * edits over the latest draft, so the next save goes against its revision and keeps their other fields.
 */
export function useEdits<T extends object>(loaded: T, revision: number) {
  const [edits, setEdits] = useState<{ revision: number; base: T; patch: Partial<T> }>();
  const base = edits?.base ?? loaded;
  return {
    draft: { ...loaded, ...edits?.patch } as T,
    revision: edits?.revision ?? revision,
    set: (patch: Partial<T>) => setEdits({ revision: edits?.revision ?? revision, base, patch: { ...edits?.patch, ...patch } }),
    clear: () => setEdits(undefined),
    /** Moves the edits onto `latest`, dropping any put back as they were; returns the fields changed there meanwhile. */
    rebase: (latest: T, latestRevision: number) => {
      const patch = Object.fromEntries(Object.entries(edits?.patch ?? {}).filter(([k, v]) => !same(v, base[k as keyof T]))) as Partial<T>;
      setEdits({ revision: latestRevision, base: latest, patch });
      return (Object.keys(latest) as (keyof T)[]).filter((k) => !same(base[k], latest[k]));
    },
  };
}

const CANCEL_REFUSALS: Record<string, string> = {
  not_allowed: "Only the person who started this draft or an Admin can cancel it.",
  already_ended: "This draft has already ended.",
};

/** A drafting run in progress, which its starter or an Admin can cancel, then what became of it. Reloads the page's draft once it has ended. */
export function DraftProgress(p: { workspaceId: string; runId: string; onDone: () => void }) {
  const [run, setRun] = useState<RunDetail>();
  // The run can't be read (an unknown id, or the request failed), so following it stops.
  const [lost, setLost] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const [error, setError] = useState<string>();
  useEffect(() => {
    let live = true;
    setLost(false);
    async function poll() {
      const r = await runDetail(p.workspaceId, p.runId).catch(() => undefined);
      if (!live) return;
      if (!r) return setLost(true);
      setRun(r);
      if (!isLive(r)) p.onDone();
      else setTimeout(() => void poll(), POLL_MS);
    }
    void poll();
    return () => {
      live = false;
    };
  }, [p.workspaceId, p.runId]);
  async function stop() {
    setCancelling(true);
    const code = await cancelRun(p.workspaceId, p.runId).catch(() => "failed");
    // On success the next poll sees the run cancelled and says so.
    if (code) {
      setCancelling(false);
      setError(CANCEL_REFUSALS[code] ?? "That didn't go through. Try again.");
    }
  }
  if (lost) return <Notice tone="error">Direx can't find this draft run. Reload the page to see the latest draft.</Notice>;
  if (!run || isLive(run))
    return (
      <div role="status" className="flex flex-wrap items-center gap-3 rounded-card bg-muted px-4 py-3">
        <p>Direx is drafting this. Nothing is sent.</p>
        {run && (
          <Button type="button" size="sm" variant="outline" pending={cancelling} aria-label="Cancel this draft" onClick={() => void stop()}>
            Cancel
          </Button>
        )}
        {error && <p role="alert" className="text-destructive">{error}</p>}
      </div>
    );
  return (
    <div role="status" className="flex flex-col gap-1 rounded-card bg-muted px-4 py-3">
      <p>{draftOutcome(run)}</p>
      <details className="text-sm text-muted-foreground">
        <summary className="cursor-pointer">Cost</summary>
        {run.subscription ? "It ran on your subscription." : `${costWords(run)}.`}
        {untested(run) && " Untested model for this job, so read it closely."}
      </details>
    </div>
  );
}

const OFFER_REFUSALS: Record<string, string> = {
  target_changed: "This changed again since you opened it. Reload the page and try again.",
  offer_closed: "Someone already used or dismissed this draft.",
  archived: "This plan is archived.",
  unknown_merge_field: "This draft uses a field Direx doesn't know, so it can't be used.",
};

/**
 * Direx's draft that arrived after someone saved, kept until a person uses or dismisses it. It is a
 * Workspace query, so the page's reload after a drafting run ends reads it again and a draft that just lost shows up.
 */
export function KeptDraft(p: { workspaceId: string; target: OfferTarget; revision: number; edit: boolean; preview: (body: unknown) => ReactNode; onDone: () => void; initial?: DraftOffer }) {
  const query = useQuery({ ...offerQuery(p.workspaceId, p.target), initialData: p.initial });
  const offer = query.data;
  const [error, setError] = useState<string>();
  if (!offer) return null;
  async function settle(code: string | null) {
    setError(code ? (OFFER_REFUSALS[code] ?? code) : undefined);
    if (code === "offer_closed") void query.refetch();
    if (!code) p.onDone();
  }
  return (
    <section aria-label="Direx's kept draft" className="flex flex-col gap-3 rounded-card bg-muted p-4">
      <p role="status">
        Direx's draft arrived after your edit, so your version stayed. <small className="text-sm text-muted-foreground">{offer.subscription ? "It ran on your subscription." : `Cost ${costWords(offer)}.`}</small>
      </p>
      {error && <Notice tone="error">{error}</Notice>}
      {p.preview(offer.body)}
      {p.edit && (
        <div className="flex flex-wrap gap-2">
          <Button type="button" size="sm" onClick={async () => settle(await takeOffer(p.workspaceId, offer, p.revision))}>
            Use Direx's draft
          </Button>
          <Button type="button" size="sm" variant="outline" onClick={async () => settle(await dismissOffer(p.workspaceId, offer))}>
            Dismiss
          </Button>
        </div>
      )}
    </section>
  );
}

export function Text(p: { label: string; value: string; onChange: (v: string) => void; long?: boolean; type?: string }) {
  return (
    <Field label={p.label}>
      {p.long ? <Textarea value={p.value} onChange={(e) => p.onChange(e.target.value)} /> : <Input type={p.type ?? "text"} value={p.value} onChange={(e) => p.onChange(e.target.value)} />}
    </Field>
  );
}


/**
 * Nothing can go unlabelled: every reason and target says what it rests on, and it starts as an assumption.
 * A reading basis comes only from a draft Direx wrote, so it shows as the one option until another kind is picked.
 */
export function BasisField(p: { value: Basis; facts: Fact[]; cited?: CitedReading[]; onChange: (b: Basis) => void }) {
  const selected = p.value.kind === "fact" ? `fact:${p.value.factId}` : p.value.kind;
  const label = basisLabel(p.value, (id) => p.facts.find((f) => f.id === id)?.value, p.cited);
  // Collapsed, it still says what the number rests on.
  return (
    <details className="max-w-full text-sm">
      <summary className="cursor-pointer text-muted-foreground">Where does this number come from? ({label})</summary>
      <div className="mt-2 flex flex-wrap items-center gap-2">
        <Select
          label="Comes from"
          value={selected}
          onChange={(e) => {
            const v = e.target.value;
            if (v === "assumption") return p.onChange({ kind: "assumption" });
            if (v === "source") return p.onChange({ kind: "source", label: "" });
            const f = p.facts.find((x) => `fact:${x.id}` === v)!;
            p.onChange({ kind: "fact", factId: f.id, version: f.version });
          }}
        >
          {p.value.kind === "reading" && <option value="reading">{label}</option>}
          <option value="assumption">An assumption</option>
          <option value="source">A named source</option>
          {p.facts
            .filter((f) => f.usable)
            .map((f) => (
              <option key={f.id} value={`fact:${f.id}`}>
                {f.value}
              </option>
            ))}
        </Select>
        {p.value.kind === "source" && <Input aria-label="Source" className="w-48" value={p.value.label} onChange={(e) => p.onChange({ kind: "source", label: e.target.value })} />}
      </div>
    </details>
  );
}

/** A group of editable lines. */
/** A list row's main measure: "142 / 200 Signups (71%)" with a bar when both are numbers. */
export function MeasureLine(p: { measure: { label: string; target: string; value: string | null } }) {
  const m = measureWords(p.measure);
  return (
    <div className="flex flex-col gap-1">
      <span className="text-sm">{m.text}</span>
      {m.value !== null && m.target !== null && <ProgressBar label={`${p.measure.label} against its target`} isLabelHidden value={Math.min(m.value, m.target)} max={m.target} />}
    </div>
  );
}

export const FIELDSET = "flex flex-col gap-3 rounded-card border border-border p-4";
/** Buttons side by side. */
export const Row = (p: { children: ReactNode }) => <div className="flex flex-wrap gap-2">{p.children}</div>;

export function Assumptions(p: { rows: { text: string }[]; onChange: (rows: { text: string }[]) => void }) {
  return (
    <fieldset className={FIELDSET}>
      <legend className="px-1 text-sm font-medium">What we don't know yet</legend>
      {p.rows.map((a, i) => (
        <div key={i} className="flex flex-wrap items-center gap-2">
          <Textarea aria-label="Assumption" rows={1} className="min-h-11 min-w-0 flex-1" value={a.text} onChange={(e) => p.onChange(p.rows.map((x, n) => (n === i ? { text: e.target.value } : x)))} />
          <Button type="button" size="sm" variant="outline" aria-label={`Remove assumption ${i + 1}`} onClick={() => p.onChange(p.rows.filter((_, n) => n !== i))}>
            Remove
          </Button>
        </div>
      ))}
      <Row>
        <Button type="button" size="sm" variant="outline" onClick={() => p.onChange([...p.rows, { text: "" }])}>
          Add an assumption
        </Button>
      </Row>
    </fieldset>
  );
}

export function WaitingVersion(p: {
  workspaceId: string;
  role: Role;
  waiting: { id: string; revision: number; version: number; warnings: string[] };
  note?: string;
  /** Email templates the plan wrote: approving the plan approves their words too. */
  templates?: number;
  settle: (code: string | null) => void;
}) {
  const w = p.waiting;
  const n = p.templates ?? 0;
  return (
    <section aria-label="Needs approval" className="flex flex-col gap-3 rounded-card bg-muted p-4">
      <h2 className="text-md font-medium">Version {w.version} needs approval</h2>
      <ul className="flex list-disc flex-col gap-1 pl-5">
        {w.warnings.map((text) => (
          <li key={text}>{text}</li>
        ))}
      </ul>
      {p.note && <p className="text-muted-foreground">{p.note}</p>}
      {mayApprove(p.role) && (
        <Row>
          <Button size="sm" onClick={async () => p.settle(await approve(p.workspaceId, w))}>
            {n ? `Approve plan and ${n} email ${n === 1 ? "template" : "templates"}` : `Approve version ${w.version}`}
          </Button>
          <Button size="sm" variant="outline" onClick={async () => p.settle(await cancel(p.workspaceId, w.id))}>
            Dismiss
          </Button>
        </Row>
      )}
    </section>
  );
}
