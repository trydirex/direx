// SPDX-License-Identifier: AGPL-3.0-only
// A person's notes on a Campaign: context, feedback and meeting notes that don't belong in the plan. Plain
// text, saved only over the revision read, so two people editing can't overwrite each other unseen.
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Field, Notice } from "../components/layout";
import { Button } from "@/components/Button";
import { Textarea } from "@/components/Input";
import { useAction } from "../components/useAction";
import { membersQuery } from "../identity/actions";
import { listTime } from "../items/actions";
import { saveCampaignNotes, say, type Loaded } from "./actions";

export const NOTES_MAX = 10_000;

export function CampaignNotes(p: { workspaceId: string; campaign: Pick<Loaded, "id" | "notes" | "notesRevision" | "notesUpdatedBy" | "notesUpdatedAt">; edit: boolean }) {
  const c = p.campaign;
  const [saved, setSaved] = useState({ notes: c.notes, revision: c.notesRevision, by: c.notesUpdatedBy, at: c.notesUpdatedAt, mine: false });
  // What the person is typing; undefined while the notes are only shown.
  const [typing, setTyping] = useState<string>();
  const [error, setError] = useState<string>();
  const saving = useAction();
  const members = useQuery({ ...membersQuery(p.workspaceId), enabled: Boolean(saved.by) && !saved.mine }).data;
  const member = members?.find((m) => m.userId === saved.by);
  const edited = saved.mine ? "Edited by you, just now" : saved.by && saved.at ? `Edited by ${member?.name || member?.email || "a teammate"}, ${listTime(new Date(saved.at))}` : null;
  if (!p.edit && !saved.notes) return null;

  return (
    <section aria-labelledby="campaign-notes" className="flex flex-col gap-2">
      <div className="flex items-baseline justify-between gap-2">
        <h2 id="campaign-notes" className="font-sans text-sm font-semibold">
          Notes
        </h2>
        {p.edit && typing === undefined && (
          <Button type="button" size="sm" variant="ghost" onClick={() => setTyping(saved.notes)}>
            {saved.notes ? "Edit" : "Add notes"}
          </Button>
        )}
      </div>
      {typing === undefined ? (
        <>
          {saved.notes ? <p className="text-sm whitespace-pre-wrap">{saved.notes}</p> : <p className="text-sm text-muted-foreground">Context, feedback or meeting notes for everyone on this campaign.</p>}
          {saved.notes && edited && <p className="text-sm text-muted-foreground">{edited}</p>}
        </>
      ) : (
        <form
          className="flex flex-col gap-2"
          onSubmit={async (e) => {
            e.preventDefault();
            await saving.run(async () => {
              const r = await saveCampaignNotes(p.workspaceId, c.id, { notes: typing, revision: saved.revision });
              // A refusal keeps what they typed, so nothing is lost.
              if ("error" in r) setError(say(r.error));
              else {
                setSaved({ notes: typing.trim(), revision: r.revision, by: null, at: null, mine: true });
                setTyping(undefined);
                setError(undefined);
              }
              return null;
            });
          }}
        >
          {error && <Notice tone="error">{error}</Notice>}
          <Field label="Notes" hint="Plain text. Everyone in this Workspace can read it.">
            <Textarea value={typing} maxLength={NOTES_MAX} rows={6} onChange={(e) => setTyping(e.target.value)} />
          </Field>
          <div className="flex gap-2">
            <Button type="submit" size="sm" pending={saving.pending} disabled={typing.trim() === saved.notes}>
              Save notes
            </Button>
            <Button
              type="button"
              size="sm"
              variant="ghost"
              onClick={() => {
                setTyping(undefined);
                setError(undefined);
              }}
            >
              Cancel
            </Button>
          </div>
        </form>
      )}
    </section>
  );
}
