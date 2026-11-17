// SPDX-License-Identifier: AGPL-3.0-only
// Which AI runs in this Workspace, on self-host only: API keys, Claude Code or Codex, with an
// optional change per agent. A sign-in's value never reaches this page.
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Field, Notice, Section } from "../components/layout";
import { QueryBoundary } from "../components/QueryBoundary";
import { Button } from "@/components/Button";
import { Input, Select } from "@/components/Input";
import { Skeleton } from "@astryxdesign/core/Skeleton";
import { adaptersQuery, AGENT_NAMES, chooseAdapter, chooseForAgent, finishSignIn, signOut, startSignIn, testAdapter, type AdapterId, type AdapterList, type AdapterRow, type Choice, type SignInStart } from "./actions";


type Settle = (code: string | null, done?: string) => Promise<unknown>;

function statusOf(a: AdapterRow): string {
  if (a.blocked === "not_installed") return `Not installed. Install ${a.label} on the machine running Direx, then reload this page.`;
  if (a.blocked) return a.blocked;
  if (a.signedOut) return "Signed out. Direx can't use this sign-in until you sign in again.";
  if (a.shared && a.mine) return "Signed in for this Workspace and just for you";
  if (a.shared) return "Signed in for this Workspace";
  return a.mine ? "Signed in just for you" : "Not signed in";
}

function ChoiceFields(p: { label: string; none: string; value: Choice; adapters: AdapterRow[]; onChange: (c: Choice) => void }) {
  const chosen = p.adapters.find((a) => a.id === p.value.adapter);
  return (
    <span className="flex flex-wrap items-center gap-2">
      <Select aria-label={p.label} value={p.value.adapter ?? ""} onChange={(e) => p.onChange({ adapter: (e.target.value || null) as AdapterId | null, model: null })}>
        <option value="">{p.none}</option>
        {p.adapters.map((a) => (
          <option key={a.id} value={a.id}>
            {a.label}
          </option>
        ))}
      </Select>
      {chosen && (
        <Select aria-label={`Model for ${p.label}`} value={p.value.model ?? ""} onChange={(e) => p.onChange({ adapter: chosen.id, model: e.target.value || null })}>
          <option value="">Default model</option>
          {chosen.models.map((m) => (
            <option key={m} value={m}>
              {m}
            </option>
          ))}
        </Select>
      )}
      {chosen && !chosen.evaluated && <small className="text-sm text-muted-foreground">Not tested with Direx</small>}
    </span>
  );
}

/** The agents that write what people read. Checks are never among them: they keep their own tested models. */
export const WRITERS = ["plan_drafter", "campaign_drafter", "recipient_writer"] as const;
/** Each AI's models run smallest to largest, so a tier is a place in that list. */
const TIERS = [
  { label: "Cheapest", hint: "The smallest model. Costs least; fine for short, plain emails." },
  { label: "Balanced", hint: "A mid-size model for plans, Campaigns and emails." },
  { label: "Best writing", hint: "The largest model. The best words, at the highest cost." },
] as const;

/** Which tier the writers are on: all three on one tier's model, none changed (null), or set one by one ("custom"). */
export function writingTier(models: readonly string[], adapter: string, agents: AdapterList["agents"]): number | null | "custom" {
  const rows = WRITERS.map((w) => agents.find((r) => r.agent === w));
  if (rows.every((r) => !r)) return null;
  const i = models.indexOf(rows[0]?.model ?? "");
  return i >= 0 && rows.every((r) => r?.adapter === adapter && r.model === models[i]) ? i : "custom";
}

