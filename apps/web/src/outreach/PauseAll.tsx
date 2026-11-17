// SPDX-License-Identifier: AGPL-3.0-only
import { useEffect, useState } from "react";
import { Confirm } from "../components/Confirm";
import { Button } from "@/components/Button";
import { Skeleton } from "@astryxdesign/core/Skeleton";
import { toast } from "@/components/toast";
import { overview, setPaused } from "./actions";

/** The emergency pause, on every screen. It holds what is queued; each Item is resumed by a person. */
export function PauseAll(p: { workspaceId: string; paused?: boolean; onChange?: (paused: boolean) => void }) {
  const [paused, set] = useState(p.paused);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string>();
  useEffect(() => {
    if (p.paused !== undefined) {
      set(p.paused);
      return;
    }
    void overview(p.workspaceId).then((o) => {
      // Unread, it still offers the pause: pausing twice is harmless, and an emergency can't wait on a read.
      if (!o) setError("Couldn't read whether sending is paused.");
      set(o?.paused ?? false);
    });
  }, [p.workspaceId, p.paused]);
  if (paused === undefined) return <Skeleton aria-label="Loading the pause" className="h-11 w-44 rounded-control" />;
  const flip = async () => {
    setPending(true);
    setError(undefined);
    const failed = await setPaused(p.workspaceId, !paused);
    setPending(false);
    if (failed) setError(paused ? "Sending is still paused. Try again." : "Sending was not paused. Try again.");
    else {
      set(!paused);
      p.onChange?.(!paused);
      // A stray press is undone from the toast with no second question. Holds are made at send time, so
      // undoing straight away leaves nothing held; anything held in between still waits for a person.
      if (!paused) toast.add({ title: "Sending paused.", description: "Nothing goes out until it's turned back on.", actionProps: { children: "Undo", onClick: () => void undo() } });
    }
  };
  const undo = async () => {
    if (await setPaused(p.workspaceId, false)) return setError("Sending is still paused. Try again.");
    set(false);
    p.onChange?.(false);
    toast.add({ title: "Sending is back on." });
  };
  // At rest the pause is a red outline, calm but findable; once paused, the label says so and the button turns solid.
  return (
    <div className="flex flex-wrap items-center justify-end gap-3">
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
      {/* Pausing is one press, as an emergency should be; turning sending back on asks first. */}
      {paused ? (
        <Confirm
          title="Turn sending back on?"
          body="Scheduled emails and posts can go out again. Anything that was held still waits for a person to resume it."
          confirm="Turn sending back on"
          onConfirm={flip}
          trigger={
            <Button disabled={pending} aria-busy={pending}>
              Sending is paused. Turn sending back on
            </Button>
          }
        />
      ) : (
        <Button variant="outline" className="text-destructive" disabled={pending} aria-busy={pending} onClick={() => void flip()}>
          Pause all sending
        </Button>
      )}
    </div>
  );
}
