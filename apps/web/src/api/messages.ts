// SPDX-License-Identifier: AGPL-3.0-only
// What to say when a call fails. Codes that mean the same on every screen live here once; a screen
// passes only its own codes, which win.
import { ApiError } from "./query";

const COMMON: Record<string, string> = {
  forbidden: "Your role doesn't allow that.",
  not_found: "We couldn't find that. It may have been removed.",
  stale: "Someone else changed this just now. Reload and try again.",
  stale_version: "Someone changed this while you were editing. Reload and try again.",
  step_up_required: "This needs a recent sign-in. Sign in again, then try once more.",
  failed: "That didn't work. Try again.",
};
const OFFLINE = "Direx couldn't be reached. Check your connection and try again.";

/** For actions that return the API's error code rather than throwing. */
export const messageForCode = (code: string, local: Record<string, string> = {}) => local[code] ?? COMMON[code] ?? COMMON.failed!;

export function messageFor(error: unknown, local: Record<string, string> = {}): string {
  if (error instanceof ApiError) {
    // A proxy in front of Direx answers 502 to 504 when Direx itself is down or restarting.
    if (error.code === "failed" && error.status >= 502 && error.status <= 504) return OFFLINE;
    return messageForCode(error.code, local);
  }
  // fetch rejects with a TypeError when the server can't be reached at all.
  if (error instanceof TypeError) return OFFLINE;
  return COMMON.failed!;
}

// A step_up_required answer on a screen with no sign-in of its own opens the shell's "Confirm it's you"
// (ADR 0037 rule 005). The hook lives here, not in identity/ConfirmIdentity, so the actions the first
// page loads don't pull its Dialog and sign-in into that bundle.
let openConfirm: (() => void) | undefined;

/** Hands `code` back unchanged, and opens "Confirm it's you" when it is step_up_required. */
export function confirmOnStepUp<T extends string | null>(code: T): T {
  if (code === "step_up_required") openConfirm?.();
  return code;
}

/** Registers what opens "Confirm it's you"; the returned function unregisters it. */
export function onStepUp(show: () => void): () => void {
  openConfirm = show;
  return () => {
    if (openConfirm === show) openConfirm = undefined;
  };
}
