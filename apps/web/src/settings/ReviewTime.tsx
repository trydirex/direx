// SPDX-License-Identifier: AGPL-3.0-only
// Review time: a calendar link that blocks time in a person's own calendar to go through what needs
// approval. The link is shown once; anyone holding it sees how much is waiting, never what it says.
import { useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Field, Notice, Page, Section } from "../components/layout";
import { QueryBoundary } from "../components/QueryBoundary";
import { Button } from "@/components/Button";
import { Confirm } from "@/components/Confirm";
import { Select, timeZones } from "@/components/Input";
import { Skeleton } from "@astryxdesign/core/Skeleton";
import { toast } from "@/components/toast";
import { mayApprove, type Role } from "../items/actions";
import { makeReviewLink, reviewFeedQuery, saveReviewTime, stopReviewFeed, type ReviewFeedState, type ReviewSettings } from "./actions";

const DAYS = [
  [1, "Mon"],
  [2, "Tue"],
  [3, "Wed"],
  [4, "Thu"],
  [5, "Fri"],
  [6, "Sat"],
  [7, "Sun"],
] as const;
const STARTS = Array.from({ length: 48 }, (_, i) => i * 30);
const hhmm = (m: number) => `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
const browserZone = () => Intl.DateTimeFormat().resolvedOptions().timeZone;
const DEFAULTS = (): ReviewSettings => ({ weekdays: [2, 4], startMinute: 10 * 60, lengthMinutes: 30, timeZone: browserZone() });

/** The form's settings, or null when no day is picked. */
function read(form: HTMLFormElement): ReviewSettings | null {
  const f = new FormData(form);
  const weekdays = f.getAll("weekday").map(Number);
  if (weekdays.length === 0) return null;
  return { weekdays, startMinute: Number(f.get("startMinute")), lengthMinutes: Number(f.get("lengthMinutes")) as ReviewSettings["lengthMinutes"], timeZone: String(f.get("timeZone")) };
}

export function ReviewTime(p: { workspaceId: string; role: Role }) {
  return (
    <Page title="Review time" description="Block time in your own calendar to go through what needs your approval. On the days you pick, Direx adds a review block that says how much is waiting and when the next one is due.">
      {mayApprove(p.role) ? <ReviewFeed workspaceId={p.workspaceId} /> : <p className="text-muted-foreground">Review time is for people who approve. An Owner or Admin can change your role.</p>}
    </Page>
  );
}

function ReviewFeed(p: { workspaceId: string }) {
  const feed = useQuery(reviewFeedQuery(p.workspaceId));
  return (
    <QueryBoundary query={feed} skeleton={<Skeleton className="h-48 w-full" />}>
      {(data) => <Form workspaceId={p.workspaceId} data={data} />}
    </QueryBoundary>
  );
}

function Form(p: { workspaceId: string; data: ReviewFeedState }) {
  const client = useQueryClient();
  const form = useRef<HTMLFormElement>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [shown, setShown] = useState<string>();
  const current = p.data.feed ?? DEFAULTS();
  const refresh = () => client.invalidateQueries({ queryKey: reviewFeedQuery(p.workspaceId).queryKey });

  async function run(work: () => Promise<unknown>) {
    setBusy(true);
    setError(undefined);
    try {
      await work();
    } catch {
      setError("That didn't work. Try again in a moment.");
    } finally {
      setBusy(false);
    }
    await refresh();
  }
  const settings = () => {
    const s = form.current && read(form.current);
    if (!s) setError("Pick at least one day.");
    return s;
  };
  const submit = (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const s = settings();
    if (!s) return;
    void run(async () => {
      if (p.data.feed) {
        await saveReviewTime(p.workspaceId, s);
        toast.add({ title: "Saved. Your calendar picks it up the next time it checks." });
      } else setShown(await makeReviewLink(p.workspaceId, s));
    });
  };
  const rotate = () => {
    const s = settings();
    if (s) return run(async () => setShown(await makeReviewLink(p.workspaceId, s)));
  };
  const stop = () =>
    run(async () => {
      await stopReviewFeed(p.workspaceId);
      setShown(undefined);
    });

  return (
    <>
      {!p.data.reachable && <Notice>Calendars can&apos;t reach this Direx yet, because it has no public HTTPS address. The link starts working once it has one.</Notice>}
      <Section title="When" description="Pick the days and time to review. Your calendar shows the next 14 days.">
        <form ref={form} className="flex flex-col gap-4" onSubmit={submit}>
          <fieldset className="flex flex-wrap gap-3">
            <legend className="mb-2 text-sm font-medium">Days</legend>
            {DAYS.map(([n, label]) => (
              <label key={n} className="flex items-center gap-1.5">
                <input type="checkbox" className="accent-primary" name="weekday" value={n} defaultChecked={current.weekdays.includes(n)} /> {label}
              </label>
            ))}
          </fieldset>
          <div className="flex flex-wrap items-end gap-3">
            <Field label="Starts at">
              <Select name="startMinute" defaultValue={String(current.startMinute)}>
                {STARTS.map((m) => (
                  <option key={m} value={String(m)}>
                    {hhmm(m)}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="Length">
              <Select name="lengthMinutes" defaultValue={String(current.lengthMinutes)}>
                <option value="15">15 minutes</option>
                <option value="30">30 minutes</option>
                <option value="60">1 hour</option>
              </Select>
            </Field>
            <Field label="Time zone">
              <Select name="timeZone" defaultValue={current.timeZone} className="min-w-56">
                {timeZones(current.timeZone).map((z) => (
                  <option key={z} value={z}>
                    {z}
                  </option>
                ))}
              </Select>
            </Field>
          </div>
          <div>
            <Button type="submit" variant={p.data.feed ? "outline" : "default"} pending={busy}>
              {p.data.feed ? "Save" : "Make my calendar link"}
            </Button>
          </div>
        </form>
        {error && <Notice tone="error">{error}</Notice>}
      </Section>
      {shown ? <ShownLink url={shown} /> : p.data.feed && <Status feed={p.data.feed} busy={busy} onRotate={rotate} onStop={stop} />}
    </>
  );
}

function ShownLink(p: { url: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <Section title="Your calendar link" description="Copy it now. Direx shows this link only once. Anyone with it sees how much is waiting here, never what any draft says.">
      <div className="flex flex-wrap items-center gap-3">
        <code className="min-w-0 break-all">{p.url}</code>
        <Button size="sm" variant="outline" onClick={() => void navigator.clipboard?.writeText(p.url).then(() => setCopied(true))}>
          {copied ? "Copied" : "Copy"}
        </Button>
      </div>
      <ol className="flex list-decimal flex-col gap-1 pl-5 text-sm">
        <li>Google Calendar: next to Other calendars, choose the plus, then From URL, and paste the link.</li>
        <li>Outlook: choose Add calendar, then Subscribe from web, and paste the link.</li>
        <li>Apple Calendar: choose File, then New Calendar Subscription, and paste the link.</li>
      </ol>
      <p className="text-sm text-muted-foreground">Google can take up to a day to show a change. The number in each block is as of the last time your calendar checked.</p>
    </Section>
  );
}

function Status(p: { feed: NonNullable<ReviewFeedState["feed"]>; busy: boolean; onRotate: () => unknown; onStop: () => unknown }) {
  const checked = p.feed.lastFetchedAt ? `Your calendar last checked it on ${new Date(p.feed.lastFetchedAt).toLocaleString()}.` : "Your calendar hasn't checked it yet.";
  return (
    <Section title="Your calendar link" description={`The link is on. ${checked}`}>
      <div className="flex flex-wrap gap-3">
        <Confirm
          trigger={
            <Button variant="outline" disabled={p.busy}>
              Get a new link
            </Button>
          }
          title="Get a new link?"
          body="The link you have now stops working. Add the new one to your calendar."
          confirm="Get a new link"
          onConfirm={p.onRotate}
        />
        <Confirm
          trigger={
            <Button variant="outline" disabled={p.busy}>
              Stop my calendar link
            </Button>
          }
          title="Stop your calendar link?"
          body="The link stops working and your review blocks stop updating. You can make a new one later."
          confirm="Stop"
          onConfirm={p.onStop}
        />
      </div>
    </Section>
  );
}
