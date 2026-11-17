// SPDX-License-Identifier: AGPL-3.0-only
// One-click rewrites on an email written for one person, or on a campaign post: a preset, a reason it's
// not right, or the person's own words. The writer runs on its own, so this
// waits for the Item's next revision and then says it changed.
import { useEffect, useState, type FormEvent } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { Button } from "@/components/Button";
import { Input } from "@/components/Input";
import { toast } from "@/components/toast";
import { inWorkspace } from "../api/query";
import { cancelRun, isLive, runDetail, stopReason } from "../agents/actions";
import { Notice } from "../components/layout";
import { useAction } from "../components/useAction";
import { itemQuery, rewrite, type RejectReason, type RewritePreset } from "./actions";

const PRESETS: [RewritePreset, string][] = [
  ["shorter", "Shorter"],
  ["longer", "Longer"],
  ["casual", "More casual"],
  ["formal", "More formal"],
  ["again", "Try again"],
];

// "Not like this": the server says each reason to the writer in words and counts it against the email's step.
// Wrong facts also points to Brand, since a wrong fact is fixed there once, not in each draft.
export const REASONS: [RejectReason, string][] = [
  ["salesy", "Too salesy"],
  ["long", "Too long"],
  ["facts", "Wrong facts"],
  ["voice", "Not our voice"],
  ["audience", "Wrong audience"],
];
const MAX_WORDS = 300;

type Noun = "email" | "post";
const wordsFor = (noun: Noun): Record<string, string> => ({
  from_template: "This email comes from its step's text, so change that text on the Campaign instead.",
  already_going: `This ${noun} is already on its way, so it can't be rewritten.`,
  not_a_campaign_email: "Only a Campaign's email or post can be rewritten so far.",
  step_not_in_plan: `This ${noun}'s step is no longer in the plan, so it can't be rewritten.`,
  no_route: "No AI is set up to write. Sign in to Claude Code or Codex on the AI models page.",
  disabled: `The ${noun} writer is turned off for this Workspace.`,
});

/** Why a finished rewrite was not used, keyed by the code its version was turned down with. */
const keptFor = (noun: Noun): Record<string, string> => ({
  changed_since: `The ${noun} changed while it was being rewritten, so the rewrite wasn't used and the ${noun} stays as it is.`,
  refused_by_network: `The rewrite broke the network's rules, so the ${noun} stays as it was. Try again, or say what to change.`,
  other: `The rewrite didn't pass Direx's checks, so the ${noun} stays as it was. Try again, or say what to change.`,
});

/** Why Cancel didn't stop a rewrite, keyed by the code the run refused it with. */
const CANCEL_REFUSALS: Record<string, string> = {
  not_allowed: "Only the person who started this rewrite or an Admin can cancel it.",
  already_ended: "This rewrite has already ended.",
};

/** How long to wait before saying it's taking longer than usual. Rewrites usually take about 15 seconds. */
const SLOW_MS = 90_000;

/**
 * `opened` is when the Item was opened, sent with a reason so it is recorded like a decision. `onDone` reloads a
 * screen that doesn't read the Item's query, such as a step's posts.
 */
