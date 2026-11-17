// SPDX-License-Identifier: AGPL-3.0-only
// A per-address step's notes for its writer. When a person keeps making the same edit, this offers it as a
// note, so they fix the instructions once instead of every draft. Rewriting the drafts nobody approved yet
// says how many and what it could cost before anything starts.
import { useEffect, useState } from "react";
import { Field, Notice } from "../components/layout";
import { Button } from "@/components/Button";
import { Textarea } from "@/components/Input";
import { useAction } from "../components/useAction";
import { REASONS } from "../items/Rewrite";
import { isLive, runDetail, stopReason, type RunDetail } from "../agents/actions";
import { noteFor, redraftStep, repeatedEdits, repeatedReasons, saveWriterNotes, say, type Step } from "./actions";

type Repeated = { phrase: string; count: number }[];
type Reasons = Awaited<ReturnType<typeof repeatedReasons>>;
const drafts = (n: number) => `${n} draft${n === 1 ? "" : "s"}`;
const emails = (n: number) => `${n} email${n === 1 ? "" : "s"}`;
const labelOf = (reason: string) => REASONS.find(([key]) => key === reason)?.[1] ?? reason;
const add = (notes: string, line: string) => (notes ? `${notes}\n${line}` : line);

/** What the rewrites came to once every run ended: how many landed, and why the rest didn't. */
function ended(ran: RunDetail[]): { tone: "error" | "info"; text: string } {
  const landed = ran.filter((r) => r.status === "succeeded" && !r.proposals.some((x) => x.rejectionCode)).length;
  if (landed === ran.length) return { tone: "info", text: `Rewrote ${drafts(landed)}. Read each one before you approve.` };
  const stopped = ran.find((r) => r.status !== "succeeded");
  const why = stopped ? stopReason(stopped) : "it didn't pass Direx's checks, so the email stays as it was";
  const left = ran.length - landed;
  return { tone: "error", text: `${landed ? `Rewrote ${drafts(landed)}. ` : ""}${drafts(left)} ${left === 1 ? "wasn't" : "weren't"} rewritten: ${why}.` };
}

