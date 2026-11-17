// SPDX-License-Identifier: AGPL-3.0-only
// Import from Notion, on the Calendar: pick a database shared with Direx, say which column is the date,
// the channel and the text, which account each channel posts as, see what each row will do, then
// import. Every post waits for approval, like one written here. Running it again is Check again: a
// post nobody touched in Direx takes Notion's change; one edited or decided here is only flagged.
// A set-up database can also write each row's post state back (ADR 0025): an Owner or Admin picks the
// status column and options and answers yes or no; any member can stop it; held and Blocked writes
// show here, never in Needs you. DocsWriteBack gives every member, Viewers too, each source's state and
// Stop while a yes is unstopped, read from Direx alone (ADR 0025 rule 001).
import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { Dialog, DialogHeader } from "@astryxdesign/core/Dialog";
import { Field, Notice } from "../components/layout";
import { Button } from "@/components/Button";
import { Select, Textarea } from "../components/Input";
import { docsQuery } from "../agents/actions";
import { accountsQuery } from "../social/actions";
import { startConnect } from "../credentials/actions";
import { answerWriteBack, database, databases, preview, runImport, saveMapping, saveWriteBack, say, stoppable, stopWriteBack, writeBackSourcesQuery, writeBackState, writeWords, type Column, type Mapping, type RowPlan, type WriteBack, type WriteBackState } from "./actions";

const PAGE = "page";
const SKIP = "";
type Step = { at: "pick"; list: { id: string; title: string; sourceId: string | null }[] } | { at: "map"; id: string; title: string; columns: Column[]; draft: Mapping } | { at: "preview"; sourceId: string; databaseId: string; rows: RowPlan[]; cut: boolean } | { at: "writeBack"; sourceId: string; title: string; columns: Column[]; state: WriteBackState };
const of = (columns: Column[], types: string[]) => columns.filter((c) => types.includes(c.type));
const count = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

