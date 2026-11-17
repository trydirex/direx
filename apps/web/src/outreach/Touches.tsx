// SPDX-License-Identifier: AGPL-3.0-only
import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { inWorkspace } from "../api/query";
import { EmptyState, Field, Notice, Section } from "../components/layout";
import { QueryBoundary } from "../components/QueryBoundary";
import { Button } from "@/components/Button";
import { Input, Select } from "@/components/Input";
import { Skeleton } from "@astryxdesign/core/Skeleton";
import { toast } from "@/components/toast";
import { momentWords } from "../campaigns/actions";
import { addProfile, logTouch, removeTouch, say, touchesQuery, type Channel, type OutsideTouch } from "./actions";

const CHANNELS: { value: Channel; label: string }[] = [
  { value: "call", label: "Call" },
  { value: "linkedin", label: "LinkedIn message" },
  { value: "x", label: "X message" },
  { value: "email_other", label: "Email from another tool" },
  { value: "other", label: "Other" },
];
const label = (c: string) => CHANNELS.find((x) => x.value === c)?.label ?? c;

/** The minute now, as a datetime-local input wants it. */
function localNow(): string {
  const d = new Date();
  return new Date(d.getTime() - d.getTimezoneOffset() * 60_000).toISOString().slice(0, 16);
}

/**
 * Touches Direx didn't send. One you sent holds Direx's next cold email to that Person for 3 days and
 * doesn't count toward their 5 in 30 days; one you received is a reply and stops their campaigns.
 */
export function Touches(p: { workspaceId: string; people: { id: string; email: string }[]; canEdit: boolean; initial?: { personId: string; touches: OutsideTouch[] } }) {
  const { workspaceId, people, canEdit } = p;
  const client = useQueryClient();
  const [personId, setPersonId] = useState(p.initial?.personId ?? people[0]?.id ?? "");
  const touches = useQuery({ ...touchesQuery(workspaceId, personId), enabled: !!personId, initialData: personId === p.initial?.personId ? { touches: p.initial.touches, profiles: [] } : undefined });
  const profiles = touches.data?.profiles ?? [];
  // Which action is running, and which one was refused, so each shows by its own button.
  const [busy, setBusy] = useState<string>();
  const [failed, setFailed] = useState<{ at: string; text: string }>();
  if (!people.length) return null;

  const act = async (at: string, done: string, fn: () => Promise<string | null>, reload = true) => {
    setBusy(at);
    setFailed(undefined);
    try {
      const error = await fn();
      if (error) setFailed({ at, text: say(error) });
      else toast.add({ title: done });
      // A received touch is a reply and changes the Person's holds, so the whole Workspace reloads.
      if (reload) await client.invalidateQueries({ queryKey: inWorkspace(workspaceId) });
      return error;
    } finally {
      setBusy(undefined);
    }
  };
  const refused = (at: string) => failed?.at === at && <Notice tone="error">{failed.text}</Notice>;
  const submit = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    await act("log", "Logged.", () =>
      logTouch(workspaceId, personId, {
        channel: String(f.get("channel")) as Channel,
        direction: f.get("direction") === "inbound" ? "inbound" : "outbound",
        occurredAt: new Date(String(f.get("occurredAt"))).toISOString(),
      }),
    );
  };
  const saveProfile = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const form = e.currentTarget;
    const f = new FormData(form);
    const error = await act("profile", "Profile saved. DM steps can draft for them now.", () => addProfile(workspaceId, personId, { kind: f.get("kind") === "x" ? "x" : "linkedin", url: String(f.get("url")) }), false);
    if (error) return;
    form.reset();
    await client.invalidateQueries({ queryKey: touchesQuery(workspaceId, personId).queryKey });
  };

  return (
    <Section title="Calls and messages outside Direx" description="One you sent keeps Direx's next cold email to that Person 3 days away. One you received counts as a reply and stops their campaigns.">
      {/* Opened from one Person's row, there is nobody to pick. */}
      {people.length > 1 && (
        <Field label="Person">
          <Select value={personId} onChange={(e) => setPersonId(e.target.value)}>
            {people.map((x) => (
              <option key={x.id} value={x.id}>
                {x.email}
              </option>
            ))}
          </Select>
        </Field>
      )}
      {canEdit && (
        <form onSubmit={submit} className="flex flex-wrap items-end gap-3">
          <Field label="What">
            <Select name="channel">
              {CHANNELS.map((c) => (
                <option key={c.value} value={c.value}>
                  {c.label}
                </option>
              ))}
            </Select>
          </Field>
          <fieldset className="flex min-h-11 items-center gap-4 text-sm">
            <legend className="sr-only">Direction</legend>
            <label className="flex items-center gap-2">
              <input type="radio" name="direction" value="outbound" defaultChecked className="size-4 accent-primary" /> You sent it
            </label>
            <label className="flex items-center gap-2">
              <input type="radio" name="direction" value="inbound" className="size-4 accent-primary" /> They replied
            </label>
          </fieldset>
          <Field label="When">
            <Input name="occurredAt" type="datetime-local" defaultValue={localNow()} required />
          </Field>
          <Button type="submit" variant="outline" pending={busy === "log"}>
            Log it
          </Button>
        </form>
      )}
      {refused("log")}
      {canEdit && (
        <form onSubmit={saveProfile} className="flex flex-wrap items-end gap-3">
          <Field label="Profile for DMs">
            <Select name="kind">
              <option value="linkedin">LinkedIn</option>
              <option value="x">X</option>
            </Select>
          </Field>
          <Field label="URL or handle">
            <Input name="url" required maxLength={300} autoComplete="off" spellCheck={false} />
          </Field>
          <Button type="submit" variant="outline" pending={busy === "profile"}>
            Save profile
          </Button>
        </form>
      )}
      {refused("profile")}
      {profiles.length > 0 && (
        <ul aria-label="Saved profiles" className="flex flex-col gap-1 text-sm">
          {profiles.map((x) => (
            <li key={x.url} className="break-all">
              {x.kind === "x" ? "X" : "LinkedIn"}: {x.url}
            </li>
          ))}
        </ul>
      )}
      <QueryBoundary query={touches} skeleton={<Skeleton className="h-16 w-full" />}>
        {({ touches: list }) =>
          list.length === 0 ? (
            <EmptyState title="Nothing logged in the last 90 days">A call or message you log above shows here for 90 days.</EmptyState>
          ) : (
            <ul className="flex flex-col divide-y divide-border">
              {list.map((t) => (
                <li key={t.id} className="flex flex-wrap items-center gap-2 py-2">
                  {`${label(t.channel)}, ${t.direction === "inbound" ? "received" : "sent"} ${momentWords(t.occurredAt)}`}
                  {t.source === "direx_draft" && <small className="text-sm text-muted-foreground"> (a Direx draft you sent)</small>}
                  {canEdit && t.canDelete && (
                    <Button type="button" size="sm" variant="outline" aria-label={`Remove ${label(t.channel)} ${t.direction === "inbound" ? "received" : "sent"} ${momentWords(t.occurredAt)}`} pending={busy === t.id} onClick={() => void act(t.id, "Removed.", () => removeTouch(workspaceId, personId, t.id))}>
                      Remove
                    </Button>
                  )}
                  {refused(t.id)}
                </li>
              ))}
            </ul>
          )
        }
      </QueryBoundary>
    </Section>
  );
}
