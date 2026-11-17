// SPDX-License-Identifier: AGPL-3.0-only
// An email step in template mode: the email as it will appear first, then Edit and Make drafts. Each
// button says what it does, and approving stays in Needs approval.
import { useEffect, useState, type ReactNode } from "react";
import { Field, Notice } from "../components/layout";
import { Button } from "@/components/Button";
import { Input, Textarea } from "@/components/Input";
import { toast } from "@/components/toast";
import { useAction } from "../components/useAction";
import { DraftProgress, KeptDraft } from "../plans/Fields";
import { RememberThis } from "../lessons/RememberThis";
import { Content } from "../items/ItemPanel";
import { mailboxes } from "../outreach/actions";
import { dayWords, draftsPreview, makeDrafts, saveTemplate, say, sayLeftOut, talkingLine, startStepDraft, type DraftsPreview, type Step } from "./actions";

const drafts = (n: number) => `${n} draft${n === 1 ? "" : "s"}`;
const FIELD_HELP = "You can use {{firstName}}, {{company}} and {{senderName}}. Direx adds your address and an unsubscribe link at the end.";
const TOKEN_WORDS: Record<string, string> = { firstName: "first name", company: "company", senderName: "your name" };

/** Text with each {{field}} shown as a chip naming what goes there, so a reader sees what changes per person. */
export function withTokens(text: string): ReactNode {
  return text.split(/(\{\{\s*\w+\s*\}\})/).map((part, n) => {
    const field = /^\{\{\s*(\w+)\s*\}\}$/.exec(part)?.[1];
    if (!field) return part;
    const words = TOKEN_WORDS[field] ?? field.replace(/([A-Z])/g, " $1").toLowerCase();
    return (
      <mark key={n} className="rounded-sm border border-border bg-muted px-1 font-medium text-foreground">
        {words}
      </mark>
    );
  });
}

/** Who it goes to, from which Mailbox and on which day, above the email, so approving never means guessing. */
function Confirm(p: { people?: number; from?: string; on: string | null }) {
  const cell = (term: string, value: ReactNode, hint?: string) => (
    <div className="flex min-w-32 flex-1 flex-col gap-0.5">
      <dt className="text-xs text-muted-foreground">{term}</dt>
      <dd className="font-medium">{value}</dd>
      {hint && <dd className="text-xs text-muted-foreground">{hint}</dd>}
    </div>
  );
  return (
    <dl aria-label="Where it goes" className="flex flex-wrap gap-4 rounded-card border border-border bg-card px-4 py-3 text-sm">
      {p.people !== undefined && cell("To", `${p.people} ${p.people === 1 ? "person" : "people"}`)}
      {cell("From", p.from ?? "No Mailbox yet", p.from ? undefined : "Choose one in Step settings")}
      {cell("Sends", p.on ? dayWords(p.on) : "No date yet", p.on ? "Times set by its Mailbox's sending hours" : undefined)}
    </dl>
  );
}

