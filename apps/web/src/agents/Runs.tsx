// SPDX-License-Identifier: AGPL-3.0-only
// Reading a website or pasted text into Brand. What it finds lands in "Add this?", so this only
// starts reads and shows what they did. There is no agents page.
import { useEffect, useRef, useState, type ReactNode } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { inWorkspace } from "../api/query";
import { EmptyState, Field, Notice, Section } from "../components/layout";
import { QueryBoundary } from "../components/QueryBoundary";
import { Button } from "@/components/Button";
import { Input, Textarea } from "@/components/Input";
import { Skeleton } from "@astryxdesign/core/Skeleton";
import { toast } from "@/components/toast";
import { mayEdit, type Role } from "../items/actions";
import { DocsPicker } from "./DocsPicker";
import { cancelRun, costWords, docsQuery, isLive, noNewRun, pageReason, readSettings, runDetail, runsQuery, saveRunSettings, sayChange, startRead, statusLabel, untested, type Run, type RunDetail, type RunSettings } from "./actions";

const POLL_MS = 3000;

function WhatItRead({ workspaceId, id }: { workspaceId: string; id: string }) {
  const [d, setD] = useState<RunDetail>();
  return (
    <details className="text-sm" onToggle={async (e) => (e.currentTarget.open && !d ? setD(await runDetail(workspaceId, id)) : undefined)}>
      <summary className="cursor-pointer py-1 text-muted-foreground">What it read</summary>
      {d && (
        <div className="mt-2 flex flex-col gap-2">
          <ul className="flex flex-col gap-1 pl-4">
            {d.read.filter((p) => p.kind === "web_page" || p.kind === "pasted_text").map((p) => (
              <li key={p.ref}>
                {p.kind === "web_page" ? p.ref : "The text you pasted"}
                {p.truncated && " (only the start of it)"}
              </li>
            ))}
            {d.failedPages.map((p) => (
              <li key={p.address}>
                Couldn't read {p.address}: {pageReason(p.reason)}
              </li>
            ))}
          </ul>
          <p className="text-muted-foreground">
            {d.proposals.filter((p) => p.rejectionCode === "already_in_brand").length} already in Brand, {d.proposals.filter((p) => p.rejectionCode && p.rejectionCode !== "already_in_brand").length} left out.
          </p>
        </div>
      )}
    </details>
  );
}

/** onSettled runs when the last read in progress ends, so what it found shows up on the page. */
/** Runs' body without a card of its own, for a screen that already frames it. */
const EmbeddedWrap = (p: { title: string; description: string; children: ReactNode }) => <div className="flex flex-col gap-4">{p.children}</div>;

