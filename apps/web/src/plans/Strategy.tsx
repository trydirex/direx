// SPDX-License-Identifier: AGPL-3.0-only
import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { inWorkspace } from "../api/query";
import { Notice, Section } from "../components/layout";
import { QueryBoundary } from "../components/QueryBoundary";
import { Button, buttonVariants } from "@/components/Button";
import { Input, Select } from "@/components/Input";
import { Skeleton } from "@astryxdesign/core/Skeleton";
import { mayEdit, type Role } from "../items/actions";
import type { Fact } from "../facts/actions";
import { basisLabel, emptyStrategy, missingWords, newKey, readingChanged, saveStrategy, say, sayDraft, sayRebased, startStrategyDraft, strategyQuery, submitStrategy, type Channel, type Strategy as Loaded, type StrategyBody } from "./actions";
import { Assumptions, BasisField, DraftProgress, FIELDSET, KeptDraft, Row, Text, useEdits, WaitingVersion } from "./Fields";

const draftOf = (s: Loaded | undefined): StrategyBody => ({ ...emptyStrategy(), ...((s?.draft ?? s?.current ?? {}) as Partial<StrategyBody>) });
// Names for the fields someone else changed, as the editor labels them.
const FIELD_WORDS: Partial<Record<keyof StrategyBody, string>> = { whoFor: "Who we're for", positioning: "Positioning", personas: "Personas", channels: "Channels", assumptions: "What we don't know yet" };

/** Who we're for, how we say it and where. One per Workspace; every plan is built on it. */
export function Strategy(p: { workspaceId: string; role: Role; facts: Fact[]; initial?: Loaded }) {
  const query = useQuery({ ...strategyQuery(p.workspaceId), initialData: p.initial });
  return (
    <Section title="Strategy">
      <QueryBoundary query={query} skeleton={<Skeleton className="h-48 w-full" />}>
        {(loaded) => <Loaded {...p} loaded={loaded} />}
      </QueryBoundary>
    </Section>
  );
}

