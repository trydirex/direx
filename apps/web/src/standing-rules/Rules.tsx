// SPDX-License-Identifier: AGPL-3.0-only
// Standing rules: what each one covers and how much it has done, and the form that creates one.
import { Link } from "@tanstack/react-router";
import { useState } from "react";
import { useQueries, useQuery, useQueryClient } from "@tanstack/react-query";
import { ApiError, inWorkspace } from "../api/query";
import { EmptyState, Field, Notice, Page } from "../components/layout";
import { QueryBoundary } from "../components/QueryBoundary";
import { Button, buttonVariants } from "@/components/Button";
import { Input } from "@/components/Input";
import { Skeleton } from "@astryxdesign/core/Skeleton";
import { SignIn } from "../identity/SignIn";
import { StatusChip, type Tone } from "../components/StatusChip";
import { Dialog } from "@astryxdesign/core/Dialog";
import { campaignQuery, dayWords } from "../campaigns/actions";
import { agentOfferQuery, coverageQuery, grant, grantAgentWritten, mayGrant, reconfirm, revoke, rulesQuery, say, STATUS, type Offer, type Rule, type Scope } from "./actions";

const SUGGESTED_CAP = 50;

const CARD = "flex flex-col gap-4 rounded-card border border-border bg-card p-6";
const HEADING = "text-md font-medium tracking-tight";
const NOTE = "text-sm text-muted-foreground";

const covers = (counts: { people: number; waiting: number } | undefined) =>
  counts && ` It covers ${counts.people} ${counts.people === 1 ? "person" : "people"} in this campaign now, and ${counts.waiting} ${counts.waiting === 1 ? "email" : "emails"} waiting for approval.`;

function EndsOn(p: { value: string; onChange: (v: string) => void }) {
  return (
    <div className="max-w-xs">
      <Field label="Ends on" hint={<small>Leave empty for 90 days.</small>}>
        <Input type="date" value={p.value} onChange={(e) => p.onChange(e.target.value)} />
      </Field>
    </div>
  );
}

/** A step in words: its title from the Campaign once read, "this step" until then. */
function useStepWords(workspaceId: string, s: Scope) {
  const title = useQuery(campaignQuery(workspaceId, s.campaignId)).data?.steps?.find((x) => x.key === s.stepKey)?.title?.replace(/\.$/, "");
  return title ? `the step “${title}”` : "this step";
}

export function GrantForm(p: { workspaceId: string; scope: Scope; initialCounts?: { people: number; waiting: number }; onDone: (code: string | null) => void }) {
  const counts = useQuery({ ...coverageQuery(p.workspaceId, p.scope), initialData: p.initialCounts }).data;
  const step = useStepWords(p.workspaceId, p.scope);
  const [cap, setCap] = useState(SUGGESTED_CAP);
  const [ends, setEnds] = useState("");
  const [pending, setPending] = useState(false);
  return (
    <form
      aria-label="Set up auto-approve"
      className={CARD}
      onSubmit={async (e) => {
        e.preventDefault();
        setPending(true);
        p.onDone(await grant(p.workspaceId, p.scope, { dailyCap: cap, ...(ends && { expiresAt: new Date(ends).toISOString() }) }).finally(() => setPending(false)));
      }}
    >
      <h2 className={HEADING}>Set up auto-approve</h2>
      <p>
        Direx will approve emails from this template in {step} without asking you each time.
        {covers(counts)}
      </p>
      <div className="max-w-xs">
        <Field label="Emails per day">
          <Input type="number" min={1} max={10000} required value={cap} onChange={(e) => setCap(Number(e.target.value))} />
        </Field>
      </div>
      <EndsOn value={ends} onChange={setEnds} />
      <p className={NOTE}>Emails with a warning still come to you. It stops approving if the template, your facts or how it sends change.</p>
      <div>
        <Button type="submit" pending={pending}>
          Turn on auto-approve
        </Button>
      </div>
    </form>
  );
}

