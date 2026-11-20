// SPDX-License-Identifier: AGPL-3.0-only
// A new Workspace's first steps as a wizard, one step on screen at a time: the AI that writes
// (self-host only), reading the website, checking what Direx understood, and a first goal. Each step
// is done when the Workspace shows it, so the page can be left and come back to; it opens on the
// first step not yet done. The router shows it without the rail and menu.
import { useEffect, useRef, useState, type ReactNode } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { inWorkspace } from "../api/query";
import { messageFor, messageForCode } from "../api/messages";
import { POLL_MS, Runs } from "../agents/Runs";
import { isLive, runsQuery } from "../agents/actions";
import { Step as StepItem, Stepper } from "@astryxdesign/core/Stepper";
import { EmptyState, Notice, Page } from "../components/layout";
import { Button, buttonVariants } from "@/components/Button";
import { Skeleton } from "@astryxdesign/core/Skeleton";
import { toast } from "@/components/toast";
import { factItemsQuery, factsQuery } from "../facts/actions";
import { CompetitorsFound } from "../facts/Competitors";
import { approve, cancel, mayEdit, message, type Item, type Role } from "../items/actions";
import { Adapters } from "../models/Adapters";
import { adaptersQuery, modelsQuery, type AdapterList } from "../models/actions";
import { plansQuery } from "../plans/actions";
import { SignIn } from "../identity/SignIn";

/** A sign-in the person may use: their own, or one shared with the Workspace. */
export const aiConnected = (a: AdapterList | undefined) => !!a?.adapters.some((x) => (x.mine || x.shared) && !x.signedOut);

/** `label` is the short name in the step list; `title` heads the step's card. */
type Step = { key: string; label: string; title: string; done: boolean; summary: string; preview: string; allowed: boolean; body: ReactNode };

