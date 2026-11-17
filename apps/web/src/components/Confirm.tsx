// SPDX-License-Identifier: AGPL-3.0-only
import { cloneElement, useState, type ReactElement, type ReactNode } from "react";
import { Button } from "@/components/Button";
import { Dialog, DialogHeader } from "@astryxdesign/core/Dialog";

/**
 * A button whose action is hard to undo: pressing it asks first, saying what will happen. The
 * trigger is the page's own button, so its label and name stay as they were.
 */
export function Confirm(p: { trigger: ReactElement<{ onClick?: () => void }>; title: string; body?: ReactNode; confirm: string; onConfirm: () => unknown }) {
  const [open, setOpen] = useState(false);
  const [pending, setPending] = useState(false);
  async function go() {
    setPending(true);
    try {
      await p.onConfirm();
    } finally {
      setPending(false);
      setOpen(false);
    }
  }
  return (
    <>
      {cloneElement(p.trigger, { onClick: () => setOpen(true) })}
      <Dialog isOpen={open} onOpenChange={setOpen} purpose="form" width={384}>
        <DialogHeader title={p.title} subtitle={p.body} />
        <div className="flex justify-end gap-2 pt-4">
          <Button variant="outline" onClick={() => setOpen(false)}>
            Cancel
          </Button>
          <Button pending={pending} onClick={() => void go()}>
            {p.confirm}
          </Button>
        </div>
      </Dialog>
    </>
  );
}