// The safety gate names its evals by id; a person reads what each one checks.
const CHECK_WORDS: Record<string, string> = {
  claim_check: "The check that each email only claims what your brand facts say",
  injection_check: "The check that a website can't give the agent instructions",
  hostile_pages: "The test on websites written to trick the agent",
  optout_detect: "The test that replies asking to stop are always caught",
};
export const missingWords = (missing: readonly string[]) => [...new Set(missing.map((m) => (m.includes(": ") ? (CHECK_WORDS[m.split(": ")[0]!] ?? "Another safety check") : "Direx's sign-off on what counts as a pass")))];

function AgentGrantFields(p: { workspaceId: string; scope: Scope; offer: Offer; counts?: { people: number; waiting: number }; onDone: (code: string | null) => void }) {
  const { offer } = p;
  const step = useStepWords(p.workspaceId, p.scope);
  const [agreed, setAgreed] = useState(false);
  const [ends, setEnds] = useState("");
  const [pending, setPending] = useState(false);
  if (!offer.offered)
    return (
      <section aria-label="Auto-approve for unread emails" className={CARD}>
        <h2 className={HEADING}>Auto-approve for unread emails isn't available yet</h2>
        <p>Direx turns this on only after its safety checks pass for the agent that writes these emails. Still missing:</p>
        <ul className="flex list-disc flex-col gap-1 pl-6">
          {missingWords(offer.missing).map((m) => (
            <li key={m}>{m}</li>
          ))}
        </ul>
      </section>
    );
  const enough = offer.approvals >= offer.needed;
  return (
    <form
      aria-label="Set up auto-approve for unread emails"
      className={CARD}
      onSubmit={async (e) => {
        e.preventDefault();
        setPending(true);
        p.onDone(await grantAgentWritten(p.workspaceId, p.scope, { wordingVersion: offer.wordingVersion, ...(ends && { expiresAt: new Date(ends).toISOString() }) }).finally(() => setPending(false)));
      }}
    >
      <h2 className={HEADING}>Auto-approve emails the agent writes</h2>
      <p>
        You've approved {offer.approvals} of {offer.needed} emails from this agent in {step} without edits.
        {covers(p.counts)}
      </p>
      <ul className="flex list-disc flex-col gap-1 pl-6">
        {offer.statements.map((s) => (
          <li key={s}>{s}</li>
        ))}
      </ul>
      <label className="flex min-h-6 items-center gap-2 text-sm font-medium">
        <input type="checkbox" className="size-4" required checked={agreed} onChange={(e) => setAgreed(e.target.checked)} /> I've read this and want these emails sent without anyone reading them
      </label>
      <EndsOn value={ends} onChange={setEnds} />
      <p className={NOTE}>Each email still has to pass its checks, and still goes through every send check. An email with a warning, or from a newer version of the agent, still comes to you.</p>
      <p className={NOTE}>You may be asked to sign in again before it is created.</p>
      <div>
        <Button type="submit" disabled={!enough || !agreed} pending={pending}>
          Turn on auto-approve
        </Button>
      </div>
    </form>
  );
}

/** Auto-approve over emails an agent writes for each person. No one reads them, so the form says so and needs one tick. */
export function AgentGrantForm(p: { workspaceId: string; scope: Scope; initialOffer?: Offer; initialCounts?: { people: number; waiting: number }; onDone: (code: string | null) => void }) {
  const offer = useQuery({ ...agentOfferQuery(p.workspaceId, p.scope), initialData: p.initialOffer });
  const counts = useQuery({ ...coverageQuery(p.workspaceId, p.scope), initialData: p.initialCounts }).data;
  return (
    <QueryBoundary query={offer} skeleton={<Skeleton className="h-64 w-full" />}>
      {(o) => <AgentGrantFields workspaceId={p.workspaceId} scope={p.scope} offer={o} counts={counts} onDone={p.onDone} />}
    </QueryBoundary>
  );
}