export function DocsImport(p: { workspaceId: string; onDone: () => void }) {
  const { workspaceId } = p;
  const status = useQuery(docsQuery(workspaceId)).data;
  const accounts = useQuery({ ...accountsQuery(workspaceId), enabled: Boolean(status?.connected) }).data ?? [];
  const [step, setStep] = useState<Step>();
  const [open, setOpen] = useState(false);
  const [error, setError] = useState<string>();
  const [done, setDone] = useState<string>();
  const [pending, setPending] = useState(false);
  // On cloud the docs tool connects by signing in to it; which pages Direx sees is chosen on its own consent screen.
  if (status && !status.connected && status.imports && status.signIn) {
    const signIn = status.signIn;
    return (
      <span className="flex items-center gap-2">
        <Button size="sm" variant="outline" pending={pending} onClick={() => void busy(async () => {
          const r = await startConnect(workspaceId, signIn);
          if ("url" in r) location.assign(r.url);
          else setError(say(r.error));
        })}>
          {`Connect ${status.provider}`}
        </Button>
        {error && <span role="alert" className="text-sm text-destructive">{error}</span>}
      </span>
    );
  }
  if (!status?.connected || !status.imports) return null;

  async function busy(fn: () => Promise<void>) {
    setPending(true);
    setError(undefined);
    try {
      await fn();
    } finally {
      setPending(false);
    }
  }
  const start = () => {
    setOpen(true);
    setDone(undefined);
    void busy(async () => {
      const r = await databases(workspaceId);
      if ("error" in r) return setError(say(r.error));
      setStep({ at: "pick", list: r.databases });
    });
  };
  const pick = (id: string) =>
    busy(async () => {
      const r = await database(workspaceId, id);
      if ("error" in r) return setError(say(r.error));
      const first = (types: string[]) => of(r.columns, types)[0]?.name ?? "";
      const text = first(["rich_text"]);
      setStep({ at: "map", id, title: r.title, columns: r.columns, draft: r.mapping ?? { date: first(["date"]), channel: first(["select", "status"]), text: text ? { column: text } : { page: true }, accounts: {} } });
    });
  const showPreview = (sourceId: string, databaseId: string) =>
    busy(async () => {
      const r = await preview(workspaceId, sourceId);
      if ("error" in r) return setError(say(r.error));
      setStep({ at: "preview", sourceId, databaseId, rows: r.rows, cut: r.cut });
    });
  const showWriteBack = (sourceId: string, databaseId: string) =>
    busy(async () => {
      const [d, s] = await Promise.all([database(workspaceId, databaseId), writeBackState(workspaceId, sourceId)]);
      if ("error" in d) return setError(say(d.error));
      if ("error" in s) return setError(say(s.error));
      setStep({ at: "writeBack", sourceId, title: d.title, columns: d.columns, state: s });
    });

  return (
    <>
      <Button size="sm" variant="outline" onClick={start}>
        {`Import from ${status.provider}`}
      </Button>
      <Dialog isOpen={open} onOpenChange={setOpen} purpose="form" width={560}>
        <DialogHeader title={`Import from ${status.provider}`} />
        <div className="flex flex-col gap-4">
          {error && <Notice tone="error">{error}</Notice>}
          {done && <Notice tone="info">{done}</Notice>}
          {step?.at === "pick" &&
            (step.list.length === 0 ? (
              <p className="text-sm text-muted-foreground">No databases are shared with Direx yet. In {status.provider}, open the database's ••• menu and add Direx's integration under Connections.</p>
            ) : (
              <ul aria-label="Databases" className="flex flex-col">
                {step.list.map((d) => (
                  <li key={d.id} className="flex items-center justify-between gap-2 border-t border-border py-2">
                    <span className="text-sm">{d.title}</span>
                    <span className="flex gap-2">
                      {d.sourceId && (
                        <Button size="sm" pending={pending} onClick={() => void showPreview(d.sourceId!, d.id)}>
                          Check again
                        </Button>
                      )}
                      {d.sourceId && (
                        <Button size="sm" variant="outline" pending={pending} onClick={() => void showWriteBack(d.sourceId!, d.id)}>
                          Status write-back
                        </Button>
                      )}
                      <Button size="sm" variant="outline" pending={pending} onClick={() => void pick(d.id)}>
                        {d.sourceId ? "Change columns" : "Set up"}
                      </Button>
                    </span>
                  </li>
                ))}
              </ul>
            ))}
          {step?.at === "map" && (
            <MapForm
              step={step}
              accounts={accounts}
              pending={pending}
              onChange={(draft) => setStep({ ...step, draft })}
              onSave={() =>
                void busy(async () => {
                  const r = await saveMapping(workspaceId, step.id, step.draft);
                  if ("error" in r) return setError(say(r.error));
                  await showPreview(r.sourceId, step.id);
                })
              }
            />
          )}
          {step?.at === "preview" && (
            <Preview
              step={step}
              pending={pending}
              onWriteBack={() => void showWriteBack(step.sourceId, step.databaseId)}
              onImport={() =>
                void busy(async () => {
                  const r = await runImport(workspaceId, step.sourceId);
                  if ("error" in r) return setError(say(r.error));
                  setDone(`${count(r.made, "post")} made, ${r.updated} updated, ${r.changed} changed in ${status.provider} after you edited them here. Each waits for approval.`);
                  setStep(undefined);
                  p.onDone();
                })
              }
            />
          )}
          {step?.at === "writeBack" && (
            <WriteBackStep
              key={step.sourceId}
              workspaceId={workspaceId}
              step={step}
              pending={pending}
              run={(call) =>
                void busy(async () => {
                  const r = await call();
                  if ("error" in r) return setError(say(r.error));
                  setStep({ ...step, state: r });
                })
              }
            />
          )}
        </div>
      </Dialog>
    </>
  );
}

