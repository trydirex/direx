// SPDX-License-Identifier: AGPL-3.0-only
import { useEffect, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { inWorkspace } from "../api/query";
import { Field, Notice, Page, Section } from "../components/layout";
import { QueryBoundary } from "../components/QueryBoundary";
import { Button } from "@/components/Button";
import { Input, Textarea } from "@/components/Input";
import { Skeleton } from "@astryxdesign/core/Skeleton";
import { toast } from "@/components/toast";
import { useAction } from "../components/useAction";
import { approve, mayApprove, mayEdit, type ItemState, type Role } from "../items/actions";
import { StateChip } from "../items/StateChip";
import { audienceWords, clickRate, ISSUE_MESSAGES, issueQuery, issuesQuery, markIssueSent, previewHtml, saveIssue, sayIssue, settingsQuery, slotWords, statsWords, submitIssue, type Issue as IssueData, type IssueStats } from "./actions";

// Times are in the newsletter's own zone once its settings load, named, so a send time reads the same
// to a teammate elsewhere; until then the browser's zone, written out.
const when = (iso: string, zone?: string) => (zone ? `${slotWords(iso, zone)} (${zone})` : new Date(iso).toLocaleString(undefined, { weekday: "long", day: "numeric", month: "long", hour: "2-digit", minute: "2-digit", timeZoneName: "short" }));
// 24-hour like slotWords, so one sentence never mixes 09:00 and 09:00 AM.
const time = (iso: string, zone?: string) => new Date(iso).toLocaleTimeString("en-GB", { timeZone: zone, hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
const short = (iso: string, zone?: string) => new Date(iso).toLocaleString("en-GB", { timeZone: zone, weekday: "short", hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
const OPEN = new Set(["draft", "needs_approval", "scheduled"]);

/**
 * One weekly issue: write it in Markdown beside a preview of exactly what goes out, send it for
 * approval, and see what the tool reported afterwards. A handoff shows the HTML to copy instead,
 * and a person says when they sent it. The header holds the state and the one next step.
 */
export function Issue(p: { workspaceId: string; itemId: string; role: Role; initial?: IssueData }) {
  const query = useQuery({ ...issueQuery(p.workspaceId, p.itemId), initialData: p.initial });
  const [error, setError] = useState<string>();
  const issue = query.data;
  // What is typed lives here, not in the form, so the header's next step acts on what is on screen.
  // Edits belong to one revision: a save or a reload starts again from what the server holds.
  const [draft, setDraft] = useState<Draft & { revision: number }>();
  const edits = issue && draft?.revision === issue.revision ? draft : undefined;
  const fields: Draft | undefined = issue && { title: edits?.title ?? issue.title, previewText: edits?.previewText ?? issue.previewText, markdown: edits?.markdown ?? issue.markdown };
  const dirty = !!issue && !!fields && (fields.title !== issue.title || fields.previewText !== issue.previewText || fields.markdown !== issue.markdown);
  const edit = (patch: Partial<Draft>) => issue && fields && setDraft({ ...fields, ...patch, revision: issue.revision });
  const saved = () => setDraft(undefined);
  // Who the issue goes to and in which zone; the page works without them while they load.
  const settings = useQuery(settingsQuery(p.workspaceId)).data;
  const zone = settings?.settings?.timeZone;
  const audience = settings?.settings ? audienceWords(settings) : null;
  return (
    <Page title={issue?.title || "Newsletter issue"} description={issue && <Meta issue={issue} zone={zone} audience={audience} />} actions={issue && fields && <Primary key={issue.revision} {...p} issue={issue} setError={setError} zone={zone} fields={fields} dirty={dirty} saved={saved} />}>
      {error && <Notice tone="error">{error}</Notice>}
      <QueryBoundary query={query} skeleton={<Skeleton className="h-96 w-full" />} messages={ISSUE_MESSAGES}>
        {(issue) => fields && <Body key={issue.revision} {...p} issue={issue} setError={setError} zone={zone} fields={fields} dirty={dirty} saved={saved} edit={edit} />}
      </QueryBoundary>
    </Page>
  );
}

type Draft = { title: string; previewText: string; markdown: string };
type Props = { workspaceId: string; itemId: string; role: Role; issue: IssueData; setError: (e: string | undefined) => void; zone?: string; fields: Draft; dirty: boolean; saved: () => void };

/** The save body: an empty preview text is left out, as the form always sent it. */
const saveBody = (f: Draft) => {
  const previewText = f.previewText.trim();
  return { title: f.title, ...(previewText && { previewText }), markdown: f.markdown };
};

/** A refusal stays on the page; what worked says so once. */
function useOutcome({ workspaceId, itemId, setError }: Props) {
  const client = useQueryClient();
  const reload = () => client.invalidateQueries({ queryKey: inWorkspace(workspaceId) });
  const outcome = async (r: IssueData | string, done: string) => {
    if (typeof r === "string") return setError(sayIssue(r));
    setError(undefined);
    toast.add({ title: done });
    client.setQueryData(issueQuery(workspaceId, itemId).queryKey, r);
    await reload();
  };
  return { reload, outcome };
}

/** The issue's state, when it goes out and to whom, under the subject. */
function Meta({ issue, zone, audience }: { issue: IssueData; zone?: string; audience: string | null }) {
  const handoff = issue.handoffTo;
  // A tool that is handed issues early stops taking approvals before the issue's own time.
  const early = issue.approveBy && issue.approveBy !== issue.slot && issue.state !== "scheduled";
  const slot = when(issue.slot, zone);
  const goesOut = handoff ? `Goes out ${slot}, sent by you in ${handoff}.` : issue.state === "scheduled" ? `Goes out ${slot}.` : `Goes out ${slot}, once someone approves it.`;
  return (
    <span className="flex flex-wrap items-center gap-x-3 gap-y-1">
      <StateChip state={issue.state as ItemState} />
      {OPEN.has(issue.state) && <span className="tabular-nums">{goesOut + (early ? ` Approve by ${time(issue.approveBy!, zone)} so it can go out at ${time(issue.slot, zone)}.` : "")}</span>}
      {OPEN.has(issue.state) && audience && <span className="tabular-nums">{audience}</span>}
    </span>
  );
}

/**
 * The one next step, named for what happens: send it for approval, approve it, or copy it into the tool.
 * With unsaved edits it saves them first and acts on the saved revision, so what goes out is what is on
 * screen; a refused save stops there.
 */
function Primary(p: Props) {
  const { workspaceId, role, issue, setError, zone, fields, dirty } = p;
  const client = useQueryClient();
  const { reload, outcome } = useOutcome(p);
  const submitting = useAction();
  const approving = useAction();
  const handoff = issue.handoffTo;
  const editing = dirty && mayEdit(role);
  /** The revision to act on: the current one, or the one a save just made; undefined when the save was refused. */
  const current = async (): Promise<number | undefined> => {
    if (!editing) return issue.revision;
    const saved = await saveIssue(workspaceId, p.itemId, saveBody(fields));
    if (typeof saved === "string") return void setError(sayIssue(saved));
    client.setQueryData(issueQuery(workspaceId, p.itemId).queryKey, saved);
    p.saved();
    return saved.revision;
  };
  const unsaved = editing && <span className="self-center text-sm text-muted-foreground">Unsaved changes</span>;
  if (issue.state === "draft" && mayEdit(role))
    return (
      <>
        {unsaved}
        <Button
          pending={submitting.pending}
          onClick={() =>
            void submitting.run(async () => {
              if ((await current()) === undefined) return null;
              await outcome(await submitIssue(workspaceId, p.itemId), editing ? "Saved and sent for approval." : "Sent for approval.");
              return null;
            })
          }
        >
          {editing ? "Save and send for approval" : "Send for approval"}
        </Button>
      </>
    );
  if (issue.state === "needs_approval" && mayApprove(role))
    return (
      <>
        {unsaved}
        <Button
          pending={approving.pending}
          onClick={() =>
            void approving.run(async () => {
              const revision = await current();
              if (revision === undefined) return null;
              const error = await approve(workspaceId, { id: issue.itemId, revision });
              setError(error ? sayIssue(error) : undefined);
              if (error) return null;
              toast.add({ title: handoff ? `Approved. Copy it into ${handoff} and send it there.` : "Approved. It goes out at its time." });
              await reload();
              return null;
            })
          }
        >
          {`${editing ? "Save and approve" : "Approve"}${handoff ? "" : ` · goes out ${short(issue.slot, zone)}`}`}
        </Button>
      </>
    );
  if (handoff && issue.state === "scheduled") return <Button onClick={() => void navigator.clipboard.writeText(issue.html).then(() => toast.add({ title: "Copied." }))}>Copy HTML</Button>;
  return null;
}

function Body(p: Props & { edit: (patch: Partial<Draft>) => void }) {
  const { workspaceId, role, issue, zone, fields, edit } = p;
  const { outcome } = useOutcome(p);
  const { title, previewText, markdown } = fields;
  const [preview, setPreview] = useState(issue.html);
  const [phone, setPhone] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  // A preview still waiting when the form goes (a save remounts it) is dropped, not fetched for nothing.
  useEffect(() => () => clearTimeout(timer.current), []);
  const saving = useAction();
  const marking = useAction();
  // The last sent issue's numbers, for the change on each tile.
  const issues = useQuery({ ...issuesQuery(workspaceId), enabled: issue.stats !== null });
  // ponytail: only the first page of issues is searched; an old issue past it shows no change.
  const last = issues.data?.issues.find((i) => i.stats && i.slot < issue.slot)?.stats ?? undefined;

  const editable = mayEdit(role) && OPEN.has(issue.state) && !(issue.handoffTo && issue.state === "scheduled");
  const handoff = issue.handoffTo;
  const typed = (value: string) => {
    edit({ markdown: value });
    clearTimeout(timer.current);
    timer.current = setTimeout(() => void previewHtml(workspaceId, value).then((h) => h !== null && setPreview(h)), 300);
  };
  const save = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    await saving.run(async () => {
      const r = await saveIssue(workspaceId, p.itemId, saveBody(fields));
      if (typeof r !== "string") p.saved();
      await outcome(r, issue.state === "scheduled" ? "Saved. The approval was taken back, so it needs approving again." : "Saved.");
      return null;
    });
  };
  const copying = handoff && issue.state === "scheduled";

  return (
    <>
      {issue.warnings.length > 0 && (
        <ul aria-label="Warnings" className="flex flex-col gap-1 rounded-card bg-muted p-4">
          {issue.warnings.map((w) => (
            <li key={w.text}>{w.text}</li>
          ))}
        </ul>
      )}

      {/* From the split width the editor and the preview sit side by side, the preview staying in view. */}
      <div className={`grid items-start gap-6 ${editable ? "split:grid-cols-2" : ""}`}>
        {editable && (
          <form className="flex min-w-0 flex-col gap-4" onSubmit={save}>
            <Field label="Subject line" hint={`${title.length} characters. Most inboxes show about 60.`}>
              <Input name="title" value={title} onChange={(e) => edit({ title: e.target.value })} required maxLength={998} />
            </Field>
            <Field label="Preview text" hint={`Shown after the subject in the inbox. ${previewText.length} characters; about 90 show.`}>
              <Input name="previewText" value={previewText} onChange={(e) => edit({ previewText: e.target.value })} maxLength={500} />
            </Field>
            <Field label="Body" hint="Markdown: **bold**, # heading, [link](url)">
              <Textarea name="markdown" value={markdown} onChange={(e) => typed(e.target.value)} rows={16} required />
            </Field>
            <div className="flex flex-wrap items-center gap-3">
              <Button type="submit" variant="outline" pending={saving.pending}>
                Save
              </Button>
              {issue.state === "scheduled" && <p className="text-sm text-muted-foreground">Saving after approval sends it back for approval.</p>}
            </div>
          </form>
        )}

        <div className="flex min-w-0 flex-col gap-4 split:sticky split:top-4">
          <Section title={copying ? `Copy this into ${handoff}` : "Preview"}>
            <div role="group" aria-label="Preview width" className="flex gap-1.5">
              {(["Desktop", "Phone"] as const).map((w) => (
                <Button key={w} size="xs" variant={phone === (w === "Phone") ? "default" : "outline"} className="rounded-full" aria-pressed={phone === (w === "Phone")} onClick={() => setPhone(w === "Phone")}>
                  {w}
                </Button>
              ))}
            </div>
            <div className={`mx-auto flex w-full min-w-0 flex-col gap-3 ${phone ? "max-w-sm" : ""}`}>
              <div aria-label="In the inbox" className="flex min-w-0 flex-col gap-0.5 rounded-card border border-border bg-background px-4 py-3">
                <span className="truncate font-medium">{title.trim() || "No subject line yet"}</span>
                <span className="truncate text-sm text-muted-foreground">{previewText.trim() || "No preview text: the inbox shows the first words of the body."}</span>
              </div>
              <iframe title="Issue preview" sandbox="" srcDoc={preview} className="min-h-96 w-full rounded-card border border-border" />
            </div>
            {copying && (
              <>
                <Field label="HTML to paste">
                  <Textarea readOnly value={issue.html} rows={8} />
                </Field>
                {mayEdit(role) && (
                  <div>
                    <Button
                      variant="outline"
                      pending={marking.pending}
                      onClick={() =>
                        void marking.run(async () => {
                          await outcome(await markIssueSent(workspaceId, p.itemId), "Recorded as sent.");
                          return null;
                        })
                      }
                    >
                      I sent it
                    </Button>
                  </div>
                )}
              </>
            )}
          </Section>
        </div>
      </div>

      {issue.sentAt && (
        <Section title="After the send" description={`Went out ${when(issue.sentAt, zone)}.`}>
          {issue.stats ? (
            <>
              <Tiles s={issue.stats} last={last} />
              <p className="text-sm text-muted-foreground">{statsWords(issue.stats)[2]}</p>
            </>
          ) : (
            <p>{handoff ? `${handoff} doesn't tell Direx how an issue did. Check it there.` : "The first numbers come 30 minutes after the send."}</p>
          )}
          {issue.statsReadAt && <p className="text-sm text-muted-foreground">{`Last read ${when(issue.statsReadAt, zone)}.`}</p>}
        </Section>
      )}
    </>
  );
}

const count = (x: number) => x.toLocaleString("en");
const signed = (n: string, x: number) => `${x > 0 ? "+" : ""}${n} vs last issue`;

/** The results as tiles, each with its change from the last sent issue when there is one. */
function Tiles({ s, last }: { s: IssueStats; last?: IssueStats }) {
  const base = (x: IssueStats) => x.delivered ?? x.recipients;
  const tiles = [
    { ...(s.delivered === undefined ? { label: "Sent to", value: count(s.recipients) } : { label: "Delivered", value: count(s.delivered), note: `of ${count(s.recipients)} sent` }), vs: last && signed(count(base(s) - base(last)), base(s) - base(last)) },
    { label: "Click rate", value: `${clickRate(s).toFixed(1)}%`, note: `${count(s.clicks)} ${s.clicks === 1 ? "click" : "clicks"}`, vs: last && signed(`${(clickRate(s) - clickRate(last)).toFixed(1)} points`, clickRate(s) - clickRate(last)) },
    { label: "Unsubscribes", value: count(s.unsubscribes), vs: last && signed(count(s.unsubscribes - last.unsubscribes), s.unsubscribes - last.unsubscribes) },
  ];
  return (
    <dl className="grid grid-cols-1 gap-3 sm:grid-cols-3">
      {tiles.map((t) => (
        <div key={t.label} className="flex flex-col gap-1 rounded-card border border-border p-4">
          <dt className="text-sm text-muted-foreground">{t.label}</dt>
          <dd className="text-lg font-medium tabular-nums">{t.value}</dd>
          {"note" in t && t.note && <dd className="text-sm text-muted-foreground tabular-nums">{t.note}</dd>}
          {t.vs && <dd className="text-sm text-muted-foreground tabular-nums">{t.vs}</dd>}
        </div>
      ))}
    </dl>
  );
}
