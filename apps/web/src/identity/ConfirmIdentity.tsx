// SPDX-License-Identifier: AGPL-3.0-only
// "Confirm it's you" for a step_up_required answer on a screen with no sign-in of its own (ADR 0037
// rule 005). An action passes its error code through confirmOnStepUp; <ConfirmIdentity>, in the shell,
// opens the sign-in over the page. Signing in reloads the page (SignIn sends the browser to callbackURL)
// and the person presses the action again: nothing re-runs it for them.
import { useEffect, useState } from "react";
import { Dialog } from "@astryxdesign/core/Dialog";
import { Button } from "@/components/Button";
import { SignIn } from "./SignIn";
import { onStepUp } from "@/api/messages";

export function ConfirmIdentity() {
  const [isOpen, setOpen] = useState(false);
  useEffect(() => onStepUp(() => setOpen(true)), []);
  return (
    <Dialog isOpen={isOpen} onOpenChange={setOpen} purpose="form" width={448} aria-label="Confirm it's you">
      {isOpen && (
        <>
          <SignIn title="Confirm it's you" note="This needs a recent sign-in. Sign in again, then try once more." callbackURL={location.pathname + location.search} />
          <div className="flex justify-end">
            <Button type="button" variant="outline" onClick={() => setOpen(false)}>
              Close
            </Button>
          </div>
        </>
      )}
    </Dialog>
  );
}
