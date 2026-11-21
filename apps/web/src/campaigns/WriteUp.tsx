// SPDX-License-Identifier: AGPL-3.0-only
// The write-up on an Ended Campaign's Overview: what happened, the numbers it rests on with where each came
// from, and up to three suggested assumptions for the Strategy. Also the body of the Item that adds them.
import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { Button, Key } from "@/components/Button";
import { Textarea } from "@/components/Input";
import { Field, Notice } from "../components/layout";
import { approve, itemQuery, message, type Item } from "../items/actions";
import { dayWords, say, writeAgain, writeUpQuery, type Loaded, type WriteUp as Data } from "./actions";

/** Why Direx couldn't write it up, from the coded failure. */
const FAILED: [prefix: string, why: string][] = [
  ["number_not_in_brief", "its draft used a number it wasn't given"],
  ["credit", "its draft gave the Campaign credit for a result, which the numbers can't show"],
  ["winner_without_comparison", "its draft called one channel better without enough to compare"],
  ["unknown_reading", "its draft cited a number Direx doesn't have"],
  ["reading_id_in_text", "its draft showed reference codes instead of words"],
  ["suggestion_without_reading", "its draft suggested an assumption without a number behind it"],
  ["repeats_assumption", "its draft suggested an assumption your Strategy already has"],
  ["too_long", "its draft was too long"],
  ["too_many_suggestions", "its draft suggested more than three assumptions"],
];
export function failureWords(failure: string | null) {
  if (failure?.startsWith("not_started")) return "Direx couldn't start writing this up.";
  const why = FAILED.find(([prefix]) => failure === prefix || failure?.startsWith(`${prefix}:`))?.[1];
  return why ? `Direx couldn't write this up: ${why}.` : "Direx couldn't write this up.";
}

const WRITE_UP_MESSAGES: Record<string, string> = { not_ended: "This Campaign hasn't ended, so it can't be written up again yet." };

/** The write-up card, above "By step". Silent on a Campaign that hasn't Ended, and until it reads. */
export function WriteUp(p: { workspaceId: string; campaign: Pick<Loaded, "id" | "status">; edit: boolean }) {
  const ended = p.campaign.status === "ended";
  const client = useQueryClient();
  const query = writeUpQuery(p.workspaceId, p.campaign.id);
  const { data: w, isSuccess } = useQuery({ ...query, enabled: ended });
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string>();
  if (!ended || !isSuccess) return null;

  async function again() {
    setPending(true);
    setError(undefined);
    try {
      const failed = await writeAgain(p.workspaceId, p.campaign.id);
      // Already being written, by someone else's click or the morning's run: show that, quietly.
      if (failed && failed !== "writing") setError(WRITE_UP_MESSAGES[failed] ?? say(failed));
    } catch {
      setError("Couldn't confirm that writing started. Try again if it's still available.");
    } finally {
      // The server may have started writing before the response was lost.
      try {
        await client.invalidateQueries({ queryKey: query.queryKey });
      } finally {
        setPending(false);
      }
    }
  }
  const offerAgain = p.edit && (w?.status === "failed" || (w?.status === "written" && w.corrected));
  const open = w?.suggestions.some((s) => !s.outcome) && w.itemId;
  return (
    <section aria-labelledby="write-up" className="flex flex-col gap-3 rounded-card border border-border bg-card p-6">
      <h2 id="write-up" className="font-sans text-sm font-semibold">
        Write-up
      </h2>
      {!w && <p className="text-sm text-muted-foreground">Direx writes this up once every step is settled.</p>}
      {w?.status === "writing" && <p role="status" className="text-sm text-muted-foreground">Writing the write-up…</p>}
      {w?.status === "failed" && <p>{failureWords(w.failure)}</p>}
      {w?.status === "written" && w.corrected && <p>A number here was corrected after this was written.</p>}
      {offerAgain && (
        <Button size="sm" variant="outline" className="self-start" pending={pending} onClick={() => void again()}>
          Write it again
        </Button>
      )}
      {error && <Notice tone="error">{error}</Notice>}
      {/* A failed or repeated run keeps the last write-up that passed. */}
      {w?.paragraph && (
        <>
          <p>{w.paragraph}</p>
          {w.cites.length > 0 && (
            <>
              <h3 className="font-sans text-sm font-medium">Based on</h3>
              <ul className="flex flex-col gap-1.5 text-sm">
                {w.cites.map((c) => (
                  <li key={c.readingId} className="flex flex-col">
                    <span>{`${c.label}: ${c.value}`}</span>
                    <small className="text-xs text-muted-foreground">{`As of ${dayWords(c.observedOn)}, ${c.source === "person" ? "entered by a person" : "counted by Direx"}`}</small>
                    {c.now && <small className="text-xs font-medium">{`Corrected since: now ${c.now.value}, as of ${dayWords(c.now.observedOn)}`}</small>}
                  </li>
                ))}
              </ul>
            </>
          )}
          {w.suggestions.length > 0 && (
            <>
              <h3 className="font-sans text-sm font-medium">Suggested for your Strategy</h3>
              <ul className="flex flex-col gap-3 text-sm">
                {w.suggestions.map((s) => (
                  <li key={s.assumption} className="flex flex-col gap-0.5">
                    <span>{s.assumption}</span>
                    <span className="text-muted-foreground">{s.because}</span>
                    {s.outcome && <span className="text-xs text-muted-foreground">{s.outcome === "added" ? "Added to the Strategy" : "Not added"}</span>}
                  </li>
                ))}
              </ul>
              {open && (
                <Link className="self-start text-sm" to="/w/$workspaceId/review/$itemId" params={{ workspaceId: p.workspaceId, itemId: open }}>
                  Choose which to add in Review
                </Link>
              )}
            </>
          )}
        </>
      )}
    </section>
  );
}