export function Runs(p: { workspaceId: string; role: Role; onSettled?: () => void; initial?: Run[]; compact?: boolean;
  /** Inside a screen that already says what this is (setup's step): no heading of its own, and no cost per read. */
  embedded?: boolean;
  /** The website to fill in, such as the one given when the Organization was created. */
  address?: string }) {
  const { workspaceId, role } = p;
  const [open, setOpen] = useState(false);
  const client = useQueryClient();
  const runs = useQuery({ ...runsQuery(workspaceId, "brand_reader"), initialData: p.initial, refetchInterval: (q) => (q.state.data?.some(isLive) ? POLL_MS : false) });
  const [pasting, setPasting] = useState(false);
  // A connected docs tool (Notion first) is a third place to read from.
  const docs = useQuery({ ...docsQuery(workspaceId), enabled: mayEdit(role) }).data;
  const [fromDocs, setFromDocs] = useState(false);
  const [address, setAddress] = useState(p.address ?? "");
  const host = URL.canParse(address) ? new URL(address).hostname.replace(/^www\./, "") : "";
  const [text, setText] = useState("");
  const [error, setError] = useState<string>();
  // "read" while a read is starting, or the id of the read being cancelled.
  const [busy, setBusy] = useState<string>();

  const anyLive = !!runs.data?.some(isLive);
  const wasLive = useRef(anyLive);
  useEffect(() => {
    if (wasLive.current && !anyLive) p.onSettled?.();
    wasLive.current = anyLive;
  }, [anyLive]);

  const reload = async () => {
    await client.invalidateQueries({ queryKey: inWorkspace(workspaceId) });
    return client.getQueryData(runsQuery(workspaceId, "brand_reader").queryKey) ?? [];
  };
  async function cancel(runId: string) {
    setBusy(runId);
    try {
      const code = await cancelRun(workspaceId, runId);
      setError(code ? sayChange(code) : undefined);
      await reload();
    } finally {
      setBusy(undefined);
    }
  }
  async function start(e: React.FormEvent) {
    e.preventDefault();
    setBusy("read");
    try {
      const before = runs.data ?? [];
      const code = await startRead(workspaceId, pasting ? { text } : { url: address });
      if (!code) {
        setAddress("");
        setText("");
      }
      setError(code ? sayChange(code) : undefined);
      const after = await reload();
      if (!code && noNewRun(before, after)) toast.add({ title: "Direx already read this today, so it didn't read it again. The result is in the list below." });
    } finally {
      setBusy(undefined);
    }
  }

  // Brand passes compact: once a read has finished, a status line stands in for the whole form.
  const latest = runs.data?.find((r) => r.agent === "brand_reader");
  if (p.compact && !open && runs.data && !anyLive)
    return (
      <p className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm text-muted-foreground">
        {latest ? `Last read ${latest.address ?? "pasted text"}: ${statusLabel(latest)}, ${latest.proposalCount} proposed.` : "Direx can read your website and propose facts for you to accept."}
        {mayEdit(role) && (
          <Button size="sm" variant="outline" onClick={() => setOpen(true)}>
            {latest ? "Read your website again" : "Read your website"}
          </Button>
        )}
      </p>
    );

  const Wrap = p.embedded ? EmbeddedWrap : Section;
  return (
    <Wrap title="Read our website" description="Direx reads the pages and proposes what to add here. Nothing changes until a person accepts it.">
      {error && <Notice tone="error">{error}</Notice>}
      {mayEdit(role) && fromDocs && docs?.provider && (
        <DocsPicker
          workspaceId={workspaceId}
          provider={docs.provider}
          onCancel={() => setFromDocs(false)}
          onStarted={(cut) => {
            setFromDocs(false);
            setError(undefined);
            void reload();
            if (cut) toast.add({ title: "That page is longer than one read, so Direx read its start." });
          }}
        />
      )}
      {mayEdit(role) && !fromDocs && (
        <form className="flex flex-wrap items-end gap-3" onSubmit={start}>
          <div className="min-w-64 flex-1">
            {pasting ? (
              <Field label="Text">
                <Textarea value={text} required maxLength={100_000} onChange={(e) => setText(e.target.value)} />
              </Field>
            ) : (
              <Field label="Address">
                <Input type="url" value={address} required autoComplete="off" spellCheck={false} placeholder="https://example.com" onChange={(e) => setAddress(e.target.value)} />
              </Field>
            )}
          </div>
          <Button type="submit" pending={busy === "read"}>
            {!pasting && host ? `Read ${host}` : "Read"}
          </Button>
          <Button type="button" variant="outline" onClick={() => setPasting(!pasting)}>
            {pasting ? "Use an address instead" : "Paste text instead"}
          </Button>
          {docs?.connected && (
            <Button type="button" variant="outline" onClick={() => setFromDocs(true)}>
              {`Read a ${docs.provider} page`}
            </Button>
          )}
        </form>
      )}
      <QueryBoundary query={runs} skeleton={<Skeleton className="h-16 w-full" />}>
        {(list) => {
          const reads = list.filter((r) => r.agent === "brand_reader").slice(0, 5);
          return reads.length === 0 ? (
            <EmptyState title="No reads yet">Each read of your website or pasted text shows here, with what it proposed.</EmptyState>
          ) : (
            <ul aria-label="Latest reads" className="flex flex-col gap-3">
              {reads.map((r) => (
                <li key={r.id} className="flex flex-col gap-2 border-t border-border pt-3 first:border-t-0 first:pt-0">
                  <p className="wrap-break-word">
                    {r.address ?? "Pasted text"}: {statusLabel(r)}. {r.proposalCount} proposed{p.embedded ? "" : r.subscription ? `, ${costWords(r)}` : `, cost ${costWords(r)}`}.
                    {r.incomplete && r.proposalCount > 0 && " What it proposed is marked as coming from a read that didn't finish."}
                    {untested(r) && <small className="text-sm text-muted-foreground"> Direx hasn't tested this model on this job yet, so check what it proposes closely.</small>}
                  </p>
                  {mayEdit(role) && isLive(r) && (
                    <div>
                      <Button size="sm" variant="outline" pending={busy === r.id} aria-label={`Cancel the read of ${r.address ?? "pasted text"}`} onClick={() => void cancel(r.id)}>
                        Cancel
                      </Button>
                    </div>
                  )}
                  <WhatItRead workspaceId={workspaceId} id={r.id} />
                </li>
              ))}
            </ul>
          );
        }}
      </QueryBoundary>
    </Wrap>
  );
}

/**
 * Admins only, on the Models page. Each save is a new revision. It still loads with an effect: the
 * Models page renders it without a query client.
 */
export function RunCaps(p: { workspaceId: string; initial?: RunSettings }) {
  const [s, setS] = useState<RunSettings | undefined>(p.initial);
  const [error, setError] = useState<string>();
  const [saving, setSaving] = useState(false);
  useEffect(() => {
    void readSettings(p.workspaceId).then(setS);
  }, [p.workspaceId]);
  if (!s) return null;

  async function save(e: React.FormEvent) {
    e.preventDefault();
    setSaving(true);
    try {
      const code = await saveRunSettings(p.workspaceId, { enabled: s!.enabled, maxConcurrentRuns: s!.maxConcurrentRuns, maxDailyRuns: s!.maxDailyRuns });
      setError(code ? sayChange(code) : undefined);
      if (!code) toast.add({ title: "Saved." });
    } finally {
      setSaving(false);
    }
  }
  return (
    <Section title="Reading websites">
      {error && <Notice tone="error">{error}</Notice>}
      <form className="flex flex-wrap items-end gap-3" onSubmit={save}>
        <label className="flex min-h-11 items-center gap-2 text-sm font-medium">
          <input type="checkbox" checked={s.enabled} onChange={(e) => setS({ ...s, enabled: e.target.checked })} /> On
        </label>
        <Field label="At once">
          <Input type="number" min={1} value={s.maxConcurrentRuns} required onChange={(e) => setS({ ...s, maxConcurrentRuns: Number(e.target.value) })} />
        </Field>
        <Field label="Per day">
          <Input type="number" min={1} value={s.maxDailyRuns} required onChange={(e) => setS({ ...s, maxDailyRuns: Number(e.target.value) })} />
        </Field>
        <Button type="submit" pending={saving}>
          Save limits
        </Button>
      </form>
    </Section>
  );
}
