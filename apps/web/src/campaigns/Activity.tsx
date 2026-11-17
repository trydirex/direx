// SPDX-License-Identifier: AGPL-3.0-only
import { useState, type ReactNode } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { inWorkspace } from "../api/query";
import { Button } from "@/components/Button";
import { toast } from "@/components/toast";
import { ago } from "@/lib/ago";
import { activityQuery, dayWords, moveEffect, moveLaunch, say, type AnchorMove } from "./actions";

type Event = { at: string; text: string; by: "person" | "direx"; undo: { kind: "launch"; on: string } | null };

/** Undo for the latest launch move: what moving back would do first, then the move. */
function UndoLaunch(p: { workspaceId: string; id: string; on: string }) {
  const client = useQueryClient();
  const [preview, setPreview] = useState<AnchorMove>();
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const run = async (dry: boolean) => {
    setBusy(true);
    try {
      const r = await moveLaunch(p.workspaceId, p.id, p.on, dry);
      setError("error" in r ? say(r.error) : undefined);
      if ("error" in r) return;
      if (dry) return setPreview(r);
      setPreview(undefined);
      toast.add({ title: `Launch moved back to ${dayWords(p.on)}.` });
      await client.invalidateQueries({ queryKey: inWorkspace(p.workspaceId) });
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="flex flex-col items-start gap-1 pt-1">
      {!preview && (
        <Button size="sm" variant="outline" pending={busy} aria-label={`Undo: move the launch back to ${dayWords(p.on)}`} onClick={() => void run(true)}>
          Undo
        </Button>
      )}
      {error && <p className="text-xs">{error}</p>}
      {preview && (
        <div role="status" className="flex flex-col items-start gap-1 rounded-card bg-muted p-2 text-xs">
          <p>
            Back to {dayWords(p.on)}. {moveEffect(preview)}
          </p>
          <div className="flex gap-1">
            <Button size="sm" pending={busy} onClick={() => void run(false)}>
              Move it back
            </Button>
            <Button size="sm" variant="outline" onClick={() => setPreview(undefined)}>
              Keep it
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}

/** What Direx did for one Campaign, newest first; an editor can undo the line that allows it. A side note: silent when it can't be read. `limit` shows only the newest, with `more` below them. */
export function Activity(p: { workspaceId: string; id: string; edit?: boolean; initial?: Event[]; limit?: number; more?: ReactNode }) {
  const events = useQuery({ ...activityQuery(p.workspaceId, p.id), initialData: p.initial }).data;
  if (!events?.length) return null;
  return (
    <aside aria-labelledby="what-direx-did" className="flex flex-col gap-3 self-start rounded-card border border-border bg-card p-4">
      <h2 id="what-direx-did" className="font-sans text-sm font-semibold">
        What Direx did
      </h2>
      <ol className="flex flex-col gap-3">
        {events.slice(0, p.limit).map((e, n) => (
          <li key={n} className="flex gap-2 text-sm">
            <span aria-hidden className={n === 0 ? "mt-1.5 size-2 shrink-0 rounded-full bg-primary" : "mt-1.5 size-2 shrink-0 rounded-full bg-muted"} />
            <div className="flex flex-col">
              <span>{e.text}</span>
              <span className="text-xs text-muted-foreground">
                <time dateTime={e.at}>{ago(e.at)}</time>
                {e.by === "person" && " · by a person"}
              </span>
              {e.undo && p.edit && <UndoLaunch workspaceId={p.workspaceId} id={p.id} on={e.undo.on} />}
            </div>
          </li>
        ))}
      </ol>
      {p.more}
    </aside>
  );
}
