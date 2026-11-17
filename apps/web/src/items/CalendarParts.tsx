// SPDX-License-Identifier: AGPL-3.0-only
// The Calendar's two self-contained parts: a Campaign's launch marker and the new-post form.
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { Button } from "@/components/Button";
import { toast } from "@/components/toast";
import { firstSlotValue, isoDay } from "./actions";
import { moveEffect, moveLaunch, say as sayCampaign, type AnchorMove, type Listed } from "../campaigns/actions";
import { campaignStatus } from "../campaigns/Overview";
import { Input, Select, Textarea } from "../components/Input";
import { accountsQuery, networksQuery, writePost } from "../social/actions";
import { choices } from "../campaigns/PostStep";

/** A day as the Calendar names it: "Tue 3 Nov". */
export const dayName = (d: Date) => d.toLocaleDateString(undefined, { weekday: "short", day: "numeric", month: "short" });

/** A Campaign's launch on the Calendar: a link to it, and for an editor, a move with a preview first. */
export function LaunchMarker(p: { workspaceId: string; launch: { campaignId: string; title: string; on: string }; edit: boolean; onMoved: () => Promise<unknown> }) {
  const [on, setOn] = useState(p.launch.on);
  const [preview, setPreview] = useState<AnchorMove>();
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const run = async (dry: boolean) => {
    setBusy(true);
    try {
      const r = await moveLaunch(p.workspaceId, p.launch.campaignId, on, dry);
      setError("error" in r ? sayCampaign(r.error) : undefined);
      if ("error" in r) return;
      if (dry) return setPreview(r);
      setPreview(undefined);
      toast.add({ title: `Launch moved to ${dayName(new Date(`${on}T00:00`))}.` });
      await p.onMoved();
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="flex min-w-0 flex-col gap-1 rounded-sm bg-muted px-2 py-1 text-xs">
      <p className="flex min-w-0 items-center gap-1 text-xs">
        <span aria-hidden>⚑</span>
        <Link to="/w/$workspaceId/campaigns/$campaignId" params={{ workspaceId: p.workspaceId, campaignId: p.launch.campaignId }} search={{ tab: "drafts" }} className="truncate font-semibold no-underline hover:underline" title={p.launch.title}>
          Launch: {p.launch.title}
        </Link>
      </p>
      {p.edit && (
        <details>
          <summary className="cursor-pointer text-muted-foreground">Move the launch</summary>
          <form
            className="mt-1 flex flex-wrap items-center gap-1"
            onSubmit={(e) => {
              e.preventDefault();
              void run(true);
            }}
          >
            {/* Native: a bare date with no label row fits the band; the shared DateInput brings a Field. */}
            <input type="date" required aria-label={`New launch day for ${p.launch.title}`} className="rounded-control border border-input bg-card px-2 py-1" value={on} onChange={(e) => {
                setOn(e.target.value);
                setPreview(undefined);
              }}
            />
            <Button type="submit" size="sm" variant="outline" pending={busy && !preview}>
              Preview
            </Button>
          </form>
          {error && <p className="mt-1 text-xs">{error}</p>}
          {preview && (
            <div role="status" className="mt-1 flex flex-col items-start gap-1 rounded-sm bg-card p-2">
              <p>{moveEffect(preview)}</p>
              <Button size="sm" pending={busy} onClick={() => void run(false)}>
                Move the launch
              </Button>
            </div>
          )}
        </details>
      )}
    </div>
  );
}

/** A post written for one day, outside any campaign: it waits for approval like any draft. */
export function AddPost(p: { workspaceId: string; day: Date; onDone: () => void; onCancel: () => void }) {
  const accounts = useQuery(accountsQuery(p.workspaceId)).data;
  const nets = useQuery(networksQuery(p.workspaceId)).data;
  const options = accounts && nets ? choices(accounts, nets) : [];
  const [key, setKey] = useState("");
  const [text, setText] = useState("");
  // 9:00 on that day, or the next whole hour when today is past it, so the default never starts out refused.
  const [when, setWhen] = useState(() => firstSlotValue(p.day));
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const chosen = options.find((o) => o.key === key) ?? options[0];
  return (
    <form
      aria-label={`New post on ${dayName(p.day)}`}
      className="flex flex-col gap-3 pt-2"
      onSubmit={(e) => {
        e.preventDefault();
        if (!chosen || !text.trim()) return;
        setBusy(true);
        void writePost(p.workspaceId, { connection: chosen.connection, credentialId: chosen.credentialId, networkId: chosen.networkId, text, at: new Date(when).toISOString() })
          .then((failed) => {
            setError(failed ?? undefined);
            if (!failed) {
              toast.add({ title: "Post added. It waits for approval." });
              p.onDone();
            }
          })
          .finally(() => setBusy(false));
      }}
    >
      {accounts && nets && !options.length ? (
        <p>
          <Link to="/w/$workspaceId/settings/social" params={{ workspaceId: p.workspaceId }} className="underline">
            Connect an account
          </Link>{" "}
          to write a post.
        </p>
      ) : (
        <>
          <Select label="Account" value={chosen?.key ?? ""} onChange={(e) => setKey(e.target.value)}>
            {options.map((o) => (
              <option key={o.key} value={o.key}>
                {o.hand ? `${o.label} (you post it)` : o.label}
              </option>
            ))}
          </Select>
          <Textarea label="Post" autoFocus required rows={4} value={text} onChange={(e) => setText(e.target.value)} />
          <Input label="When" type="datetime-local" required value={when} onChange={(e) => setWhen(e.target.value)} />
          {error && <p className="text-destructive">{error}</p>}
          <div className="flex flex-wrap gap-1">
            <Button type="submit" size="sm" pending={busy} disabled={!chosen || !text.trim()}>
              Add for approval
            </Button>
            <Button type="button" size="sm" variant="outline" onClick={p.onCancel}>
              Cancel
            </Button>
          </div>
        </>
      )}
    </form>
  );
}

type Band = Pick<Listed, "id" | "title" | "status" | "startsOn" | "endsOn" | "needApproval"> & { launchOn?: string | null };
/** Campaigns that are on or coming, not ended or still a Draft, so a band means work that can go out. */
const SHOWN = new Set(["running", "scheduled", "paused", "awaiting_signoff"]);

/**
 * The week's Campaigns as bands over the days they run, so which pieces belong together reads at a glance.
 * Columns match the week grid's: a 5rem label column, then a column a day. Wide screens only; a phone's list
 * names each card's Campaign instead.
 */
export function CampaignBands(p: { workspaceId: string; days: Date[]; campaigns: Band[]; only?: string }) {
  const first = isoDay(p.days[0]!);
  const last = isoDay(p.days[p.days.length - 1]!);
  // A moved launch moves the whole run: its end shifts by the same days as its start.
  const bands = p.campaigns.flatMap((c) => {
    const start = c.launchOn ?? c.startsOn;
    if (!start || !c.startsOn || !c.endsOn) return [];
    const end = new Date(Date.parse(c.endsOn) + Date.parse(start) - Date.parse(c.startsOn)).toISOString().slice(0, 10);
    return SHOWN.has(c.status) && start <= last && end >= first && (!p.only || c.id === p.only) ? [{ ...c, start, end }] : [];
  });
  if (!bands.length) return null;
  const col = (on: string) => p.days.findIndex((d) => isoDay(d) === on);
  return (
    <ul aria-label="Campaigns this week" className="hidden gap-y-1 lg:grid" style={{ gridTemplateColumns: `5rem repeat(${p.days.length}, minmax(0, 1fr))` }}>
      {bands.map((c) => {
        const from = c.start < first ? 0 : col(c.start);
        const to = c.end > last ? p.days.length - 1 : col(c.end);
        return (
          <li key={c.id} className="flex min-w-0 items-center gap-2 rounded-sm bg-muted px-2 py-1 text-xs" style={{ gridColumn: `${from + 2} / ${to + 3}` }}>
            {c.start < first && <span aria-hidden>‹</span>}
            <Link to="/w/$workspaceId/campaigns/$campaignId" params={{ workspaceId: p.workspaceId, campaignId: c.id }} className="truncate font-semibold no-underline hover:underline">
              {c.title}
            </Link>
            <span className="shrink-0 text-muted-foreground">{campaignStatus(c)}</span>
            {c.needApproval > 0 && <span className="shrink-0 rounded-sm bg-peach px-1.5 font-medium text-peach-foreground">{c.needApproval} {c.needApproval === 1 ? "needs" : "need"} you</span>}
            {c.end > last && (
              <span aria-hidden className="ml-auto">
                ›
              </span>
            )}
          </li>
        );
      })}
    </ul>
  );
}