/** Each imported source's status write-back for any member: its state, held and Blocked writes, and Stop. No columns, no question, no import. */
export function DocsWriteBack(p: { workspaceId: string }) {
  const { workspaceId } = p;
  const queries = useQueryClient();
  const list = useQuery(writeBackSourcesQuery(workspaceId)).data?.sources ?? [];
  const [open, setOpen] = useState(false);
  const [at, setAt] = useState<{ sourceId: string; title: string; state: WriteBackState }>();
  const [error, setError] = useState<string>();
  const [pending, setPending] = useState(false);
  if (!open && !list.some((s) => stoppable(s.state))) return null;
  return (
    <>
      <Button size="sm" variant="outline" onClick={() => {
          setOpen(true);
          setAt(undefined);
          setError(undefined);
        }}>
        Status write-back
      </Button>
      <Dialog isOpen={open} onOpenChange={setOpen} purpose="form" width={560}>
        <DialogHeader title="Status write-back" />
        <div className="flex flex-col gap-4">
          {error && <Notice tone="error">{error}</Notice>}
          {at ? (
            <WriteBackStep
              key={at.sourceId}
              stopOnly
              workspaceId={workspaceId}
              step={{ at: "writeBack", sourceId: at.sourceId, title: at.title, columns: [], state: at.state }}
              pending={pending}
              run={(fn) => {
                setPending(true);
                setError(undefined);
                void fn()
                  .then((r) => ("error" in r ? setError(say(r.error)) : setAt({ ...at, state: r })))
                  .finally(() => {
                    setPending(false);
                    void queries.invalidateQueries({ queryKey: writeBackSourcesQuery(workspaceId).queryKey });
                  });
              }}
            />
          ) : (
            <ul aria-label="Imported databases" className="flex flex-col">
              {list.map((s) => (
                <li key={s.id} className="flex items-center justify-between gap-2 border-t border-border py-2 text-sm">
                  <span>{`${s.title}: ${stoppable(s.state) ? "a yes is on" : "off"}`}</span>
                  <Button size="sm" variant="outline" onClick={() => setAt({ sourceId: s.id, title: s.title, state: s.state })}>
                    Open
                  </Button>
                </li>
              ))}
            </ul>
          )}
        </div>
      </Dialog>
    </>
  );
}

function MapForm(p: { step: Extract<Step, { at: "map" }>; accounts: { id: string; name: string; network: string }[]; pending: boolean; onChange: (m: Mapping) => void; onSave: () => void }) {
  const { columns, draft } = p.step;
  const values = columns.find((c) => c.name === draft.channel)?.options ?? [];
  const text = "column" in draft.text ? draft.text.column : PAGE;
  return (
    <form
      className="flex flex-col gap-3"
      onSubmit={(e) => {
        e.preventDefault();
        p.onSave();
      }}
    >
      <p className="text-sm">{p.step.title}</p>
      <Field label="Date">
        <Select value={draft.date} onChange={(e) => p.onChange({ ...draft, date: e.target.value })}>
          {of(columns, ["date"]).map((c) => (
            <option key={c.name} value={c.name}>
              {c.name}
            </option>
          ))}
        </Select>
      </Field>
      <Field label="Channel">
        <Select value={draft.channel} onChange={(e) => p.onChange({ ...draft, channel: e.target.value, accounts: {} })}>
          {of(columns, ["select", "status"]).map((c) => (
            <option key={c.name} value={c.name}>
              {c.name}
            </option>
          ))}
        </Select>
      </Field>
      <Field label="Post text">
        <Select value={text} onChange={(e) => p.onChange({ ...draft, text: e.target.value === PAGE ? { page: true } : { column: e.target.value } })}>
          <option value={PAGE}>The page itself</option>
          {of(columns, ["rich_text", "title"]).map((c) => (
            <option key={c.name} value={c.name}>
              {c.name}
            </option>
          ))}
        </Select>
      </Field>
      {values.map((v) => (
        <Field key={v} label={`${v} posts as`}>
          <Select
            value={draft.accounts[v] ?? SKIP}
            onChange={(e) => {
              const accounts = { ...draft.accounts };
              if (e.target.value === SKIP) delete accounts[v];
              else accounts[v] = e.target.value;
              p.onChange({ ...draft, accounts });
            }}
          >
            <option value={SKIP}>Don't import</option>
            {p.accounts.map((a) => (
              <option key={a.id} value={a.id}>
                {`${a.name} (${a.network})`}
              </option>
            ))}
          </Select>
        </Field>
      ))}
      <Button type="submit" className="self-start" pending={p.pending} disabled={!draft.date || !draft.channel}>
        Save and preview
      </Button>
    </form>
  );
}