/** Any Member can stop a rule, with a reason. The reason asks only once Stop is pressed. */
function Stop(p: { name: string; onStop: (reason: string) => Promise<void> }) {
  const [asking, setAsking] = useState(false);
  const [reason, setReason] = useState("");
  const [pending, setPending] = useState(false);
  if (!asking)
    return (
      <Button size="sm" variant="outline" aria-label={`Stop ${p.name}`} onClick={() => setAsking(true)}>
        Stop
      </Button>
    );
  return (
    <form
      aria-label="Stop this rule"
      className="flex flex-wrap items-end gap-2"
      onSubmit={(e) => {
        e.preventDefault();
        setPending(true);
        void p.onStop(reason).finally(() => setPending(false));
      }}
    >
      <Field label="Why">
        <Input className="h-9" required autoFocus maxLength={500} value={reason} onChange={(e) => setReason(e.target.value)} />
      </Field>
      <Button type="submit" size="sm" variant="outline" aria-label={`Confirm stop: ${p.name}`} pending={pending}>
        Confirm stop
      </Button>
      <Button type="button" size="sm" variant="ghost" onClick={() => setAsking(false)}>
        Cancel
      </Button>
    </form>
  );
}

const TONE: Record<Rule["status"], Tone> = { active: "good", suspended: "attention", revoked: "off", expired: "off" };

/** "{Campaign} › {step}" once its Campaign is read, undefined while it loads. */
function RuleRow(p: { workspaceId: string; rule: Rule; name?: string | undefined; manage: boolean; settle: (code: string | null) => void }) {
  const { rule: r } = p;
  const [confirming, setConfirming] = useState(false);
  const { name } = p;
  const label = name ?? "this rule";
  return (
    <li className="flex flex-col gap-3 rounded-card border border-border bg-card p-5">
      {/* A div, not a p: while the name loads its place holds a Skeleton, which is a div. */}
      <div className="flex flex-wrap items-center gap-2">
        {name ? (
          <Link className="font-medium underline" to="/w/$workspaceId/campaigns/$campaignId" params={{ workspaceId: p.workspaceId, campaignId: r.campaignId }}>
            {name}
          </Link>
        ) : (
          <Skeleton className="h-5 w-48" />
        )}{" "}
        <StatusChip tone={TONE[r.status]}>{STATUS[r.status]}</StatusChip>
        {r.suspendedReason && `: ${r.suspendedReason}`}
      </div>
      <p className="text-sm text-muted-foreground">
        {r.mode === "agent_written" ? `No one reads these before they go. ${r.writtenBy ?? "An agent"} writes them. No daily limit beyond the email account's, ${r.usedToday} sending today, ${r.total} approved in all.` : `Up to ${r.dailyCap} a day, ${r.usedToday} sending today, ${r.total} approved in all.`} Ends{" "}
        {dayWords(r.expiresAt.slice(0, 10))}. Granted by {r.granterEmail ?? "someone who has left"}.
        {r.stoppedByEmail && ` Stopped by ${r.stoppedByEmail}${r.stopReason ? `: ${r.stopReason}` : ""}.`}
      </p>
      {r.status !== "revoked" && (
        <div className="flex flex-wrap items-end gap-3">
          {p.manage && r.status !== "active" && (
            <Button
              size="sm"
              aria-label={`Re-confirm ${label}`}
              pending={confirming}
              onClick={async () => {
                setConfirming(true);
                p.settle(await reconfirm(p.workspaceId, r.id).finally(() => setConfirming(false)));
              }}
            >
              Re-confirm
            </Button>
          )}{" "}
          <Stop name={label} onStop={async (reason) => p.settle(await revoke(p.workspaceId, r.id, reason))} />
        </div>
      )}
    </li>
  );
}

