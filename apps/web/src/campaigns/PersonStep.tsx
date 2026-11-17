// SPDX-License-Identifier: AGPL-3.0-only
// An email step that writes one email per address: what it will cost, the runs as they finish, and each
// draft with what it says about the person and where that came from. Approving stays on Home.
import { useEffect, useState } from "react";
import { cancelRun, isLive, listRuns, runDetail } from "../agents/actions";
import { Field, Notice } from "../components/layout";
import { Button } from "@/components/Button";
import { Input, Textarea } from "@/components/Input";
import { useAction } from "../components/useAction";
import type { ItemState } from "../items/actions";
import { StateChip } from "../items/StateChip";
import { Content } from "../items/ItemPanel";
import { draftOutcome } from "../plans/actions";
import { RememberThis } from "../lessons/RememberThis";
import { editPersonDraft, personDrafts, personPreview, say, sayLeftOut, talkingLine, writePerPerson, type PersonDraft, type PersonPreview, type Step } from "./actions";
import { WriterNotes } from "./WriterNotes";

const POLL_MS = 5000;
// A big list runs over days, so each look checks a few of the runs still going.
const RUNS_PER_POLL = 20;
const emails = (n: number) => `${n} email${n === 1 ? "" : "s"}`;

function DraftRow(p: { workspaceId: string; id: string; stepKey: string; draft: PersonDraft; edit: boolean; onChange: () => void }) {
  const { draft: x } = p;
  const [subject, setSubject] = useState(x.subject);
  const [text, setText] = useState(x.text);
  const [error, setError] = useState<string>();
  const [saved, setSaved] = useState(false);
  const saving = useAction();
  const locked = x.warnings.some((w) => w.text.startsWith("Needs a decision"));
  return (
    <li className="flex flex-col gap-3 border-t border-border py-4 first:border-t-0 first:pt-0">
      <p className="flex flex-wrap items-center gap-2">
        <strong>{x.email}</strong> <StateChip state={x.state as ItemState} />
      </p>
      <ul aria-label={`Warnings for ${x.email}`} className="flex list-disc flex-col gap-1 pl-5 text-sm">
        {x.warnings.map((w) => (
          <li key={w.text}>{w.text}</li>
        ))}
      </ul>
      {error && <Notice tone="error">{error}</Notice>}
      {/* The email as it will arrive, with what was written for this person marked. */}
      <Content content={{ to: x.email ? [x.email] : [], subject: x.subject, text: x.text }} spans={x.spans} />
      {p.edit && x.editable && (
        // Folded behind Edit, except when a decision blocks it: then the fix is the next thing to do.
        <details open={locked}>
          <summary className="mb-3 cursor-pointer text-sm text-muted-foreground">{`Edit ${x.email ?? "this email"}`}</summary>
        <form
          className="flex flex-col gap-3"
          onSubmit={async (e) => {
            e.preventDefault();
            await saving.run(async () => {
              const failed = await editPersonDraft(p.workspaceId, p.id, p.stepKey, x.personId, { subject, text });
              setError(failed ? say(failed) : undefined);
              setSaved(!failed);
              if (!failed) p.onChange();
              return null;
            });
          }}
        >
          <Field label="Subject">
            <Input value={subject} maxLength={200} required onChange={(e) => setSubject(e.target.value)} />
          </Field>
          <Field label="Email">
            <Textarea value={text} maxLength={5000} required rows={6} onChange={(e) => setText(e.target.value)} />
          </Field>
          <Button type="submit" size="sm" variant="outline" className="self-start" pending={saving.pending}>
            {locked ? `Fix and send ${x.email} for approval` : `Save ${x.email}`}
          </Button>
          {saved && <RememberThis workspaceId={p.workspaceId} agent="recipient_writer" sourceRef={`campaign:${p.id}/${p.stepKey}/${x.personId}`} />}
        </form>
        </details>
      )}
    </li>
  );
}