function Preview(p: { step: Extract<Step, { at: "preview" }>; pending: boolean; onImport: () => void; onWriteBack: () => void }) {
  const by = (kind: RowPlan["outcome"]) => p.step.rows.filter((r) => r.outcome === kind);
  const [make, update, changed, skip] = [by("make"), by("update"), by("changed"), by("skip")];
  const work = make.length + update.length + changed.length;
  return (
    <div className="flex flex-col gap-3">
      <p className="text-sm">{`${count(make.length, "post")} to make, ${update.length} to update, ${changed.length} changed after you edited them here, ${skip.length} skipped.`}</p>
      {p.step.cut && <Notice tone="info">This database is bigger than one import reads, so only its first 1,000 rows are here.</Notice>}
      {skip.length > 0 && (
        <ul aria-label="Skipped rows" className="flex flex-col gap-1 text-sm text-muted-foreground">
          {skip.map((r) => (
            <li key={r.id}>{`${r.title}: ${say(r.reason ?? "")}`}</li>
          ))}
        </ul>
      )}
      <span className="flex gap-2">
        <Button pending={p.pending} disabled={work === 0} onClick={p.onImport}>
          Import
        </Button>
        <Button variant="outline" pending={p.pending} onClick={p.onWriteBack}>
          Status write-back
        </Button>
      </span>
    </div>
  );
}

const STATES = [
  ["scheduled", "Scheduled"],
  ["sent", "Sent"],
  ["cancelled", "Cancelled"],
] as const;
const NONE: WriteBack = { statusPropertyId: "", statusType: "status", options: {} };
const sameWriteBack = (a: WriteBack, b: WriteBack) => a.statusPropertyId === b.statusPropertyId && a.urlPropertyId === b.urlPropertyId && STATES.every(([s]) => a.options[s] === b.options[s]);
const STOPPED: Record<string, string> = { mapping_changed: "the status columns changed", credential_changed: "the Notion connection changed", mapping_no_longer_fits: "the status columns no longer fit the database" };
const PAUSED = "It needs a new answer from an Owner or Admin.";
function statusWords(s: WriteBackState) {
  const reason = s.grant?.stopReason ?? "";
  switch (s.status) {
    case "on":
      return "Status write-back is on.";
    case "no":
      return "Status write-back is off: the answer was no.";
    case "stopped":
      return `Status write-back is off: ${STOPPED[reason] ?? `stopped, "${reason}"`}.`;
    case "wording_changed":
      return `Status write-back is paused: the question changed. ${PAUSED}`;
    case "mapping_changed":
      return `Status write-back is paused: the status columns or the Notion connection changed. ${PAUSED}`;
    case "granter_lost":
      return `Status write-back is paused: whoever said yes is no longer an Owner or Admin. ${PAUSED}`;
    default:
      return "Status write-back is off. No one has answered yet.";
  }
}

/**
 * Status write-back for one source. The columns and the yes or no are for rule.grant roles only (the
 * server says who through mayAnswer); anyone else reads them. Neither answer starts chosen.
 */
