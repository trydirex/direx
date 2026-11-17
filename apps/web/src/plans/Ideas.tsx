// SPDX-License-Identifier: AGPL-3.0-only
// Ideas on Home: one line to put an idea down now, and Start a campaign to write it up later with the
// words already filled in. An Idea is not an Item, so it never counts in Needs you (GLOSSARY "Idea").
import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { Dialog, DialogHeader } from "@astryxdesign/core/Dialog";
import { inWorkspace } from "../api/query";
import { Notice } from "../components/layout";
import { Button } from "@/components/Button";
import { Input } from "@/components/Input";
import { addIdea, dismissIdea, ideasQuery, startedIdea, type Idea } from "./actions";
import { NewCampaign } from "./NewCampaign";

/** A Campaign name from an Idea: its first 80 characters, cut at a word where it can be. */
export const titleOf = (text: string) => {
  if (text.length <= 80) return text;
  const cut = text.slice(0, 80);
  const space = cut.lastIndexOf(" ");
  return (space > 40 ? cut.slice(0, space) : cut).trimEnd();
};

export function Ideas(p: { workspaceId: string; edit: boolean }) {
  const { workspaceId } = p;
  const client = useQueryClient();
  const query = useQuery(ideasQuery(workspaceId));
  const [text, setText] = useState("");
  const [error, setError] = useState<string>();
  const [pending, setPending] = useState(false);
  const [starting, setStarting] = useState<Idea>();
  const reload = () => client.invalidateQueries({ queryKey: inWorkspace(workspaceId, "ideas") });
  const open = query.data?.open ?? [];
  const started = query.data?.started ?? [];
  if (!p.edit && !open.length && !started.length) return null;

  return (
    <section aria-labelledby="ideas" className="flex flex-col gap-3">
      <h2 id="ideas">Ideas</h2>
      {error && <Notice tone="error">{error}</Notice>}
      {p.edit && (
        <form
          className="flex gap-2"
          onSubmit={async (e) => {
            e.preventDefault();
            const words = text.trim();
            if (!words) return;
            setPending(true);
            try {
              if (await addIdea(workspaceId, words)) {
                setText("");
                setError(undefined);
                await reload();
              } else setError("That idea wasn't saved. Try again.");
            } finally {
              setPending(false);
            }
          }}
        >
          <Input aria-label="New idea" placeholder="Put an idea down to start a campaign from later" value={text} maxLength={500} onChange={(e) => setText(e.target.value)} className="min-w-0 flex-1" />
          <Button type="submit" variant="outline" pending={pending} disabled={!text.trim()}>
            Add
          </Button>
        </form>
      )}
      {open.length > 0 && (
        <ul aria-label="Open ideas" className="flex flex-col">
          {open.map((i) => (
            <li key={i.id} className="flex flex-wrap items-center justify-between gap-2 border-t border-border py-2">
              <span className="min-w-0 text-sm">{i.text}</span>
              {p.edit && (
                <span className="flex gap-2">
                  <Button size="sm" variant="outline" onClick={() => setStarting(i)}>
                    Start a campaign
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    aria-label={`Dismiss ${i.text}`}
                    onClick={async () => {
                      if (await dismissIdea(workspaceId, i.id)) await reload();
                      else setError("That idea wasn't dismissed. Try again.");
                    }}
                  >
                    Dismiss
                  </Button>
                </span>
              )}
            </li>
          ))}
        </ul>
      )}
      {started.length > 0 && (
        <ul aria-label="Started ideas" className="flex flex-col gap-1 text-sm text-muted-foreground">
          {started.map((i) => (
            <li key={i.id}>
              {i.text}: became{" "}
              {/* The plan's link leads to its Campaign (ADR 0023 rule 004). */}
              <Link to="/w/$workspaceId/plans/$planId" params={{ workspaceId, planId: i.planId }}>
                {i.planTitle}
              </Link>
            </li>
          ))}
        </ul>
      )}
      <Dialog isOpen={Boolean(starting)} onOpenChange={(o) => !o && setStarting(undefined)} purpose="form" width={448}>
        <DialogHeader title="Start a campaign" />
        {starting && (
          <NewCampaign
            workspaceId={workspaceId}
            prefill={{ title: titleOf(starting.text), request: starting.text }}
            onCancel={() => setStarting(undefined)}
            onCreated={async (planId) => {
              // A failed link leaves the Campaign made and this Idea open, so nothing is lost.
              await startedIdea(workspaceId, starting.id, planId);
              await reload();
            }}
          />
        )}
      </Dialog>
    </section>
  );
}