export function Rules(p: { workspaceId: string; role: string; grantFor?: Scope | undefined; agentWritten?: boolean | undefined; initial?: Rule[] }) {
  const client = useQueryClient();
  const list = useQuery({ ...rulesQuery(p.workspaceId), initialData: p.initial });
  // Each rule's Campaign, read once per Campaign and usually cached from its page, names the rule by its title and step.
  const ids = [...new Set((list.data ?? []).map((r) => r.campaignId))];
  const details = useQueries({ queries: ids.map((id) => ({ ...campaignQuery(p.workspaceId, id), enabled: !p.initial })) });
  const nameOf = (r: Rule) => {
    const c = details[ids.indexOf(r.campaignId)];
    if (c?.error) return c.error instanceof ApiError && c.error.status === 404 ? "A Campaign that was deleted" : "A Campaign Direx couldn't read";
    if (!c?.data) return undefined;
    const step = c.data.steps?.find((s) => s.key === r.stepKey)?.title?.replace(/\.$/, "") ?? "A step that was removed";
    return `${c.data.title} › ${step}`;
  };
  const [error, setError] = useState<string>();
  const [stepUp, setStepUp] = useState(false);
  const [form, setForm] = useState(p.grantFor);
  const manage = mayGrant(p.role);

  async function settle(code: string | null) {
    if (code === "step_up_required") return setStepUp(true);
    setError(code ? say(code) : undefined);
    if (!code) setForm(undefined);
    await client.invalidateQueries({ queryKey: inWorkspace(p.workspaceId) });
  }

  return (
    <Page title="Auto-approve" description="An auto-approve rule approves one step's emails for you until it ends. Anyone in this workspace can stop one.">
      {/* Signing in again reloads this page (SignIn sends the browser to callbackURL), so the dialog only has to sit over it until then. */}
      <Dialog isOpen={stepUp} onOpenChange={setStepUp} purpose="form" width={448} aria-label="Confirm it's you">
        {stepUp && <SignIn title="Confirm it's you" note="Changing auto-approve needs a recent sign-in. Sign in again, then press Turn on, Re-confirm or Stop once more." callbackURL={location.pathname + location.search} />}
      </Dialog>
      <section aria-label="Always asks you first" className="flex flex-col gap-2 rounded-card bg-muted p-5">
        <h2 className="font-sans text-base font-medium">Direx always asks you first for</h2>
        <ul className="grid list-disc gap-x-8 gap-y-1 pl-5 text-sm sm:grid-cols-2">
          <li>Any email no rule below covers</li>
          <li>Any email after its rule ends or is stopped</li>
          <li>An email with a warning on it</li>
          <li>An email from a template or agent that changed since you said yes</li>
        </ul>
      </section>
      {error && <Notice tone="error">{error}</Notice>}
      {form &&
        (manage ? (
          p.agentWritten ? (
            <AgentGrantForm workspaceId={p.workspaceId} scope={form} onDone={(c) => void settle(c)} />
          ) : (
            <GrantForm workspaceId={p.workspaceId} scope={form} onDone={(c) => void settle(c)} />
          )
        ) : (
          <Notice>Only Owners and Admins can set up auto-approve.</Notice>
        ))}
      <QueryBoundary query={list} skeleton={<Skeleton className="h-32 w-full" />}>
        {(rules) =>
          rules.length === 0 ? (
            <EmptyState
              title="No auto-approve rules yet"
              action={
                <Link to="/w/$workspaceId/campaigns" params={{ workspaceId: p.workspaceId }} className={buttonVariants({ size: "sm" })}>
                  Go to Campaigns
                </Link>
              }
            >
              Set one up from a template step in a Campaign.
            </EmptyState>
          ) : (
            <ul aria-label="Rules" className="flex flex-col gap-4">
              {rules.map((r) => (
                <RuleRow key={r.id} workspaceId={p.workspaceId} rule={r} name={nameOf(r)} manage={manage} settle={(c) => void settle(c)} />
              ))}
            </ul>
          )
        }
      </QueryBoundary>
    </Page>
  );
}
