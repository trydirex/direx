// SPDX-License-Identifier: AGPL-3.0-only
// What to say when a call fails. Codes that mean the same on every screen live here once; a screen
// passes only its own codes, which win.
import { ApiError } from "./query";

const COMMON: Record<string, string> = {
  forbidden: "Your role doesn't allow that.",
  not_found: "We couldn't find that. It may have been removed.",
  stale: "Someone else changed this just now. Reload and try again.",
  stale_version: "Someone changed this while you were editing. Reload and try again.",
  step_up_required: "This needs a sign-in from the last 10 minutes. Sign out and back in, then try again.",
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