export function PersonStep(p: { workspaceId: string; id: string; step: Step; edit: boolean; initial?: { preview: PersonPreview; drafts: PersonDraft[] } }) {
  const { workspaceId, id, step } = p;
  const [preview, setPreview] = useState(p.initial?.preview);
  const [drafts, setDrafts] = useState<PersonDraft[]>(p.initial?.drafts ?? []);
  const [blocked, setBlocked] = useState<string>();
  const [error, setError] = useState<string>();
  const [runIds, setRunIds] = useState<string[]>([]);
  const [stopped, setStopped] = useState<{ count: number; why: string }>();
  const writing = useAction();
  const cancelling = useAction();
  const waiting = runIds.length > 0;

  const load = async () => {
    const r = await personPreview(workspaceId, id, step.key);
    setBlocked("error" in r ? say(r.error) : undefined);
    setPreview("error" in r ? undefined : r);
    setDrafts(await personDrafts(workspaceId, id, step.key));
  };
  /** Follows the runs, because one that stops makes no draft and nothing else would say so. */
  const follow = async () => {
    const checked = await Promise.all(runIds.slice(0, RUNS_PER_POLL).map((runId) => runDetail(workspaceId, runId)));
    const ended = checked.flatMap((run) => (run && !isLive(run) ? [run] : []));
    const failed = ended.filter((run) => run.status !== "succeeded");
    if (failed.length) setStopped((was) => ({ count: (was?.count ?? 0) + failed.length, why: draftOutcome(failed[0]!) }));
    const done = new Set(ended.map((run) => run.id));
    // A reader that finished handed its person to a writer run, started before it ended; the draft comes from that one, so it is followed too.
    const read = ended.filter((run) => run.status === "succeeded" && run.agent === "recipient_reader");
    const since = read.map((run) => run.createdAt).sort()[0];
    const writers = since ? (await listRuns(workspaceId, "recipient_writer")).filter((run) => isLive(run) && run.createdAt >= since).map((run) => run.id) : [];
    setRunIds((ids) => [...ids.filter((x) => !done.has(x)), ...writers.filter((x) => !ids.includes(x))]);
    await load();
  };
  useEffect(() => void load(), [workspaceId, id, step.key, step.mailboxCredentialIds.join()]);
  useEffect(() => {
    if (!waiting) return;
    const timer = setInterval(() => void follow(), POLL_MS);
    return () => clearInterval(timer);
  }, [waiting, runIds]);

  return (
    <section aria-label={`Emails for ${step.title ?? step.key}`} className="flex flex-col gap-4">
      {error && <Notice tone="error">{error}</Notice>}
      {blocked && <p className="text-muted-foreground">Emails can't be written yet. {blocked}</p>}
      {preview && (
        <>
          {preview.willWrite > 0 && (
            <p>
              {emails(preview.willWrite)} to write. At most ${(preview.worstCaseCents / 100).toFixed(2)} in model costs, over about {preview.days} day{preview.days === 1 ? "" : "s"}. Each is approved on its own.
              {preview.generic > 0 && ` ${emails(preview.generic)} will be general, with no website to read.`}
            </p>
          )}
          {stopped && (
            <Notice tone="error">
              {emails(stopped.count)} couldn't be written. {stopped.why}
            </Notice>
          )}
          {waiting && (
            <div role="status" className="flex flex-wrap items-center gap-3 rounded-card bg-muted px-4 py-3">
              <p>Writing. New drafts appear below as they finish. Nothing is sent until each is approved.</p>
              {p.edit && (
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  pending={cancelling.pending}
                  aria-label="Cancel the emails still being written"
                  onClick={() =>
                    void cancelling.run(async () => {
                      // Drafts already written stay; the next check sees the rest cancelled and says how many.
                      const refused = (await Promise.all(runIds.map((runId) => cancelRun(workspaceId, runId)))).filter((c) => c && c !== "already_ended");
                      if (refused.length) setError(`${emails(refused.length)} couldn't be cancelled. Only the person who started them or an Admin can cancel them.`);
                      await follow();
                      return null;
                    })
                  }
                >
                  Cancel
                </Button>
              )}
            </div>
          )}
          {p.edit && preview.willWrite > 0 && !waiting && (
            <Button
              type="button"
              size="sm"
              className="self-start"
              pending={writing.pending}
              onClick={() =>
                void writing.run(async () => {
                  const r = await writePerPerson(workspaceId, id, step.key, Intl.DateTimeFormat().resolvedOptions().timeZone);
                  if ("error" in r) setError(say(r.error));
                  else {
                    setError(r.failed.length ? `${emails(r.failed.length)} couldn't start. ${say(r.failed[0]!.reason)}` : undefined);
                    setStopped(undefined);
                    setRunIds(r.runIds);
                  }
                  return null;
                })
              }
            >
              Write {emails(preview.willWrite)}
            </Button>
          )}
          {preview.leftOut.length > 0 && (
            <>
              {talkingLine(preview.leftOut, preview.willWrite + preview.already + preview.leftOut.length) && <p>{talkingLine(preview.leftOut, preview.willWrite + preview.already + preview.leftOut.length)}</p>}
              <p>{preview.leftOut.length} left out:</p>
              <ul aria-label="Left out" className="flex list-disc flex-col gap-1 pl-5 text-sm">
                {preview.leftOut.map((x) => (
                  <li key={x.email}>
                    {x.email}: {sayLeftOut(x.leftOut)}
                  </li>
                ))}
              </ul>
            </>
          )}
        </>
      )}
      {drafts.length > 0 && (
        <ul aria-label="Drafts" className="flex flex-col">
          {drafts.map((x) => (
            <DraftRow key={x.personId} workspaceId={workspaceId} id={id} stepKey={step.key} draft={x} edit={p.edit} onChange={() => void load()} />
          ))}
        </ul>
      )}
      {/* Notes for the writer are settings, so they come after the drafts they shape. */}
      {drafts.length > 0 && <WriterNotes workspaceId={workspaceId} id={id} step={step} edit={p.edit} onRedraft={() => void load()} initial={p.initial ? [] : undefined} />}
    </section>
  );
}