type Suggestion = Data["suggestions"][number];
const MAX_TEXT = 400;

/**
 * The suggestions Item's body: each suggestion ticked to begin with, its text editable, and its because
 * line. Approve adds the ticked ones, as edited, to the Strategy. Read-only once decided or for a role
 * that can't approve.
 */
export function AssumptionsChoice(p: { workspaceId: string; item: Pick<Item, "id" | "revision" | "state">; suggestions: Suggestion[]; approve: boolean; onDone: () => void; keys?: boolean }) {
  const client = useQueryClient();
  const [ticked, setTicked] = useState(() => p.suggestions.map(() => true));
  const [texts, setTexts] = useState(() => p.suggestions.map((s) => s.assumption));
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string>();
  const deciding = p.approve && p.item.state === "needs_approval";
  const chosen = texts.map((t) => t.trim()).filter((_, n) => ticked[n]);
  // The button counts only what it would add: a ticked suggestion with no text, or too much, isn't one.
  const usable = chosen.filter((t) => t && t.length <= MAX_TEXT).length;
  const why = !chosen.length ? "Tick at least one suggestion." : chosen.some((t) => !t) ? "A ticked suggestion needs some text." : chosen.some((t) => t.length > MAX_TEXT) ? `Keep each suggestion to ${MAX_TEXT} characters.` : null;

  async function add() {
    // Each ticked one by its place, with its text only when the person changed it.
    const add = ticked.flatMap((on, index) => (on ? [texts[index]!.trim() === p.suggestions[index]!.assumption ? { index } : { index, text: texts[index]!.trim() }] : []));
    setPending(true);
    setError(undefined);
    try {
      const failed = await approve(p.workspaceId, p.item, JSON.stringify({ add }));
      if (failed) setError(failed === "choice_required" ? "Tick at least one suggestion." : message(failed));
      else p.onDone();
    } catch {
      setError("Couldn't confirm that the suggestions were added. Try again if they're still open.");
      await client.invalidateQueries({ queryKey: itemQuery(p.workspaceId, p.item.id).queryKey });
    } finally {
      setPending(false);
    }
  }

  if (!deciding)
    return (
      <ul className="flex flex-col gap-3">
        {p.suggestions.map((s) => (
          <li key={s.assumption} className="flex flex-col gap-0.5">
            <span>{s.assumption}</span>
            <span className="text-sm text-muted-foreground">{s.because}</span>
          </li>
        ))}
      </ul>
    );
  return (
    <div className="flex flex-col gap-4">
      <ul className="flex flex-col gap-5">
        {p.suggestions.map((s, n) => (
          <li key={s.assumption} className="flex flex-col gap-2">
            <label className="flex items-center gap-2 text-sm font-medium">
              <input type="checkbox" className="size-4 accent-primary" checked={ticked[n]} onChange={(e) => setTicked(ticked.map((t, m) => (m === n ? e.target.checked : t)))} />
              {`Add suggestion ${n + 1}`}
            </label>
            <Field label={`Suggestion ${n + 1}`}>
              <Textarea value={texts[n]} rows={2} maxLength={MAX_TEXT} disabled={!ticked[n]} onChange={(e) => setTexts(texts.map((t, m) => (m === n ? e.target.value : t)))} />
            </Field>
            <span className="text-sm text-muted-foreground">{s.because}</span>
          </li>
        ))}
      </ul>
      {error && <Notice tone="error">{error}</Notice>}
      <div className="flex flex-wrap items-center gap-3">
        {/* In Review, A presses this, as it does each kind's approve button. */}
        <Button pending={pending} disabled={!!why} aria-describedby={why ? "assumptions-why" : undefined} aria-keyshortcuts={p.keys ? "A" : undefined} onClick={() => void add()}>
          {usable ? `Add ${usable} to the Strategy` : "Add to the Strategy"}
          {p.keys && <Key>A</Key>}
        </Button>
        {why && (
          <span id="assumptions-why" className="text-sm text-muted-foreground">
            {why}
          </span>
        )}
      </div>
    </div>
  );
}