function WriteBackStep(p: { workspaceId: string; step: Extract<Step, { at: "writeBack" }>; stopOnly?: boolean; pending: boolean; run: (call: () => Promise<WriteBackState | { error: string }>) => void }) {
  const { workspaceId, step } = p;
  const { columns, state, sourceId } = step;
  const saved = state.writeBack ?? NONE;
  const [draft, setDraft] = useState<WriteBack>(saved);
  const [answer, setAnswer] = useState<"yes" | "no">();
  const [reason, setReason] = useState("");
  // A new state from the server (saved, answered, stopped) starts afresh: the saved columns, no answer chosen.
  const [shown, setShown] = useState(state);
  if (shown !== state) {
    setShown(state);
    setDraft(saved);
    setAnswer(undefined);
    setReason("");
  }
  const choiceColumns = columns.filter((c) => c.id && (c.type === "status" || c.type === "select"));
  const urlColumns = columns.filter((c) => c.id && c.type === "url");
  const status = columns.find((c) => c.id === draft.statusPropertyId);
  const nameOf = (id: string | undefined) => status?.choices?.find((c) => c.id === id)?.name ?? "not written";
  const on = stoppable(state);
  const mapped = Boolean(draft.statusPropertyId && Object.values(draft.options).some(Boolean));
  return (
    <section aria-label="Status write-back" className="flex flex-col gap-3 text-sm">
      <h3 className="font-medium">{`Status write-back: ${step.title}`}</h3>
      <p>{statusWords(state)}</p>
      {p.stopOnly ? null : state.mayAnswer ? (
        <form
          className="flex flex-col gap-3"
          onSubmit={(e) => {
            e.preventDefault();
            p.run(() => saveWriteBack(workspaceId, sourceId, { ...draft, options: Object.fromEntries(Object.entries(draft.options).filter(([, v]) => v)) }));
          }}
        >
          <Field label="Status column">
            <Select
              value={draft.statusPropertyId}
              onChange={(e) => {
                const c = choiceColumns.find((x) => x.id === e.target.value);
                setDraft({ ...draft, statusPropertyId: e.target.value, statusType: c?.type === "select" ? "select" : "status", options: {} });
              }}
            >
              <option value={SKIP}>Pick a column</option>
              {choiceColumns.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </Select>
          </Field>
          {status &&
            STATES.map(([s, label]) => (
              <Field key={s} label={`${label} shows as`}>
                <Select
                  value={draft.options[s] ?? SKIP}
                  onChange={(e) => {
                    const { [s]: _, ...rest } = draft.options;
                    setDraft({ ...draft, options: e.target.value === SKIP ? rest : { ...rest, [s]: e.target.value } });
                  }}
                >
                  <option value={SKIP}>Don't write</option>
                  {(status.choices ?? []).map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.name}
                    </option>
                  ))}
                </Select>
              </Field>
            ))}
          <Field label="Post link column">
            <Select
              value={draft.urlPropertyId ?? SKIP}
              onChange={(e) => {
                const { urlPropertyId: _, ...rest } = draft;
                setDraft(e.target.value === SKIP ? rest : { ...rest, urlPropertyId: e.target.value });
              }}
            >
              <option value={SKIP}>No link</option>
              {urlColumns.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </Select>
          </Field>
          <Button type="submit" variant="outline" className="self-start" pending={p.pending} disabled={!mapped || sameWriteBack(draft, saved)}>
            Save status columns
          </Button>
        </form>
      ) : state.writeBack ? (
        <p>{`Writes to ${status?.name ?? "a column no longer in the database"}: ${STATES.map(([s, label]) => `${label} as ${nameOf(saved.options[s])}`).join(", ")}. Post link: ${urlColumns.find((c) => c.id === saved.urlPropertyId)?.name ?? "none"}. Only an Owner or Admin can change this.`}</p>
      ) : (
        <p>No status columns are picked yet. An Owner or Admin picks them.</p>
      )}
      {!p.stopOnly && state.mayAnswer && state.writeBack && !on && sameWriteBack(draft, saved) && (
        <form
          className="flex flex-col gap-3"
          onSubmit={(e) => {
            e.preventDefault();
            if (answer) p.run(() => answerWriteBack(workspaceId, sourceId, { answer, wordingVersion: state.wordingVersion }));
          }}
        >
          {state.wording.split("\n\n").map((line) => (
            <p key={line}>{line}</p>
          ))}
          {/* Native radios: a yes or no with neither chosen; no Astryx component fits (ADR 0020 lists none for radios). */}
          <fieldset className="flex gap-4">
            <legend className="sr-only">Let Direx update these rows' status?</legend>
            {(["yes", "no"] as const).map((a) => (
              <label key={a} className="flex items-center gap-2">
                <input type="radio" name="write-back-answer" value={a} checked={answer === a} onChange={() => setAnswer(a)} className="size-4 accent-primary" />
                {a === "yes" ? "Yes" : "No"}
              </label>
            ))}
          </fieldset>
          <Button type="submit" className="self-start" pending={p.pending} disabled={!answer}>
            Save answer
          </Button>
        </form>
      )}
      {on && (
        <form
          className="flex flex-col gap-3"
          onSubmit={(e) => {
            e.preventDefault();
            p.run(async () => {
              const r = await stopWriteBack(workspaceId, sourceId, reason.trim());
              return "error" in r ? r : r.state;
            });
          }}
        >
          <Textarea label="Why stop it?" required maxLength={500} value={reason} onChange={(e) => setReason(e.target.value)} />
          <Button type="submit" variant="outline" className="self-start" pending={p.pending} disabled={!reason.trim()}>
            Stop status write-back
          </Button>
        </form>
      )}
      {state.writes.length > 0 && (
        <>
          <h4 className="font-medium">Not written</h4>
          <ul aria-label="Write-backs not written" className="flex flex-col gap-1">
            {state.writes.map((w) => (
              <li key={`${w.rowId}-${w.itemId}`}>
                {`${writeWords(w)} `}
                <Link className="underline" to="/w/$workspaceId/review/$itemId" params={{ workspaceId, itemId: w.itemId }}>
                  Open the post
                </Link>
              </li>
            ))}
          </ul>
        </>
      )}
    </section>
  );
}
