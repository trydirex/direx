// SPDX-License-Identifier: AGPL-3.0-only
// A Social account's pace (ADR 0038): the hours its posts go out in and how far apart. Values it doesn't
// set follow its network. An Owner or Admin changes it; anyone else reads it in words.
import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/Button";
import { Input } from "@/components/Input";
import { clock, minutes } from "../credentials/MailboxPace";
import { paceKey, paceQuery, savePace, type SocialPace } from "./actions";

const REFUSED: Record<string, string> = {
  forbidden: "Only an Owner or Admin can change an account's posting hours.",
  bad_pace: "Pick an end time after the start time, and a gap of 0 to 720 minutes.",
};
const SAVE_FAILED = "That didn't save. Try again.";

/** The words for an account's pace, such as "Posts go out 08:00 to 21:00 every day, at least 60 minutes apart, Europe/Berlin time." */
export const paceWords = (p: SocialPace, timeZone: string) =>
  `Posts go out ${clock(p.from)} to ${p.until === 1440 ? "midnight" : clock(p.until)} ${p.weekends ? "every day" : "on weekdays"}, at least ${p.gapMinutes} minutes apart, ${timeZone} time.`;

export function AccountPace(p: { workspaceId: string; accountId: string; name: string; mayEdit: boolean }) {
  const client = useQueryClient();
  const q = useQuery(paceQuery(p.workspaceId, p.accountId));
  const [draft, setDraft] = useState<SocialPace>();
  const [error, setError] = useState<string>();
  const [saving, setSaving] = useState(false);
  if (!q.data) {
    if (!q.isError) return null;
    return (
      <div className="flex items-center gap-2">
        <p role="alert">Couldn't load posting hours.</p>
        <Button size="sm" variant="outline" pending={q.isFetching} onClick={() => void q.refetch()}>
          Retry
        </Button>
      </div>
    );
  }
  const view = q.data;
  const pace = draft ?? view.pace;
  const ownSet = Object.values(view.own).some((v) => v !== null);
  const close = () => {
    setDraft(undefined);
    setError(undefined);
  };
  const save = async (next: SocialPace | null) => {
    if (saving) return;
    setSaving(true);
    setError(undefined);
    try {
      const own = next ? { postingFrom: next.from, postingUntil: next.until, postingWeekends: next.weekends, gapMinutes: next.gapMinutes } : { postingFrom: null, postingUntil: null, postingWeekends: null, gapMinutes: null };
      const failed = await savePace(p.workspaceId, p.accountId, own);
      if (failed) return setError(REFUSED[failed] ?? SAVE_FAILED);
      await client.invalidateQueries({ queryKey: paceKey(p.workspaceId, p.accountId) });
      close();
    } catch {
      setError(SAVE_FAILED);
    } finally {
      setSaving(false);
    }
  };
  return (
    <div className="flex flex-col gap-2">
      <p>
        {paceWords(view.pace, view.timeZone)}
        {!ownSet && " This is the network's pace."}
        {!p.mayEdit && " An Owner or Admin can change it."}
        {p.mayEdit && !draft && (
          <Button size="sm" variant="outline" className="ml-2" aria-label={`Change posting hours: ${p.name}`} onClick={() => setDraft(view.pace)}>
            Change
          </Button>
        )}
      </p>
      {draft && (
        <form
          className="flex flex-wrap items-end gap-3"
          onSubmit={(e) => {
            e.preventDefault();
            void save(pace);
          }}
        >
          <Input label="From" type="time" required className="w-auto" value={clock(pace.from)} onChange={(e) => setDraft({ ...pace, from: minutes(e.target.value) })} />
          <Input label="Until" type="time" required className="w-auto" value={clock(pace.until % 1440)} onChange={(e) => setDraft({ ...pace, until: minutes(e.target.value) || 1440 })} />
          <Input label="Minutes apart" type="number" min={0} max={720} required className="w-24" value={pace.gapMinutes} onChange={(e) => setDraft({ ...pace, gapMinutes: Number(e.target.value) })} />
          <label className="flex min-h-9 items-center gap-2 text-sm">
            <input type="checkbox" className="size-4 accent-primary" checked={pace.weekends} onChange={(e) => setDraft({ ...pace, weekends: e.target.checked })} />
            Weekends too
          </label>
          <Button type="submit" size="sm" pending={saving}>
            Save
          </Button>
          {ownSet && (
            <Button type="button" size="sm" variant="outline" disabled={saving} onClick={() => void save(null)}>
              Use the network's pace
            </Button>
          )}
          <Button type="button" size="sm" variant="ghost" disabled={saving} onClick={close}>
            Cancel
          </Button>
        </form>
      )}
      {error && <p role="alert">{error}</p>}
    </div>
  );
}
