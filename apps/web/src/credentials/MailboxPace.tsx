// SPDX-License-Identifier: AGPL-3.0-only
// A Mailbox's pace: how many emails a day, and the hours they go out in. Whoever connected it sets the
// first values; after that an Owner or Admin changes it. The server says which, so a refusal shows here.
import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { inWorkspace } from "../api/query";
import { Button } from "@/components/Button";
import { Input, Select, timeZones } from "@/components/Input";
import { paceKey, paceQuery, saveZone, savePace, zoneQuery, type Pace } from "./actions";

/** "09:00" from minutes after midnight, and back. */
export const clock = (m: number) => `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
export const minutes = (hhmm: string) => {
  const [h, m] = hhmm.split(":").map(Number);
  return (h ?? 0) * 60 + (m ?? 0);
};

const REFUSED: Record<string, string> = {
  forbidden: "Only whoever connected this email account can set its first pace. After that, an Owner or Admin changes it.",
  bad_pace: "Pick 1 to 500 a day, and an end time after the start time.",
};

/** The words for a Mailbox's pace, such as "Sends up to 50 a day, 09:00 to 17:00 on weekdays, Europe/Berlin time." */
export const paceWords = (p: Pace, timeZone: string) =>
  `Sends up to ${p.dailyLimit} a day, ${clock(p.sendFrom)} to ${p.sendUntil === 1440 ? "midnight" : clock(p.sendUntil)} ${p.sendWeekends ? "every day" : "on weekdays"}, ${timeZone} time.`;

/**
 * The time zone every Mailbox's days and hours are read in. An Owner or Admin changes it; changing it
 * moves nothing already planned.
 */
export function WorkspaceZone(p: { workspaceId: string; mayEdit: boolean }) {
  const client = useQueryClient();
  const q = useQuery(zoneQuery(p.workspaceId));
  const [draft, setDraft] = useState<string>();
  const [error, setError] = useState<string>();
  const [saving, setSaving] = useState(false);
  if (!q.data) return null;
  const zone = draft ?? q.data.timeZone;
  if (!p.mayEdit) return <p className="text-muted-foreground">Days and sending hours are in {q.data.timeZone} time.</p>;
  const save = async () => {
    setSaving(true);
    try {
      const failed = await saveZone(p.workspaceId, zone);
      if (failed) return setError("That isn't a time zone Direx knows. Pick one from the list, such as Europe/Berlin.");
      setError(undefined);
      setDraft(undefined);
      await client.invalidateQueries({ queryKey: inWorkspace(p.workspaceId) });
    } finally {
      setSaving(false);
    }
  };
  return (
    <form
      className="flex flex-wrap items-end gap-3"
      onSubmit={(e) => {
        e.preventDefault();
        void save();
      }}
    >
      <Select label="Time zone" className="w-64" value={zone} onChange={(e) => setDraft(e.target.value)}>
        {timeZones(q.data.timeZone).map((z) => (
          <option key={z} value={z}>
            {z}
          </option>
        ))}
      </Select>
      {draft !== undefined && draft !== q.data.timeZone && (
        <Button type="submit" size="sm" pending={saving}>
          Save time zone
        </Button>
      )}
      {error && <p role="alert">{error}</p>}
    </form>
  );
}

export function MailboxPace(p: { workspaceId: string; credentialId: string; name: string; mayEdit: boolean }) {
  const client = useQueryClient();
  const q = useQuery(paceQuery(p.workspaceId, p.credentialId));
  const [draft, setDraft] = useState<Pace>();
  const [error, setError] = useState<string>();
  const [saving, setSaving] = useState(false);
  if (!q.data) return null;
  const pace = draft ?? q.data.pace;
  const close = () => {
    setDraft(undefined);
    setError(undefined);
  };
  const save = async () => {
    setSaving(true);
    try {
      const failed = await savePace(p.workspaceId, p.credentialId, pace);
      if (failed) return setError(REFUSED[failed] ?? "That didn't save. Try again.");
      close();
      await client.invalidateQueries({ queryKey: paceKey(p.workspaceId, p.credentialId) });
    } finally {
      setSaving(false);
    }
  };
  return (
    <div className="flex flex-col gap-2">
      <p>
        {paceWords(q.data.pace, q.data.timeZone)}
        {p.mayEdit && !draft && (
          <Button size="sm" variant="outline" className="ml-2" aria-label={`Change pace: ${p.name}`} onClick={() => setDraft(q.data.pace)}>
            Change
          </Button>
        )}
      </p>
      {draft && (
        <form
          className="flex flex-wrap items-end gap-3"
          onSubmit={(e) => {
            e.preventDefault();
            void save();
          }}
        >
          <div className="flex flex-col gap-1 text-sm">
            <Input label="Emails a day" type="number" min={1} max={500} required className="w-24" value={pace.dailyLimit} onChange={(e) => setDraft({ ...pace, dailyLimit: Number(e.target.value) })} />
          </div>
          <div className="flex flex-col gap-1 text-sm">
            <Input label="From" type="time" required className="w-auto" value={clock(pace.sendFrom)} onChange={(e) => setDraft({ ...pace, sendFrom: minutes(e.target.value) })} />
          </div>
          <div className="flex flex-col gap-1 text-sm">
            <Input label="Until" type="time" required className="w-auto" value={clock(pace.sendUntil % 1440)} onChange={(e) => setDraft({ ...pace, sendUntil: minutes(e.target.value) || 1440 })} />
          </div>
          <label className="flex min-h-9 items-center gap-2 text-sm">
            <input type="checkbox" className="size-4 accent-primary" checked={pace.sendWeekends} onChange={(e) => setDraft({ ...pace, sendWeekends: e.target.checked })} />
            Weekends too
          </label>
          <Button type="submit" size="sm" pending={saving}>
            Save
          </Button>
          <Button type="button" size="sm" variant="outline" onClick={close}>
            Cancel
          </Button>
        </form>
      )}
      {error && <p role="alert">{error}</p>}
    </div>
  );
}