function Loaded(p: { workspaceId: string; role: Role; facts: Fact[]; loaded: Loaded }) {
  const { workspaceId, role, loaded } = p;
  const client = useQueryClient();
  const edits = useEdits(draftOf(loaded), loaded.draftRevision);
  const { draft } = edits;
  const [error, setError] = useState<string>();
  const [saved, setSaved] = useState(false);
  const [draftError, setDraftError] = useState<string>();
  const [request, setRequest] = useState("");
  const [runId, setRunId] = useState<string>();
  const set = (patch: Partial<StrategyBody>) => {
    setSaved(false);
    edits.set(patch);
  };
  const setChannel = (i: number, patch: Partial<Channel>) => set({ channels: draft.channels.map((c, n) => (n === i ? { ...c, ...patch } : c)) });

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
    const r = await saveStrategy(workspaceId, edits.revision, draft);
    if (r.error === "stale_revision") {
      // Typed edits stay; the latest draft shows under them and the next save goes against it.
      const latest = await client.fetchQuery({ ...strategyQuery(workspaceId), staleTime: 0 }).catch(() => undefined);
      setError(latest ? sayRebased(edits.rebase(draftOf(latest), latest.draftRevision).flatMap((k) => FIELD_WORDS[k] ?? [])) : say(r.error));
    } else if (r.error) setError(say(r.error));
    return r.revision;
  }
  async function submit() {
    const revision = await save();
    if (revision === undefined) return;
    const r = await submitStrategy(workspaceId, revision);
    await settle(r.error, r.missing ? missingWords(r.missing, FIELD_WORDS) : "");
  }

  const current = loaded.current as StrategyBody | null;
  const factValue = (id: string) => p.facts.find((f) => f.id === id)?.value;
  return (
    <>
      {loaded.notes.map((n) => (
        <Notice key={n.readingId}>{readingChanged("Strategy", n.readingId, loaded.citedReadings)}</Notice>
      ))}
      {current ? (
        <div className="flex flex-col gap-2 rounded-card border border-border p-4">
          {loaded.waiting && <p className="text-sm text-muted-foreground">Version {loaded.currentVersion}</p>}
          <p>Who we're for: {current.whoFor}</p>
          <p>Channels: {current.channels.map((c) => (c.timing === "later" ? `${c.label} (later)` : c.label)).join(", ") || "none yet"}</p>
          {/* The reasons and what they rest on stay a click away, for people who can't open the editor. */}
          <details>
            <summary className="cursor-pointer text-sm text-muted-foreground">Positioning, reasons and assumptions</summary>
            <div className="mt-2 flex flex-col gap-2">
              <p>Positioning: {current.positioning}</p>
              <ul className="flex list-disc flex-col gap-1 pl-5">
                {current.channels.map((c) => (
                  <li key={c.key}>
                    {c.label}: {c.reason} <small className="text-sm text-muted-foreground">{basisLabel(c.basis, factValue, loaded.citedReadings)}</small>
                  </li>
                ))}
              </ul>
              {current.assumptions.length > 0 && (
                <ul aria-label="What we don't know yet" className="flex list-disc flex-col gap-1 pl-5">
                  {current.assumptions.map((a) => (
                    <li key={a.text}>
                      {a.text} <small className="text-sm text-muted-foreground">assumption</small>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </details>
        </div>
      ) : (
        <p className="text-muted-foreground">No Strategy yet.</p>
      )}
      {loaded.waiting && <WaitingVersion workspaceId={workspaceId} role={role} waiting={loaded.waiting} settle={settle} />}

      <KeptDraft
        workspaceId={workspaceId}
        target={{ target: "strategy" }}
        revision={loaded.draftRevision}
        edit={mayEdit(role)}
        onDone={() => void settle(null)}
        preview={(b) => {
          const s = b as StrategyBody;
          return (
            <>
              <p>Who we're for: {s.whoFor}</p>
              <p>Positioning: {s.positioning}</p>
              <p>Channels: {s.channels.map((c) => c.label).join(", ")}</p>
            </>
          );
        }}
      />

      {mayEdit(role) && (
        <details>
          <summary className={buttonVariants({ variant: "outline", size: "sm", className: "w-fit list-none" })}>{current ? "Edit Strategy" : "Write the Strategy"}</summary>
          <div className="mt-4 flex flex-col gap-4">
            <Text label="Tell Direx about the business" long value={request} onChange={setRequest} />
            <Row>
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={!request.trim()}
                onClick={async () => {
                  const r = await startStrategyDraft(workspaceId, request.trim());
                  setDraftError(r.error ? sayDraft(r.error) : undefined);
                  if (!r.error) setRunId(r.runId);
                }}
              >
                Draft it for me
              </Button>
            </Row>
            {draftError && <Notice tone="error">{draftError}</Notice>}
            {runId && <DraftProgress workspaceId={workspaceId} runId={runId} onDone={() => void load()} />}
            <Text label="Who we're for" long value={draft.whoFor} onChange={(whoFor) => set({ whoFor })} />
            <Text label="Positioning" long value={draft.positioning} onChange={(positioning) => set({ positioning })} />
            <fieldset className={FIELDSET}>
              <legend className="px-1 text-sm font-medium">Personas</legend>
              {draft.personas.map((x, i) => (
                <div key={i} className="flex flex-wrap items-center gap-2">
                  <Input aria-label="Persona" className="flex-1" value={x.name} onChange={(e) => set({ personas: draft.personas.map((y, n) => (n === i ? { ...y, name: e.target.value } : y)) })} />
                  <Button type="button" size="sm" variant="outline" aria-label={`Remove persona ${i + 1}`} onClick={() => set({ personas: draft.personas.filter((_, n) => n !== i) })}>
                    Remove
                  </Button>
                </div>
              ))}
              <Row>
                <Button type="button" size="sm" variant="outline" onClick={() => set({ personas: [...draft.personas, { name: "" }] })}>
                  Add a persona
                </Button>
              </Row>
            </fieldset>
            <fieldset className={FIELDSET}>
              <legend className="px-1 text-sm font-medium">Channels and why</legend>
              {draft.channels.map((c, i) => (
                <div key={c.key} className="flex flex-col gap-3 border-t border-border pt-3 first:border-t-0 first:pt-0">
                  <Text label="Channel" value={c.label} onChange={(label) => setChannel(i, { label })} />
                  <div className="flex items-center gap-2 text-sm">
                    <Select label="When" value={c.timing} onChange={(e) => setChannel(i, { timing: e.target.value as Channel["timing"] })}>
                      <option value="now">Now</option>
                      <option value="later">Later</option>
                    </Select></div>
                  <Text label="Why" long value={c.reason} onChange={(reason) => setChannel(i, { reason })} />
                  <div className="flex flex-wrap items-center gap-2">
                    <BasisField value={c.basis} facts={p.facts} cited={loaded.citedReadings} onChange={(basis) => setChannel(i, { basis })} />
                    <Button type="button" size="sm" variant="outline" aria-label={`Remove channel ${i + 1}`} onClick={() => set({ channels: draft.channels.filter((_, n) => n !== i) })}>
                      Remove
                    </Button>
                  </div>
                </div>
              ))}
              <Row>
                <Button type="button" size="sm" variant="outline" onClick={() => set({ channels: [...draft.channels, { key: newKey(), label: "", timing: "now", reason: "", basis: { kind: "assumption" } }] })}>
                  Add a channel
                </Button>
              </Row>
            </fieldset>
            <Assumptions rows={draft.assumptions} onChange={(assumptions) => set({ assumptions })} />
            <Row>
              <Button
                variant="outline"
                onClick={async () => {
                  if ((await save()) === undefined) return;
                  await settle(null);
                  setSaved(true);
                }}
              >
                Save draft
              </Button>
              <Button onClick={submit}>Send for sign-off</Button>
            </Row>
            {/* Beside the buttons that cause them, so a refusal is seen where the person is looking. */}
            {error && <Notice tone="error">{error}</Notice>}
            {saved && !error && <Notice>Draft saved.</Notice>}
          </div>
        </details>
      )}
    </>
  );
}
