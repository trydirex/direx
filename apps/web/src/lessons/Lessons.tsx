// SPDX-License-Identifier: AGPL-3.0-only
// What each writer keeps in mind in this Workspace. Changing or withdrawing a lesson takes the same
// permission as turning on Auto-approve, and a recent sign-in.
import { Confirm } from "../components/Confirm";
import { useState } from "react";
import { Link } from "@tanstack/react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { inWorkspace } from "../api/query";
import { EmptyState, Field as Labelled, Notice, Page, Section } from "../components/layout";
import { QueryBoundary } from "../components/QueryBoundary";
import { Button } from "@/components/Button";
import { Input, Select } from "@/components/Input";
import { Skeleton } from "@astryxdesign/core/Skeleton";
import { toast } from "@/components/toast";
import { FIELD_LABEL, type Field } from "../facts/actions";
import { mayEdit, type Role } from "../items/actions";
import { dayWords } from "../campaigns/actions";
import { campaignOf, CampaignLink } from "./ProposalView";
import { lessonsQuery, lessonToFact, pendingLessonsQuery, retireLesson, rewriteLesson, sayLesson, writerWords, type Lesson } from "./actions";

const mayChange = (role: Role) => role === "owner" || role === "admin";

export const FACT_SUGGESTED = "Suggested. The brand fact waits in Needs you, and accepting it removes this lesson.";

const SUMMARY = "cursor-pointer py-1 text-sm text-muted-foreground";

/** Who proposed the lesson, after an edit in which Campaign, and the proposal Item that was accepted; nothing when none of it was recorded. */
function Origin({ workspaceId, origin: o }: { workspaceId: string; origin: Lesson["origin"] }) {
  const campaignId = campaignOf(o.sourceRef);
  if (!o.proposedBy && !campaignId && !o.itemId) return null;
  return (
    <small className="text-sm text-muted-foreground">
      {o.proposedBy ? `Proposed by ${o.proposedBy}` : "Proposed"}
      {campaignId && (
        <>
          {" after an edit in "}
          <CampaignLink workspaceId={workspaceId} campaignId={campaignId} />
        </>
      )}
      .
      {o.itemId && (
        <>
          {" "}
          <Link className="underline" to="/w/$workspaceId/review/$itemId" params={{ workspaceId, itemId: o.itemId }}>
            See the proposal
          </Link>
        </>
      )}
    </small>
  );
}

function LessonRow(p: { workspaceId: string; lesson: Lesson; role: Role; onChange: () => Promise<unknown> }) {
  const { lesson: l } = p;
  const [text, setText] = useState(l.text);
  const [field, setField] = useState<Field>("claim");
  const [source, setSource] = useState("");
  const [busy, setBusy] = useState<"rewrite" | "fact">();
  const [error, setError] = useState<string>();
  const settle = async (r: { error: string; reasons?: string[] } | null, done?: string) => {
    setError(r ? sayLesson(r.error, r.reasons) : undefined);
    if (!r && done) toast.add({ title: done });
    await p.onChange();
  };
  const act = async (at: "rewrite" | "fact", fn: () => Promise<{ error: string; reasons?: string[] } | null>, done?: string) => {
    setBusy(at);
    try {
      await settle(await fn(), done);
    } finally {
      setBusy(undefined);
    }
  };
  return (
    <li className="flex flex-col gap-3 border-t border-border pt-4 first:border-t-0 first:pt-0">
      <div className="flex flex-col gap-1">
        <p>{l.text}</p>
        <small className="text-sm text-muted-foreground">Added {dayWords(l.createdAt.slice(0, 10))}</small>
        <Origin workspaceId={p.workspaceId} origin={l.origin} />
      </div>
      {mayChange(p.role) && (
        <>
          <div className="flex flex-wrap gap-2">
            <Confirm
              title="Remove this lesson?"
              body="Direx stops using it in new drafts."
              confirm="Remove"
              onConfirm={async () => settle(await retireLesson(p.workspaceId, l))}
              trigger={
                <Button size="sm" variant="outline" aria-label={`Remove ${l.text}`}>
                  Remove
                </Button>
              }
            />
          </div>
          <details>
            <summary className={SUMMARY}>Rewrite</summary>
            <form
              className="mt-3 flex flex-wrap items-center gap-3"
              onSubmit={async (e) => {
                e.preventDefault();
                await act("rewrite", () => rewriteLesson(p.workspaceId, l, text));
              }}
            >
              <Input aria-label="New words" className="max-w-xl" value={text} maxLength={300} required onChange={(e) => setText(e.target.value)} />
              <Button type="submit" size="sm" pending={busy === "rewrite"}>
                Save
              </Button>
            </form>
          </details>
        </>
      )}
      {mayEdit(p.role) && (
        <details>
          <summary className={SUMMARY}>Make this a brand fact</summary>
          <form
            className="mt-3 flex flex-wrap items-end gap-3"
            onSubmit={async (e) => {
              e.preventDefault();
              await act("fact", () => lessonToFact(p.workspaceId, l, field, source), FACT_SUGGESTED);
            }}
          >
            <Labelled label="Where it goes">
              <Select value={field} onChange={(e) => setField(e.target.value as Field)}>
                {(Object.keys(FIELD_LABEL) as Field[]).map((f) => (
                  <option key={f} value={f}>
                    {FIELD_LABEL[f]}
                  </option>
                ))}
              </Select>
            </Labelled>
            <Labelled label="Where it came from">
              <Input value={source} maxLength={200} required onChange={(e) => setSource(e.target.value)} />
            </Labelled>
            <Button type="submit" variant="outline" pending={busy === "fact"}>
              Suggest the brand fact
            </Button>
          </form>
        </details>
      )}
      {error && <Notice tone="error">{error}</Notice>}
    </li>
  );
}

