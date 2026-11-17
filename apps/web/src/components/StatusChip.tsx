// SPDX-License-Identifier: AGPL-3.0-only
import type { ReactNode } from "react";

export type Tone = "good" | "attention" | "broken" | "off";

const TONE: Record<Tone, string> = {
  good: "bg-success-tint text-success",
  attention: "bg-warning-tint text-warning",
  broken: "bg-destructive-tint text-destructive",
  off: "bg-muted text-muted-foreground",
};
/** A shape per tone, so the state reads without colour too: a dot, a ring, a diamond, a dash. */
const MARK: Record<Tone, string> = {
  good: "size-1.5 rounded-full bg-current",
  attention: "size-2 rounded-full border-2 border-current",
  broken: "size-1.5 rotate-45 bg-current",
  off: "h-0.5 w-2 bg-current",
};

/** Whether something Direx sends from, or relies on, works right now. One look on every Settings page. */
export function StatusChip(p: { tone: Tone; children: ReactNode }) {
  return (
    <span className={`inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-xs font-medium whitespace-nowrap ${TONE[p.tone]}`}>
      <span aria-hidden className={MARK[p.tone]} />
      {p.children}
    </span>
  );
}

/** A credential or account status, as the chip shows it. */
export const statusTone = (status: string): Tone => (status === "active" ? "good" : status === "needs_reauth" ? "broken" : "off");