export function TemplateStep(p: { workspaceId: string; id: string; step: Step; edit: boolean; onChange: () => void; initialPreview?: DraftsPreview }) {
  const { workspaceId, id, step } = p;
  const name = step.title ?? step.key;
  const [subject, setSubject] = useState(step.template?.subject ?? "");
  const [text, setText] = useState(step.template?.text ?? "");
  const [preview, setPreview] = useState(p.initialPreview);
  const [blocked, setBlocked] = useState<string>();
  const [runId, setRunId] = useState<string>();
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string>();
  const [saved, setSaved] = useState(false);
  // The email shows as it will appear; the form opens on Edit, or at once when there is nothing to show yet.
  const [editing, setEditing] = useState(!step.template);
  const [from, setFrom] = useState<string>();
  const starting = useAction();
  const saving = useAction();
  const making = useAction();

  const loadPreview = async () => {
    if (!step.template) return;
    const r = await draftsPreview(workspaceId, id, step.key);
    setBlocked("error" in r ? say(r.error) : undefined);
    setPreview("error" in r ? undefined : r);
  };
  useEffect(() => {
    setSubject(step.template?.subject ?? "");
    setText(step.template?.text ?? "");
    setEditing(!step.template);
    void loadPreview();
  }, [workspaceId, id, step.key, step.templateRevision]);
  useEffect(() => {
    if (step.mailboxCredentialId) void mailboxes(workspaceId).then((bs) => setFrom(bs.find((b) => b.id === step.mailboxCredentialId)?.name));
  }, [workspaceId, step.mailboxCredentialId]);

  const decide = step.template?.needsDecision ?? [];
  const made = preview?.already ?? 0;
  return (
    <section aria-label={`Email for ${name}`} className="flex flex-col gap-4">
      {step.template && <Confirm people={preview ? preview.willMake + preview.already : undefined} from={from} on={step.on} />}
      {step.template && !editing && (
        <article aria-label="Email as it will appear" className="flex flex-col overflow-hidden rounded-card border border-border bg-card">
          <header className="flex flex-col gap-1 border-b border-border px-4 py-3">
            <p className="font-medium">{withTokens(step.template.subject)}</p>
            <p className="text-sm text-muted-foreground">{`${from ?? "Your Mailbox"} to each person in this step`}</p>
          </header>
          <div className="px-4 py-3 wrap-break-word whitespace-pre-wrap">{withTokens(step.template.text)}</div>
        </article>
      )}
      {p.edit && step.template && !editing && (
        <Button type="button" size="sm" variant="outline" className="self-start" onClick={() => setEditing(true)}>
          Edit email
        </Button>
      )}
      {error && <Notice tone="error">{error}</Notice>}
      {saved && <RememberThis workspaceId={workspaceId} agent="campaign_drafter" sourceRef={`campaign:${id}/${step.key}`} />}
      {runId && (
        <DraftProgress
          workspaceId={workspaceId}
          runId={runId}
          onDone={() => {
            setRunning(false);
            p.onChange();
          }}
        />
      )}
      {made === 0 && (
        <KeptDraft
          workspaceId={workspaceId}
          target={{ target: "step", id, stepKey: step.key }}
          revision={step.templateRevision}
          edit={p.edit}
          onDone={p.onChange}
          preview={(b) => {
            const t = b as { subject?: string; text: string };
            return (
              <blockquote className="flex flex-col gap-2 rounded-card bg-muted p-4">
                {t.subject && <p>Subject: {t.subject}</p>}
                <p className="whitespace-pre-wrap">{t.text}</p>
              </blockquote>
            );
          }}
        />
      )}
      {p.edit && made === 0 && (
        <Button
          type="button"
          size="sm"
          variant="outline"
          className="self-start"
          disabled={running}
          pending={starting.pending}
          onClick={() =>
            void starting.run(async () => {
              const r = await startStepDraft(workspaceId, id, step.key);
              setSaved(false);
              setError("error" in r ? say(r.error) : undefined);
              if ("error" in r) return null;
              setRunning(true);
              setRunId(r.runId);
              return null;
            })
          }
        >
          {step.template ? `Write ${name} again` : `Write ${name}`}
        </Button>
      )}
      {p.edit && editing && (
        <form
          className="flex flex-col gap-3"
          onSubmit={async (e) => {
            e.preventDefault();
            await saving.run(async () => {
              const r = await saveTemplate(workspaceId, id, step.key, { revision: step.templateRevision, subject, text });
              setSaved(!("error" in r));
              setError("error" in r ? say(r.error) : undefined);
              if ("error" in r) return null;
              setEditing(false);
              toast.add({
                title:
                  r.revised || r.failed.length
                    ? `Saved. ${drafts(r.revised)} not yet sent now say this and need approving again.${r.failed.length ? ` ${r.failed.length} didn't change, because they were already sent or are missing a field.` : ""}`
                    : "Saved.",
              });
              p.onChange();
              return null;
            });
          }}
        >
          <Field label="Subject">
            <Input value={subject} maxLength={200} required onChange={(e) => setSubject(e.target.value)} />
          </Field>
          <Field label="Email" hint={FIELD_HELP}>
            <Textarea value={text} maxLength={5000} required rows={8} onChange={(e) => setText(e.target.value)} />
          </Field>
          <div className="flex flex-wrap gap-2">
            <Button type="submit" size="sm" pending={saving.pending}>
              Save email
            </Button>
            {step.template && (
              <Button type="button" size="sm" variant="ghost" disabled={saving.pending} onClick={() => setEditing(false)}>
                Cancel
              </Button>
            )}
          </div>
        </form>
      )}
      {step.template && step.template.warnings.length > 0 && (
        <ul aria-label="Warnings" className="flex list-disc flex-col gap-1 pl-5 text-sm">
          {step.template.warnings.map((w) => (
            <li key={w.text}>{w.text}</li>
          ))}
        </ul>
      )}
      {decide.length > 0 && (
        <div role="alert" className="flex flex-col gap-2 rounded-card bg-destructive-tint px-4 py-3 text-destructive">
          <p>Needs a decision. Change this before any draft can be made:</p>
          <ul className="list-disc pl-5">
            {decide.map((w) => (
              <li key={w.text}>{w.text}</li>
            ))}
          </ul>
        </div>
      )}
      {blocked && <p className="text-muted-foreground">Drafts can't be made yet. {blocked}</p>}
      {preview && (
        <>
          {preview.sample && (
            <details className="text-sm">
              <summary className="cursor-pointer text-muted-foreground">{`Filled in for ${preview.sample.email ?? "one person"}`}</summary>
              <Content content={{ to: preview.sample.email ? [preview.sample.email] : [], subject: preview.sample.subject, text: preview.sample.text }} appearance={from ? { kind: "email", from } : null} />
            </details>
          )}
          {made > 0 && <p>{drafts(made)} made. Approve them on Home.</p>}
          {preview.leftOut.length > 0 && (
            <>
              {talkingLine(preview.leftOut, preview.willMake + preview.already + preview.leftOut.length) && <p>{talkingLine(preview.leftOut, preview.willMake + preview.already + preview.leftOut.length)}</p>}
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
          {p.edit && !editing && preview.willMake > 0 && decide.length === 0 && (
            <Button
              type="button"
              size="sm"
              className="self-start"
              pending={making.pending}
              onClick={() =>
                void making.run(async () => {
                  const r = await makeDrafts(workspaceId, id, step.key, Intl.DateTimeFormat().resolvedOptions().timeZone);
                  setError("error" in r ? say(r.error) : undefined);
                  if ("error" in r) return null;
                  setSaved(false);
                  toast.add({ title: `${drafts(r.results.filter((x) => x.ok && !x.already).length)} waiting for approval. Nothing is sent until each is approved.` });
                  await loadPreview();
                  return null;
                })
              }
            >
              Make {drafts(preview.willMake)}
            </Button>
          )}
        </>
      )}
    </section>
  );
}
