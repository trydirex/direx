// SPDX-License-Identifier: AGPL-3.0-only
// An Owner deletes the Workspace (ADR 0030 rules 007 and 008, Q3). The dialog says what happens first,
// and the Workspace's name is typed to confirm, as nothing undoes a delete.
import { useState } from "react";
import { Dialog, DialogHeader } from "@astryxdesign/core/Dialog";
import { Button } from "@/components/Button";
import { Input } from "@/components/Input";
import { Notice, Section } from "../components/layout";
import { deleteWorkspace } from "./actions";

/** What deleting does, in the order it happens. */
export const DELETE_SAYS = [
  "Sending stops now. Anything not yet sent is cancelled.",
  "Members lose access now. Owners can still export its data until it is purged, no sooner than 30 days from now.",
  "After the purge, Direx keeps no record of what was sent or of consent. Keep your export for at least 6 years.",
];

/** `onStepUp` when the sign-in is too old to delete; `onDeleted` once it is deleted. */
export function DeleteWorkspace(p: { workspaceId: string; name: string; onStepUp: () => void; onDeleted: () => void }) {
  const [open, setOpen] = useState(false);
  const [typed, setTyped] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string>();
  const close = () => {
    setOpen(false);
    setTyped("");
    setError(undefined);
  };
  const go = async () => {
    setPending(true);
    const code = await deleteWorkspace(p.workspaceId).finally(() => setPending(false));
    if (code === "step_up_required") return p.onStepUp();
    if (code) return setError("The Workspace could not be deleted. Try again.");
    p.onDeleted();
  };

  return (
    <Section title="Delete this Workspace" description="Stops all sending and closes it for every member. Owners can export its data until it is purged.">
      <div>
        <Button variant="outline" className="text-destructive" onClick={() => setOpen(true)}>
          Delete Workspace
        </Button>
      </div>
      <Dialog isOpen={open} onOpenChange={(o) => (o ? setOpen(true) : close())} purpose="form" width={448}>
        <DialogHeader title={`Delete ${p.name}?`} />
        <form
          className="flex flex-col gap-4"
          onSubmit={(e) => {
            e.preventDefault();
            void go();
          }}
        >
          <ul className="flex list-disc flex-col gap-2 pl-5 text-sm">
            {DELETE_SAYS.map((s) => (
              <li key={s}>{s}</li>
            ))}
          </ul>
          <Input label={`Type ${p.name} to confirm`} autoComplete="off" spellCheck={false} value={typed} onChange={(e) => setTyped(e.target.value)} />
          {error && <Notice tone="error">{error}</Notice>}
          <div className="flex justify-end gap-2">
            <Button type="button" variant="outline" onClick={close}>
              Cancel
            </Button>
            <Button type="submit" variant="destructive" pending={pending} disabled={typed.trim() !== p.name.trim()}>
              Delete Workspace
            </Button>
          </div>
        </form>
      </Dialog>
    </Section>
  );
}