/** The Lessons page, or (embedded) the same list as a panel on Brand under How we sound. */
export function Lessons(p: { workspaceId: string; role: Role; initial?: Lesson[]; embedded?: boolean }) {
  const client = useQueryClient();
  const lessons = useQuery({ ...lessonsQuery(p.workspaceId), initialData: p.initial });
  // Shown when it loads; the lessons themselves don't wait on it.
  const waiting = useQuery(pendingLessonsQuery(p.workspaceId)).data ?? [];
  const description = "What each writer keeps in mind here. After you edit a draft, “Remember this?” suggests a lesson, used only once an Owner or Admin accepts it in Needs you.";
  const pending = waiting.length > 0 && (
    <Section key="waiting" title="Waiting in Needs you">
      <ul className="flex flex-col gap-2">
        {waiting.map((i) => (
          <li key={i.id} className="wrap-break-word">
            <Link className="underline" to="/w/$workspaceId/review/$itemId" params={{ workspaceId: p.workspaceId, itemId: i.id }}>
              {i.title}
            </Link>
          </li>
        ))}
      </ul>
    </Section>
  );
  const content = (
      <QueryBoundary query={lessons} skeleton={<Skeleton className="h-48 w-full" />}>
        {(list) => {
          const writers = [...new Set(list.map((l) => l.agent))];
          if (writers.length === 0)
            return pending || <EmptyState title="No lessons yet">After you edit a draft, choose &ldquo;Remember this?&rdquo; and write in one sentence how you like it done. It is used only after an Owner or Admin accepts it in Needs you.</EmptyState>;
          return [pending, ...writers.map((w) => (
            <Section key={w} title={`For ${writerWords(w)}`}>
              <ul className="flex flex-col gap-4">
                {list
                  .filter((l) => l.agent === w)
                  .map((l) => (
                    <LessonRow
                      key={`${l.id}@${l.version}`}
                      workspaceId={p.workspaceId}
                      lesson={l}
                      role={p.role}
                      onChange={() => client.invalidateQueries({ queryKey: inWorkspace(p.workspaceId) })}
                    />
                  ))}
              </ul>
            </Section>
          ))];
        }}
      </QueryBoundary>
  );
  if (p.embedded)
    return (
      <div className="flex flex-col gap-4">
        <div className="flex flex-col gap-1">
          <h2>Lessons</h2>
          <p className="text-sm text-muted-foreground">{description}</p>
        </div>
        {content}
      </div>
    );
  return (
    <Page title="Lessons" description={description}>
      {content}
    </Page>
  );
}