export function WriterNotes(p: { workspaceId: string; id: string; step: Step; edit: boolean; onRedraft: () => void; initial?: Repeated; initialReasons?: Reasons }) {
  const { workspaceId, id, step } = p;
  const [notes, setNotes] = useState(step.writerNotes ?? "");
  const [revision, setRevision] = useState(step.writerNotesRevision);
  const [saved, setSaved] = useState(step.writerNotes ?? "");
  const [repeated, setRepeated] = useState<Repeated>(p.initial ?? []);
  const [reasons, setReasons] = useState<Reasons>(p.initialReasons ?? []);
  const [cost, setCost] = useState<{ runs: number; worstCaseCents: number }>();
  const [message, setMessage] = useState<{ tone: "error" | "info"; text: string }>();
  const saving = useAction();
  const rewriting = useAction();
  // The rewrite runs just started, watched until each ends so the page says how they went.
  const [watching, setWatching] = useState<string[]>([]);

  useEffect(() => {
    if (!watching.length) return;
    let over = false;
    const t = setInterval(() => {
      void Promise.all(watching.map((r) => runDetail(workspaceId, r))).then((ran) => {
        if (over || ran.some((r) => !r || isLive(r))) return;
        over = true;
        clearInterval(t);
        setWatching([]);
        setMessage(ended(ran as RunDetail[]));
        p.onRedraft();
      });
    }, 3_000);
    return () => {
      over = true;
      clearInterval(t);
    };
  }, [watching]);

  useEffect(() => {
    // Given what's repeated up front (a test or a sample), nothing is fetched.
    if (p.initial) return;
    void repeatedEdits(workspaceId, id, step.key).then(setRepeated);
    void repeatedReasons(workspaceId, id, step.key).then(setReasons);
  }, [workspaceId, id, step.key]);

  const offered = repeated.filter((r) => !notes.includes(noteFor(r.phrase)));
  const offeredReasons = reasons.filter((r) => !notes.includes(r.words));
  if (!p.edit) return saved ? <p className="text-sm">Writer notes: {saved}</p> : null;

  return (
    <section aria-label="Writer notes" className="flex flex-col gap-3">
      {offeredReasons.map((r) => (
        <Notice key={r.reason} tone="info">
          {emails(r.count)} on this step were marked {labelOf(r.reason)}. Put it in this step's writer notes, so the next drafts follow it?{" "}
          <Button type="button" size="sm" variant="outline" onClick={() => setNotes((n) => add(n, r.words))}>
            Add to the notes
          </Button>
        </Notice>
      ))}
      {offered.map((r) => (
        <Notice key={r.phrase} tone="info">
          You've {r.phrase.startsWith("-") ? "cut" : "added"} the same words in {drafts(r.count)}: "{r.phrase.slice(1)}". Put it in this step's writer notes, so the next drafts follow it?{" "}
          <Button type="button" size="sm" variant="outline" onClick={() => setNotes((n) => add(n, noteFor(r.phrase)))}>
            Add to the notes
          </Button>
        </Notice>
      ))}
      {message && <Notice tone={message.tone}>{message.text}</Notice>}
      <form
        className="flex flex-col gap-3"
        onSubmit={async (e) => {
          e.preventDefault();
          await saving.run(async () => {
            const r = await saveWriterNotes(workspaceId, id, step.key, { notes, revision });
            if ("error" in r) setMessage({ tone: "error", text: say(r.error) });
            else {
              setRevision(r.revision);
              setSaved(notes.trim());
              setMessage({ tone: "info", text: "Saved. New drafts follow these notes." });
            }
            return null;
          });
        }}
      >
        <Field label="Writer notes" hint="What the writer should do or avoid in every email of this step.">
          <Textarea value={notes} maxLength={2000} rows={3} onChange={(e) => setNotes(e.target.value)} />
        </Field>
        <Button type="submit" size="sm" variant="outline" className="self-start" pending={saving.pending} disabled={notes.trim() === saved}>
          Save notes
        </Button>
      </form>
      {saved && !cost && (
        <Button
          type="button"
          size="sm"
          variant="outline"
          className="self-start"
          pending={rewriting.pending}
          onClick={() =>
            void rewriting.run(async () => {
              const r = await redraftStep(workspaceId, id, step.key, false);
              if ("error" in r) setMessage({ tone: "error", text: say(r.error) });
              else if (r.runs === 0) setMessage({ tone: "info", text: "Every draft here is approved or gone, so there's nothing to rewrite." });
              else setCost(r);
              return null;
            })
          }
        >
          Rewrite the drafts nobody approved
        </Button>
      )}
      {cost && (
        <div className="flex flex-col gap-2">
          <p>
            That rewrites {drafts(cost.runs)}, at most ${(cost.worstCaseCents / 100).toFixed(2)} in model costs. Each one waits for approval again.
          </p>
          <div className="flex gap-2">
            <Button
              type="button"
              size="sm"
              pending={rewriting.pending}
              onClick={() =>
                void rewriting.run(async () => {
                  const r = await redraftStep(workspaceId, id, step.key, true);
                  setCost(undefined);
                  setMessage("error" in r ? { tone: "error", text: say(r.error) } : { tone: "info", text: `Rewriting ${drafts(r.started)}. They appear below as they finish.` });
                  if (!("error" in r)) {
                    p.onRedraft();
                    setWatching(r.runIds ?? []);
                  }
                  return null;
                })
              }
            >
              Rewrite {drafts(cost.runs)}
            </Button>
            <Button type="button" size="sm" variant="ghost" onClick={() => setCost(undefined)}>
              Cancel
            </Button>
          </div>
        </div>
      )}
    </section>
  );
}