/** One choice for how well the writers write, on the Workspace's AI. Sets each writer's model below; a tier opens only once every writer has passed its eval on that model. */
function WritingQuality(p: { adapter: AdapterRow; agents: AdapterList["agents"]; onPick: (model: string) => Promise<void> }) {
  const models = p.adapter.models.slice(0, TIERS.length);
  const tier = writingTier(models, p.adapter.id, p.agents);
  const [saving, setSaving] = useState(false);
  if (models.length < TIERS.length) return null;
  return (
    <fieldset className="flex flex-col gap-2" disabled={saving}>
      <legend className="mb-1 font-medium">Writing quality</legend>
      <p className="text-sm text-muted-foreground">For the plan, Campaign and email drafters. A choice opens once all three pass Direx's eval on its model. The checks that run before anything sends keep their own tested models, whatever you pick.</p>
      {TIERS.map((t, i) => {
        const tested = p.adapter.writing.includes(models[i]!);
        return (
        <label key={t.label} className={`flex items-start gap-2 ${tested ? "" : "text-muted-foreground"}`}>
          <input
            type="radio"
            name="writing-quality"
            className="mt-1"
            disabled={!tested}
            checked={tier === i}
            onChange={() => {
              setSaving(true);
              void p.onPick(models[i]!).finally(() => setSaving(false));
            }}
          />
          <span>
            {t.label} <small className="text-sm text-muted-foreground">({models[i]})</small>
            <span className="block text-sm text-muted-foreground">{tested ? t.hint : "Waiting for a passing eval on this model."}</span>
          </span>
        </label>
        );
      })}
      {tier === "custom" && <p className="text-sm text-muted-foreground">Custom: the drafters are set one by one under Agents.</p>}
      {tier === null && <p className="text-sm text-muted-foreground">Not chosen: the drafters use the Workspace's model.</p>}
    </fieldset>
  );
}

function SignInSteps(p: { start: SignInStart; pasteCode: boolean; busy: boolean; onFinish: (code: string | null) => void }) {
  const [code, setCode] = useState("");
  return (
    <form
      className="flex flex-col items-start gap-3 rounded-card bg-muted p-4"
      onSubmit={(e) => {
        e.preventDefault();
        p.onFinish(p.pasteCode ? code.trim() : null);
      }}
    >
      {p.start.link.startsWith("https://") && (
        <p>
          <a className="underline" href={p.start.link} target="_blank" rel="noreferrer">
            Open the sign-in page
          </a>
        </p>
      )}
      {p.start.userCode && <p>Enter this code there: {p.start.userCode}</p>}
      {p.pasteCode ? (
        <Field label="Paste the code it shows you">
          <Input value={code} onChange={(e) => setCode(e.target.value)} autoComplete="off" spellCheck={false} required />
        </Field>
      ) : (
        <p>Come back here once you've signed in.</p>
      )}
      <Button type="submit" pending={p.busy}>
        {p.busy ? "Signing in. This can take a minute." : "Finish signing in"}
      </Button>
    </form>
  );
}

export function Adapters(p: { workspaceId: string; manage: boolean; settle: Settle; status?: string; initial?: AdapterList }) {
  const { workspaceId, manage } = p;
  const adapters = useQuery({ ...adaptersQuery(workspaceId), initialData: p.initial });
  const [pending, setPending] = useState<{ adapter: AdapterRow; start: SignInStart }>();
  const [busy, setBusy] = useState(false);
  const [starting, setStarting] = useState<string>();
  const [acted, setActed] = useState(false);
  /** The aria-label of the button whose write is running. */
  const [running, setRunning] = useState<string>();
  const press = (label: string, work: () => Promise<unknown>) => () => {
    setRunning(label);
    void work().finally(() => setRunning(undefined));
  };

  // settle refreshes every query in the Workspace, this list included.
  const act = async (code: string | null, done?: string) => {
    setActed(true);
    await p.settle(code, done);
  };
  const begin = async (adapter: AdapterRow, shared: boolean) => {
    setStarting(`Starting the ${adapter.label} sign-in. This can take a few seconds.`);
    const r = await startSignIn(workspaceId, adapter.id, shared);
    setStarting(undefined);
    if ("error" in r) return act(r.error);
    setPending({ adapter, start: r });
  };
  const test = async (adapter: AdapterRow) => {
    setStarting(`Testing ${adapter.label}. This can take up to a minute.`);
    const r = await testAdapter(workspaceId, adapter.id).catch(() => "no_receipt");
    setStarting(undefined);
    await act(r, `${adapter.label} works.`);
  };
  const finish = async (code: string | null) => {
    if (!pending) return;
    setBusy(true);
    const r = await finishSignIn(workspaceId, pending.start.id, code);
    setBusy(false);
    if (r !== "bad_code") setPending(undefined);
    await act(r, r ? undefined : `Signed in to ${pending.adapter.label}.`);
  };

  return (
    <Section title="Which AI runs" description="Choose once for this Workspace. API keys use the providers below.">
      <QueryBoundary query={adapters} skeleton={<Skeleton className="h-32 w-full" />}>
        {(list) => {
          const choice = { adapter: list.choice?.adapter ?? null, model: list.choice?.model ?? null } as Choice;
          return (
            <>
              {manage ? (
                <ChoiceFields label="AI for this Workspace" none="API keys" value={choice} adapters={list.adapters} onChange={async (c) => act(await chooseAdapter(workspaceId, c), "Saved.")} />
              ) : (
                <p>This Workspace uses {list.adapters.find((a) => a.id === choice.adapter)?.label ?? "API keys"}.</p>
              )}

              <ul className="flex flex-col gap-3">
                {list.adapters.map((a) => (
                  <li key={a.id} className="flex flex-col gap-2 border-t border-border pt-3 first:border-t-0 first:pt-0">
                    <p>
                      <span className="font-medium">{a.label}</span>: <span className="text-muted-foreground">{statusOf(a)}</span>
                    </p>
                    {!a.blocked && (
                      <div className="flex flex-wrap gap-2">
                        {!a.mine && (
                          <Button size="sm" variant="outline" aria-label={`Sign in to ${a.label} just for me`}
                            pending={running === `Sign in to ${a.label} just for me`}
                            onClick={press(`Sign in to ${a.label} just for me`, () => begin(a, false))}
                          >
                            Sign in just for me
                          </Button>
                        )}
                        {manage && !a.shared && (
                          <Button size="sm" variant="outline" aria-label={`Sign in to ${a.label} for this Workspace`}
                            pending={running === `Sign in to ${a.label} for this Workspace`}
                            onClick={press(`Sign in to ${a.label} for this Workspace`, () => begin(a, true))}
                          >
                            Sign in for this Workspace
                          </Button>
                        )}
                        {(a.mine || a.shared) && (
                          <Button size="sm" variant="outline" aria-label={`Test ${a.label}`} disabled={!!starting} pending={running === `Test ${a.label}`} onClick={press(`Test ${a.label}`, () => test(a))}>
                            Test
                          </Button>
                        )}
                        {a.mine && (
                          <Button size="sm" variant="outline" aria-label={`Sign out of ${a.label} just for me`}
                            pending={running === `Sign out of ${a.label} just for me`}
                            onClick={press(`Sign out of ${a.label} just for me`, async () => act(await signOut(workspaceId, a.id, false), "Signed out."))}
                          >
                            Sign out just for me
                          </Button>
                        )}
                        {manage && a.shared && (
                          <Button size="sm" variant="outline" aria-label={`Sign out of ${a.label} for this Workspace`}
                            pending={running === `Sign out of ${a.label} for this Workspace`}
                            onClick={press(`Sign out of ${a.label} for this Workspace`, async () => act(await signOut(workspaceId, a.id, true), "Signed out."))}
                          >
                            Sign out for this Workspace
                          </Button>
                        )}
                      </div>
                    )}
                  </li>
                ))}
              </ul>
              {pending && <SignInSteps start={pending.start} pasteCode={pending.adapter.signIn === "setup_token"} busy={busy} onFinish={(c) => void finish(c)} />}
              {starting ? <Notice>{starting}</Notice> : acted && p.status && <Notice>{p.status}</Notice>}
              <p className="text-sm text-muted-foreground">Scheduled and other background work uses the sign-in for this Workspace, never one that's just for a person.</p>

              {manage && list.adapters.find((a) => a.id === choice.adapter) && (
                <WritingQuality
                  adapter={list.adapters.find((a) => a.id === choice.adapter)!}
                  agents={list.agents}
                  onPick={async (model) => {
                    // One save per drafter; the first refusal stops the rest and is said on the page.
                    for (const w of WRITERS) {
                      const code = await chooseForAgent(workspaceId, w, { adapter: choice.adapter, model });
                      if (code) return void (await act(code));
                    }
                    await act(null, "Saved.");
                  }}
                />
              )}

              {manage && (
                <>
                  <h3 className="font-medium">Agents</h3>
                  <ul className="flex flex-col gap-3">
                    {Object.entries(AGENT_NAMES).map(([agent, name]) => {
                      const row = list.agents.find((r) => r.agent === agent);
                      return (
                        <li key={agent} className="flex flex-wrap items-center gap-2">
                          <span className="min-w-40">{name}:</span>
                          <ChoiceFields
                            label={`AI for ${name}`}
                            none="Same as the Workspace"
                            value={{ adapter: (row?.adapter ?? null) as AdapterId | null, model: row?.model ?? null }}
                            adapters={list.adapters}
                            onChange={async (c) => act(await chooseForAgent(workspaceId, agent, c), "Saved.")}
                          />
                        </li>
                      );
                    })}
                  </ul>
                </>
              )}
            </>
          );
        }}
      </QueryBoundary>
    </Section>
  );
}
