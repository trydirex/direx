// SPDX-License-Identifier: AGPL-3.0-only
// A plan changed while its Campaign runs: what approving the draft would do, and the choice on each
// step it held. The step keeps its own text until a person picks the plan's.
import { useEffect, useState } from "react";
import { Notice } from "../components/layout";
import { Button } from "@/components/Button";
import { useAction } from "../components/useAction";
import { approve, detail, message, STATE_LABEL } from "../items/actions";
import { getCampaign, listCampaigns, planImpact, type Impact } from "./actions";

type Text = { subject: string; text: string };
type Kind = "text" | "channel" | "removed";
type Choice = "keep" | "use_new_text" | "cancel";
type DiffLine = { kind: "same" | "removed" | "added"; line: string };

/** Lines of `a` and `b`, the ones both keep in order and the rest marked removed or added. */
export function lineDiff(a: string, b: string): DiffLine[] {
  const x = a.split("\n");
  const y = b.split("\n");
  // ponytail: quadratic table; fine for an email, a real diff library if steps grow to pages.
  const lcs = x.map(() => new Array<number>(y.length + 1).fill(0));
  lcs.push(new Array<number>(y.length + 1).fill(0));
  for (let i = x.length - 1; i >= 0; i--) for (let j = y.length - 1; j >= 0; j--) lcs[i]![j] = x[i] === y[j] ? lcs[i + 1]![j + 1]! + 1 : Math.max(lcs[i + 1]![j]!, lcs[i]![j + 1]!);
  const out: DiffLine[] = [];
  let i = 0;
  let j = 0;
  while (i < x.length && j < y.length) {
    if (x[i] === y[j]) {
      out.push({ kind: "same", line: x[i]! });
      i++;
      j++;
    } else if (lcs[i + 1]![j]! >= lcs[i]![j + 1]!) out.push({ kind: "removed", line: x[i++]! });
    else out.push({ kind: "added", line: y[j++]! });
  }
  return [...out, ...x.slice(i).map((line) => ({ kind: "removed" as const, line })), ...y.slice(j).map((line) => ({ kind: "added" as const, line }))];
}

const both = (t: Text) => `Subject: ${t.subject}\n${t.text}`;
const emails = (n: number) => `${n} email${n === 1 ? "" : "s"}`;

/**
 * The three answers to a held step. Keep lets its emails go as approved, the new text revises them
 * and asks for approval again, cancel ends the step. `expired` is read from the Campaign when not given.
 */
export function PlanChangeChoice(p: { workspaceId: string; campaignId: string; stepKey: string; itemId: string; kinds: Kind[]; current?: Text | null; suggested?: Text | null; expired?: number; edit: boolean; onDone: () => void }) {
  const [expired, setExpired] = useState(p.expired);
  const [error, setError] = useState<string>();
  const choosing = useAction();
  const [chosen, setChosen] = useState<Choice>();
  useEffect(() => {
    if (p.expired !== undefined) return setExpired(p.expired);
    void getCampaign(p.workspaceId, p.campaignId).then((c) => setExpired(c?.steps.find((s) => s.key === p.stepKey)?.planChange?.expired));
  }, [p.workspaceId, p.campaignId, p.stepKey, p.expired]);

  function choose(choice: Choice) {
    setChosen(choice);
    return choosing.run(async () => {
      try {
        const item = (await detail(p.workspaceId, p.itemId))?.item;
        const failed = item ? await approve(p.workspaceId, item, choice) : "not_found";
        setError(failed ? message(failed) : undefined);
        if (!failed) p.onDone();
      } catch {
        // The answer may have arrived before the connection dropped; reloading shows which.
        setError("Direx couldn't be reached. Reload to see whether your choice was saved.");
      }
      return null;
    });
  }
  // Only the pressed button says it is busy; the other two wait without a second answer.
  const busy = (choice: Choice) => ({ pending: choosing.pending && chosen === choice, disabled: choosing.pending });
  const removed = p.kinds.includes("removed");
  const keep = removed ? "Finish what's scheduled" : p.kinds.includes("text") ? "Keep the current text" : "Keep the step as it is";
  return (
    <div className="flex flex-col gap-3">
      {error && <Notice tone="error">{error}</Notice>}
      {p.current && p.suggested && (
        <pre aria-label="Current text against the plan's new text" className="whitespace-pre-wrap rounded-card bg-muted p-4 font-sans">
          {lineDiff(both(p.current), both(p.suggested)).map((l, n) => (
            <div key={n}>{l.kind === "removed" ? <del>{l.line}</del> : l.kind === "added" ? <ins>{l.line}</ins> : l.line}</div>
          ))}
        </pre>
      )}
      {p.kinds.includes("channel") && <p>The plan moved this step to another channel, so its emails were written for the old one.</p>}
      {expired ? <p role="status" className="text-muted-foreground">{`${emails(expired)} will move to the next free slots if you keep them: their time passed while they waited.`}</p> : null}
      {p.edit && (
        <div className="flex flex-wrap gap-2">
          <Button type="button" size="sm" variant="outline" {...busy("keep")} onClick={() => void choose("keep")}>{keep}</Button>
          {p.kinds.includes("text") && <Button type="button" size="sm" {...busy("use_new_text")} onClick={() => void choose("use_new_text")}>Use the new text</Button>}
          <Button type="button" size="sm" variant="outline" {...busy("cancel")} onClick={() => void choose("cancel")}>Cancel the step</Button>
        </div>
      )}
    </div>
  );
}