export function Setup(p: { workspaceId: string; workspaceName: string; role: Role }) {
  const { workspaceId, role } = p;
  const w = { workspaceId };
  const client = useQueryClient();
  const manage = role === "owner" || role === "admin";
  const [error, setError] = useState<string>();
  // The proposed fact whose Accept or Dismiss is running.
  const [busy, setBusy] = useState<string>();
  // Choosing the Workspace's AI needs a recent sign-in; the person signs in again and lands back here.
  const [stepUp, setStepUp] = useState(false);
  // The step on screen, once the person has moved with Back or Next; until then, the first one not done.
  const [at, setAt] = useState<number>();
  const models = useQuery(modelsQuery(workspaceId, false));
  // Someone who can't read the models settings can't connect one either, so the AI step is skipped.
  const deployment = models.isError ? "cloud" : models.data?.deployment;
  const adapters = useQuery({ ...adaptersQuery(workspaceId), enabled: deployment === "self_host" });
  const reads = [useQuery(factsQuery(workspaceId)), useQuery(factItemsQuery(workspaceId)), useQuery(plansQuery(workspaceId))] as const;
  const [facts, waiting, plans] = [reads[0].data, reads[1].data, reads[2].data];
  // The same list the read step shows, so a finished read marks the step done without a second call.
  // ponytail: only the latest runs come back, so a finish followed by that many failed reads reads as not done.
  // Polled here, not only in the read step, so moving on mid-read still sees what it proposes.
  const runs = useQuery({ ...runsQuery(workspaceId, "brand_reader"), refetchInterval: (q) => (q.state.data?.some(isLive) ? POLL_MS : false) });
  const reading = !!runs.data?.some(isLive);
  const wasReading = useRef(reading);
  useEffect(() => {
    if (wasReading.current && !reading) void client.invalidateQueries({ queryKey: inWorkspace(workspaceId) });
    wasReading.current = reading;
  }, [reading]);
  const failed = [...reads, ...(deployment === "self_host" ? [adapters] : [])].find((q) => q.isError);

  if (stepUp) {
    return (
      <SignIn
        title="Confirm it's you"
        note="Choosing the AI for this Workspace needs a recent sign-in. Sign in again, then choose once more."
        callbackURL={location.pathname + location.search}
      />
    );
  }
  if (failed) {
    return (
      <Page title={`Set up ${p.workspaceName}`}>
        <Notice tone="error">{messageFor(failed.error)}</Notice>
        <Button variant="outline" className="self-start" onClick={() => void client.invalidateQueries({ queryKey: inWorkspace(workspaceId) })}>
          Retry
        </Button>
      </Page>
    );
  }
  if (deployment === undefined || facts === undefined || waiting === undefined || plans === undefined || runs.data === undefined || (deployment === "self_host" && adapters.data === undefined)) {
    return (
      <Page title={`Set up ${p.workspaceName}`}>
        <Skeleton className="h-96 w-full" />
      </Page>
    );
  }

  const settle = async (code: string | null, done?: string) => {
    if (code === "step_up_required") return setStepUp(true);
    setError(code ? messageForCode(code) : undefined);
    if (!code && done) toast.add({ title: done });
    await client.invalidateQueries({ queryKey: inWorkspace(workspaceId) });
  };
  const decide = async (i: Item, action: () => Promise<string | null>) => {
    setBusy(i.id);
    try {
      const code = await action();
      setError(code ? message(code) : undefined);
      await client.invalidateQueries({ queryKey: inWorkspace(workspaceId) });
    } finally {
      setBusy(undefined);
    }
  };
  const suggestions = waiting.proposals.length;
  const steps: Step[] = [
    ...(deployment === "self_host"
      ? [
          {
            key: "ai",
            label: "Connect your AI",
            title: "Connect the AI that writes for you",
            done: aiConnected(adapters.data),
            summary: "Connected.",
            preview: "Sign in once with your Claude Code or Codex subscription.",
            // Anyone may sign in their own; Adapters shows only what this role can change.
            allowed: true,
            body: (
              <>
                <p className="text-muted-foreground">Direx writes with your own Claude Code or Codex subscription. Sign in once; no API key is needed.</p>
                <Adapters workspaceId={workspaceId} manage={manage} settle={settle} initial={adapters.data} />
              </>
            ),
          },
        ]
      : []),
    {
      key: "read",
      label: "Read your website",
      title: "Read your website",
      // A read that finished, or one whose proposals wait; facts typed on Brand are no read.
      done: suggestions > 0 || runs.data.some((r) => r.status === "succeeded"),
      summary: "Direx read your site.",
      preview: "Direx reads your site and proposes what you sell and how you sound.",
      allowed: mayEdit(role),
      body: (
        <>
          <p className="text-muted-foreground">Direx reads your site and proposes what you sell, who buys it and how you sound. Nothing is used until you accept it.</p>
          <Runs workspaceId={workspaceId} role={role} embedded address={new URLSearchParams(location.search).get("site") ?? undefined} />
        </>
      ),
    },
    {
      key: "check",
      label: "Check the facts",
      title: "Check what Direx understood",
      done: facts.length > 0 && suggestions === 0,
      summary: `${facts.length} ${facts.length === 1 ? "fact" : "facts"} on Brand.`,
      preview: "Accept or change what Direx proposes about your business.",
      allowed: mayEdit(role),
      body: (
        <>
          <p className="text-muted-foreground">{suggestions > 0 ? "Accept what is right and dismiss what isn't. To change one, accept it and edit it on Brand." : reading ? "Direx is still reading. What it proposes shows here when it finishes." : "When a read finishes, what it proposes shows here."}</p>
          {/* Decided here, so setup never sends a person away mid-way; Brand is there for changing words. */}
          {suggestions > 0 && (
            <ul aria-label="Proposed brand facts" className="flex flex-col divide-y divide-border">
              {waiting.proposals.map((i) => (
                <li key={i.id} className="flex flex-wrap items-center justify-between gap-3 py-3">
                  <span className="min-w-0 font-medium wrap-break-word">{i.title}</span>
                  <span className="flex gap-2">
                    <Button size="sm" aria-label={`Accept ${i.title}`} pending={busy === i.id} onClick={() => void decide(i, () => approve(workspaceId, i))}>
                      Accept
                    </Button>
                    <Button size="sm" variant="outline" aria-label={`Dismiss ${i.title}`} pending={busy === i.id} onClick={() => void decide(i, () => cancel(workspaceId, i.id))}>
                      Dismiss
                    </Button>
                  </span>
                </li>
              ))}
            </ul>
          )}
          <CompetitorsFound workspaceId={workspaceId} role={role} />
          <Link to="/w/$workspaceId/brand" params={w} className="self-start text-sm underline">
            Open Brand
          </Link>
        </>
      ),
    },
    {
      key: "goal",
      label: "Pick a first goal",
      title: "Pick a first goal",
      done: plans.length > 0,
      summary: "A campaign is started.",
      preview: "Start a campaign for your first goal.",
      allowed: mayEdit(role),
      body: (
        <>
          <p className="text-muted-foreground">Start a campaign with your goal. Direx drafts its plan for you to read and approve.</p>
          <Link to="/w/$workspaceId/campaigns" params={w} className={`self-start ${buttonVariants()}`}>
            Start a campaign
          </Link>
        </>
      ),
    },
  ];
  const next = steps.findIndex((s) => !s.done);
  const open = at ?? (next === -1 ? steps.length : next);
  const step = steps[open];
  const last = open === steps.length - 1;

  // Forward: Next once the step is done, Continue while a read runs, otherwise a quiet skip.
  const forward = step?.done ? (last ? "Finish" : "Next") : step?.key === "read" && reading ? "Continue while it reads" : "Skip this step";

  return (
    <Page
      title={`Set up ${p.workspaceName}`}
      description="A few steps so Direx knows your business. You can leave and come back; a finished step stays finished."
      actions={
        <Link to="/w/$workspaceId" params={w} className={buttonVariants({ variant: "outline", size: "sm" })}>
          {next === -1 ? "Go to Home" : "Finish setup later"}
        </Link>
      }
    >
      {error && <Notice tone="error">{error}</Notice>}
      <div className="grid gap-8 lg:grid-cols-[16rem_1fr] lg:items-start">
        <Stepper activeStep={open} orientation="vertical" label="Setup steps" onStepClick={setAt}>
          {steps.map((s, n) => (
            // A step skipped on the way past would otherwise draw (and announce) as completed.
            <StepItem key={s.key} step={n} label={s.label} description={s.done ? `Done. ${s.summary}` : n < open ? `Not done yet. ${s.preview}` : s.preview} indicator={s.done || n < open ? "auto" : "number"} status={s.done ? "success" : n < open ? "warning" : undefined} />
          ))}
        </Stepper>
        {step ? (
          <section aria-label={step.title} className="flex flex-col gap-5 rounded-card border border-border bg-card p-6 sm:p-8">
            <div className="flex flex-col gap-1">
              <p className="text-sm text-muted-foreground">{`Step ${open + 1} of ${steps.length}${step.done ? " · Done" : ""}`}</p>
              <h2>{step.title}</h2>
            </div>
            {step.allowed ? step.body : <p className="text-muted-foreground">Ask an Owner or Admin to run this step.</p>}
            <div className="flex flex-wrap items-center justify-between gap-3 border-t border-border pt-5">
              {open > 0 ? (
                <Button variant="ghost" onClick={() => setAt(open - 1)}>
                  Back
                </Button>
              ) : (
                <span />
              )}
              <Button variant={forward === "Skip this step" ? "ghost" : undefined} onClick={() => setAt(open + 1)}>
                {forward}
              </Button>
            </div>
          </section>
        ) : (
          <EmptyState
            title={next === -1 ? "You're set up" : "That's all the steps"}
            action={
              <span className="flex flex-wrap gap-3">
                {next !== -1 && (
                  <Button variant="outline" onClick={() => setAt(next)}>
                    Back to what's left
                  </Button>
                )}
                <Link to="/w/$workspaceId" params={w} className={buttonVariants()}>
                  Go to Home
                </Link>
              </span>
            }
          >
            {next === -1 ? "What needs you shows on Home." : "Some steps are still open. Come back to them here any time."}
          </EmptyState>
        )}
      </div>
    </Page>
  );
}
