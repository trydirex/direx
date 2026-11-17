// SPDX-License-Identifier: AGPL-3.0-only
import { useState } from "react";
import { messageForCode } from "../api/messages";
import { toast } from "@/components/toast";

/** Said when a refusal's code has no words of its own. */
export const FALLBACK = messageForCode("failed");

/**
 * One write from a button: `pending` while it runs, its refusal as `error`, and on success an
 * optional short toast, with Undo when one is given. The action returns a refusal code, or null
 * when it worked. `words` is the screen's own table (the codes every screen shares are added), or
 * its own function from code to words.
 */
export function useAction(words: Record<string, string> | ((code: string) => string) = {}) {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string>();
  async function run(action: () => Promise<string | null>, done?: { say: string; undo?: () => unknown }) {
    setPending(true);
    setError(undefined);
    try {
      const code = await action();
      if (code) setError(typeof words === "function" ? words(code) : messageForCode(code, words));
      else if (done) toast.add({ title: done.say, ...(done.undo ? { actionProps: { children: "Undo", onClick: () => void done.undo!() } } : {}) });
      return code;
    } finally {
      setPending(false);
    }
  }
  return { run, pending, error, clear: () => setError(undefined) };
}