const OPEN: readonly string[] = ["draft", "needs_approval", "scheduled", "held"];
const days = (n: number) => `${Math.abs(n)} day${Math.abs(n) === 1 ? "" : "s"} ${n > 0 ? "later" : "earlier"}`;
const PLAN_WORDS: Record<string, string> = {
  goal: "Goal changed",
  audience: "Who it's for changed: check who's in this Campaign",
  measures: "Measures changed",
  budget: "Budget changed",
  assumptions: "Assumptions changed",
};
function stepLine(c: Impact["diff"]["steps"][number], titles: Impact["titles"]) {
  const name = titles[c.key] ?? c.key;
  if (c.kind !== "changed") return `${name}: ${c.kind}`;
  const parts = [c.text && "text suggested", c.channel && "channel changed", c.redatedDays !== 0 && days(c.redatedDays), c.retitled && "retitled"].filter(Boolean);
  return `${name}: ${parts.join(", ")}`;
}

/** What approving the plan's saved draft would do to its Campaign. Nothing when it changes nothing. */
export function PlanImpact(p: { workspaceId: string; planId: string; refresh: unknown; initial?: { campaignId: string; impact: Impact } }) {
  const [impact, setImpact] = useState(p.initial?.impact);
  useEffect(() => {
    if (p.initial) return;
    void (async () => {
      const campaign = (await listCampaigns(p.workspaceId)).find((c) => c.planId === p.planId);
      setImpact(campaign ? await planImpact(p.workspaceId, campaign.id) : undefined);
    })();
  }, [p.workspaceId, p.planId, p.refresh]);
  if (!impact || (!impact.diff.steps.length && !impact.diff.plan.length)) return null;
  const totals = new Map<string, number>();
  for (const a of impact.affected) for (const [state, n] of Object.entries(a.counts)) if (OPEN.includes(state)) totals.set(state, (totals.get(state) ?? 0) + n);
  const total = [...totals.values()].reduce((a, b) => a + b, 0);
  const counted = [...totals].map(([state, n]) => `${STATE_LABEL[state as keyof typeof STATE_LABEL] ?? state}: ${n}`).join(", ");
  const steps = `${impact.affected.length} step${impact.affected.length === 1 ? "" : "s"}`;
  return (
    <section aria-label="What this change does to the Campaign" className="flex flex-col gap-2">
      {impact.affected.length > 0 && <p role="status" className="rounded-card bg-muted px-4 py-3">{`Affects ${steps}${total ? ` and ${total} unsent email${total === 1 ? "" : "s"} (${counted})` : ""}. They wait until you choose for each step.`}</p>}
      <ul className="flex list-disc flex-col gap-1 pl-5 text-sm">
        {impact.diff.steps.map((c) => (
          <li key={c.key}>{stepLine(c, impact.titles)}</li>
        ))}
        {impact.diff.plan.map((f) => (
          <li key={f}>{PLAN_WORDS[f]}</li>
        ))}
      </ul>
    </section>
  );
}