export function Rewrite(p: { workspaceId: string; id: string; revision: number; opened?: string; noun?: Noun; onDone?: () => void }) {
  const noun = p.noun ?? "email";
  const KEPT = keptFor(noun);
  const client = useQueryClient();
  const action = useAction(wordsFor(noun));
  const [own, setOwn] = useState("");
  const [reason, setReason] = useState<RejectReason>();
  // The revision the rewrite started from; a higher one means the new version is here.
  const [from, setFrom] = useState<number>();
  const [slow, setSlow] = useState(false);
  // The writer's run, watched so a run that stops without a new version says why instead of waiting forever.
  const [run, setRun] = useState<string>();
  const [stopped, setStopped] = useState<string>();
  // The Item's own query, polled while waiting, sees the new revision before the screen around it does.
  const { data: fresh } = useQuery({ ...itemQuery(p.workspaceId, p.id), refetchInterval: from !== undefined ? 3_000 : false });
  const revision = Math.max(p.revision, fresh?.item.revision ?? 0);
  const waiting = from !== undefined && revision <= from;
  const { data: ran } = useQuery({ queryKey: inWorkspace(p.workspaceId, "agents", "runs", run), queryFn: () => runDetail(p.workspaceId, run!), enabled: waiting && run !== undefined, refetchInterval: 3_000 });

  useEffect(() => {
    if (from === undefined || waiting) return;
    setFrom(undefined);
    setSlow(false);
    setRun(undefined);
    toast.add({ title: "Rewritten. Read it before you approve." });
    void client.invalidateQueries({ queryKey: inWorkspace(p.workspaceId) });
    p.onDone?.();
  }, [from, waiting]);
  useEffect(() => {
    if (!waiting || !ran || isLive(ran)) return;
    // A finished run whose version was turned down leaves the email as it was; otherwise the new revision is on its way.
    const refused = ran.status === "succeeded" ? ran.proposals.find((x) => x.rejectionCode)?.rejectionCode : undefined;
    if (ran.status === "succeeded" && !refused) return;
    setFrom(undefined);
    setSlow(false);
    setRun(undefined);
    setStopped(refused ? (KEPT[refused] ?? KEPT.other) : ran.status === "cancelled" ? `The rewrite was cancelled, so the ${noun} stays as it was.` : `The rewrite stopped: ${stopReason(ran)}.`);
  }, [ran, waiting]);
  useEffect(() => {
    if (!waiting) return;
    const t = setTimeout(() => setSlow(true), SLOW_MS);
    return () => clearTimeout(t);
  }, [waiting]);

  async function start(asked: { preset: RewritePreset } | { reason: RejectReason; instruction?: string } | { instruction: string }) {
    setStopped(undefined);
    let started: string | undefined;
    const code = await action.run(async () => {
      const r = await rewrite(p.workspaceId, p.id, asked, p.opened);
      started = r.runId;
      return r.error;
    });
    if (!code) {
      setRun(started);
      setFrom(revision);
      setOwn("");
      setReason(undefined);
    }
  }
  // Stops the writer's run; the run's next read sees it cancelled and says so.
  const [cancelling, setCancelling] = useState(false);
  async function cancel() {
    setCancelling(true);
    const code = await cancelRun(p.workspaceId, run!).catch(() => "failed");
    setCancelling(false);
    if (code) setStopped(CANCEL_REFUSALS[code] ?? "That didn't go through. Try again.");
  }
  function submit(e: FormEvent) {
    e.preventDefault();
    const words = own.trim();
    if (reason) void start({ reason, ...(words && { instruction: words }) });
    else if (words) void start({ instruction: words });
  }

  const busy = action.pending || waiting;
  return (
    <section aria-label="Rewrite" className="flex flex-col gap-2">
      <div role="group" aria-label="Rewrite it" className="flex flex-wrap gap-1.5">
        {PRESETS.map(([preset, label]) => (
          <Button key={preset} type="button" size="sm" variant="outline" disabled={busy} onClick={() => void start({ preset })}>
            {label}
          </Button>
        ))}
      </div>
      <div role="group" aria-label="Not like this" className="flex flex-wrap items-center gap-1.5">
        <span className="text-sm text-muted-foreground">Not like this:</span>
        {REASONS.map(([key, label]) => (
          <Button key={key} type="button" size="xs" variant={reason === key ? "default" : "outline"} className="rounded-full" aria-pressed={reason === key} disabled={busy} onClick={() => setReason(reason === key ? undefined : key)}>
            {label}
          </Button>
        ))}
      </div>
      {reason === "facts" && (
        <p className="text-sm">
          If a brand fact is wrong,{" "}
          <Link to="/w/$workspaceId/brand" params={{ workspaceId: p.workspaceId }} className="underline underline-offset-4">
            fix it on Brand
          </Link>{" "}
          and every draft gets it right. Say below what's wrong in this one.
        </p>
      )}
      <form onSubmit={submit} className="flex flex-wrap items-center gap-2">
        <Input aria-label="Or say what to change" placeholder={reason ? "Add what to change (optional)" : "Or say what to change"} className="min-w-0 flex-1" value={own} maxLength={MAX_WORDS} onChange={(e) => setOwn(e.target.value)} disabled={busy} />
        <Button type="submit" size="sm" variant="outline" pending={action.pending} disabled={busy || (!reason && !own.trim())}>
          Rewrite
        </Button>
      </form>
      <div className="flex flex-wrap items-center gap-2">
        <p aria-live="polite" className="text-sm text-muted-foreground">
          {waiting ? (slow ? "Still rewriting. The new version shows here when it's ready." : "Rewriting. This usually takes about 15 seconds.") : ""}
        </p>
        {waiting && run && (
          <Button type="button" size="xs" variant="outline" pending={cancelling} aria-label="Cancel this rewrite" onClick={() => void cancel()}>
            Cancel
          </Button>
        )}
      </div>
      {action.error && <Notice tone="error">{action.error}</Notice>}
      {stopped && <Notice tone="error">{stopped}</Notice>}
    </section>
  );
}
