// SPDX-License-Identifier: AGPL-3.0-only
// Brand's Voice (ADR 0022): passages that sound like the business and word swaps, kept apart from the
// facts so they shape how drafts sound, never what they claim. Anyone in the Workspace reads it; saving
// and retiring need someone who may approve. Pasting stays closed until the voice check has passed its eval.
import { useState, type FormEvent } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { inWorkspace } from "../api/query";
import { Confirm } from "../components/Confirm";
import { Field, Notice, Section } from "../components/layout";
import { QueryBoundary } from "../components/QueryBoundary";
import { useAction } from "../components/useAction";
import { Button } from "@/components/Button";
import { Input, Textarea } from "@/components/Input";
import { Skeleton } from "@astryxdesign/core/Skeleton";
import { mayApprove, type Role } from "../items/actions";
import { addExample, addSwap, retireVoice, voiceQuery, type VoiceEntry } from "./actions";

const WORDS: Record<string, string> = {
  voice_empty: "Write something first.",
  voice_too_long: "That's too long. An example takes up to 600 characters, and each word of a swap up to 40.",
  voice_has_email: "Take out the email address first. Voice can't hold anyone's contact details.",
  voice_has_phone: "Take out the phone number first. Voice can't hold anyone's contact details.",
  voice_examples_full: "Voice holds five examples. Remove one to add another.",
  voice_swaps_full: "Voice holds 30 swaps. Remove one to add another.",
  voice_swap_same: "The two words are the same.",
  voice_swap_exists: "That word already has a swap.",
  voice_check_refused: "This reads like instructions to an AI rather than writing for people, so it can't be an example.",
  voice_check_unavailable: "Direx couldn't run its check just now. Try again in a minute.",
  voice_check_no_model: "Direx checks each example with Claude Code first. Sign in to Claude Code under Settings, AI models, then add it again.",
  voice_check_closed: "Pasting examples is coming soon. Use 'Say this, not that' for now.",
};

export function Voice(p: { workspaceId: string; role: Role; initial?: { entries: VoiceEntry[]; pasteOpen: boolean } }) {
  const client = useQueryClient();
  const query = useQuery({ ...voiceQuery(p.workspaceId), initialData: p.initial });
  const action = useAction(WORDS);
  const [passage, setPassage] = useState("");
  const [avoid, setAvoid] = useState("");
  const [prefer, setPrefer] = useState("");
  const decide = mayApprove(p.role);

  async function run(write: () => Promise<string | null>, say: string, clear: () => void) {
    const code = await action.run(write, { say });
    if (!code) clear();
    await client.invalidateQueries({ queryKey: inWorkspace(p.workspaceId, "voice") });
  }
  const paste = (e: FormEvent) => {
    e.preventDefault();
    void run(() => addExample(p.workspaceId, passage), "Example added.", () => setPassage(""));
  };
  const swap = (e: FormEvent) => {
    e.preventDefault();
    void run(() => addSwap(p.workspaceId, avoid, prefer), "Swap added.", () => (setAvoid(""), setPrefer("")));
  };
  const retireButton = (e: VoiceEntry, name: string) =>
    decide && (
      <Confirm
        title={`Remove ${name}?`}
        body="Drafts written from now on stop using it."
        confirm="Remove"
        onConfirm={() => void run(() => retireVoice(p.workspaceId, e.id), "Removed.", () => undefined)}
        trigger={
          <Button size="sm" variant="outline" aria-label={`Remove ${name}`}>
            Remove
          </Button>
        }
      />
    );

  return (
    <Section title="Voice" description="How drafts should sound. Voice shapes the writing; it never counts as proof for anything a draft says.">
      {action.error && <Notice tone="error">{action.error}</Notice>}
      <QueryBoundary query={query} skeleton={<Skeleton className="h-40 w-full" />}>
        {({ entries, pasteOpen }) => {
          const examples = entries.filter((e) => e.kind === "example");
          const swaps = entries.filter((e) => e.kind === "swap");
          return (
            <div className="grid gap-6 lg:grid-cols-2">
              <section aria-label="Sounds like us" className="flex flex-col gap-3">
                <h3 className="font-medium">Sounds like us</h3>
                {examples.length === 0 && <p className="text-sm text-muted-foreground">No examples yet. Paste a post or an email that sounds like you.</p>}
                {examples.map((e, n) => (
                  <div key={e.id} className="flex flex-col gap-2 border-t border-border pt-3 first:border-t-0 first:pt-0">
                    <blockquote className="whitespace-pre-wrap">{e.text}</blockquote>
                    <div>{retireButton(e, `example ${n + 1}`)}</div>
                  </div>
                ))}
                {/* Until pasting opens it says so in a line, with no greyed-out box to try. */}
                {decide && !pasteOpen && <p className="text-sm text-muted-foreground">{WORDS.voice_check_closed}</p>}
                {decide && pasteOpen && (
                  <form onSubmit={paste} className="flex flex-col gap-2">
                    <Field label="Paste a passage that sounds like you" hint="Up to 600 characters, with no email addresses or phone numbers.">
                      <Textarea value={passage} onChange={(e) => setPassage(e.target.value)} maxLength={600} rows={4} />
                    </Field>
                    <Button type="submit" size="sm" className="self-start" pending={action.pending} disabled={!passage.trim()}>
                      Add example
                    </Button>
                  </form>
                )}
              </section>
              <section aria-label="Say this, not that" className="flex flex-col gap-3">
                <h3 className="font-medium">Say this, not that</h3>
                {swaps.length === 0 && <p className="text-sm text-muted-foreground">No swaps yet. A draft that uses a word you avoid gets a note naming yours.</p>}
                <ul className="flex flex-col gap-2">
                  {swaps.map((e) => (
                    <li key={e.id} className="flex flex-wrap items-center justify-between gap-2">
                      <span>
                        Say <strong>{e.prefer}</strong>, not {e.text}
                      </span>
                      {retireButton(e, `the swap for ${e.text}`)}
                    </li>
                  ))}
                </ul>
                {decide && (
                  <form onSubmit={swap} className="flex flex-wrap items-end gap-2">
                    <Field label="Instead of">
                      <Input value={avoid} onChange={(e) => setAvoid(e.target.value)} maxLength={40} />
                    </Field>
                    <Field label="Say">
                      <Input value={prefer} onChange={(e) => setPrefer(e.target.value)} maxLength={40} />
                    </Field>
                    <Button type="submit" size="sm" pending={action.pending} disabled={!avoid.trim() || !prefer.trim()}>
                      Add swap
                    </Button>
                  </form>
                )}
              </section>
            </div>
          );
        }}
      </QueryBoundary>
    </Section>
  );
}
