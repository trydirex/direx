// SPDX-License-Identifier: AGPL-3.0-only
// A Mailbox's pause and ramp. Too many of its emails bouncing for good stops it, so does its provider
// refusing an email as abuse, and so can a person; only a person's resume starts it again, and what
// the pause held then goes through every check again. A new Mailbox's ramp grows after clean days
// and halves on any of those warnings, a person's pause aside.
import type { Ledger } from "../../ledger";
import { MAILBOX_PROBE, PLACEMENT_EFFECTS } from "../../plugins";
import { clearPause, halveRampOf, latestSends, pauseOf, pausedMailboxes, rampOf, setPause, setRamp } from "../adapters/pauses";
import { inWorkspace, type OutreachTx } from "../adapters/repo";
import { sweepRamp } from "../domain/ramp";
import { PAUSE_WINDOW, shouldPause } from "../domain/sending";

export const MAILBOX_PAUSED = "mailbox_paused";

/** Whether sends from this Mailbox are paused. */
export const mailboxPaused = async (tx: OutreachTx, credentialId: string | null): Promise<boolean> => Boolean(credentialId && (await pauseOf(tx, credentialId))?.pausedAt);

/** Called after a bounce is recorded: pauses the Mailbox when its sends since its last resume have bounced too much. */
export async function pauseOnBounces(tx: OutreachTx, credentialId: string, at: Date): Promise<void> {
  const state = await pauseOf(tx, credentialId);
  if (!state || state.pausedAt) return;
  if (!shouldPause(await latestSends(tx, credentialId, state.resumedAt, PAUSE_WINDOW))) return;
  await setPause(tx, credentialId, { reason: "bounces", by: null, at, resumedAt: state.resumedAt });
  await halveRampOf(tx, credentialId, at);
}

// Every effect that sends an email from a Mailbox.
const MAIL_EFFECTS: ReadonlySet<string> = new Set(["email.send", MAILBOX_PROBE, ...PLACEMENT_EFFECTS]);
export const isMailboxMailEffect = (capability: string): boolean => MAIL_EFFECTS.has(capability.slice(capability.lastIndexOf("/") + 1));

/**
 * The ledger's hook: a provider refusing a Mailbox's email as abuse pauses the Mailbox, in the same
 * transaction, however the email was approved. A sending limit only moves mail to a later day, so it
 * pauses nothing. Other effects pass through.
 */
export const pauseOnProviderAbuse =
  (deps: { now: () => Date }) =>
  async (rawTx: unknown, action: { capability: string; credentialId: string | null }, limit: "sending_limit" | "abuse"): Promise<void> => {
    if (limit !== "abuse" || !action.credentialId || !isMailboxMailEffect(action.capability)) return;
    const at = deps.now();
    await setPause(rawTx as OutreachTx, action.credentialId, { reason: "provider_abuse", by: null, at });
    await halveRampOf(rawTx as OutreachTx, action.credentialId, at);
  };

/** The ledger's hook: a provider saying a Mailbox's email is over its sending limit halves the Mailbox's ramp. */
export const slowOnSendingLimit =
  (deps: { now: () => Date }) =>
  async (rawTx: unknown, action: { capability: string; credentialId: string | null }, limit: "sending_limit" | "abuse"): Promise<void> => {
    if (limit !== "sending_limit" || !action.credentialId || !isMailboxMailEffect(action.capability)) return;
    await halveRampOf(rawTx as OutreachTx, action.credentialId, deps.now());
  };

/** The nightly sweep: each Mailbox on a ramp grows a step after clean days, or starts them again after a bounce. */
export async function sweepRamps(mailboxes: readonly { workspaceId: string; credentialId: string }[], now: Date): Promise<void> {
  for (const m of mailboxes) {
    await inWorkspace(m.workspaceId, async (tx) => {
      const state = await rampOf(tx, m.credentialId);
      if (!state) return;
      const next = sweepRamp(state, now);
      if (next.restart) await setRamp(tx, m.credentialId, next.ramp, now);
    });
  }
}

export function createMailboxPauses(deps: { ledger: () => Pick<Ledger, "resumeMailboxPaused">; now?: () => Date }) {
  const now = deps.now ?? (() => new Date());
  return {
    paused: (workspaceId: string) => inWorkspace(workspaceId, pausedMailboxes),

    /** Anyone who edits may pause; resuming lets mail go again, so it takes someone who approves. */
    async set(workspaceId: string, credentialId: string, paused: boolean, who: { userId: string; mayResume: boolean }): Promise<{ ok: true } | { ok: false; reason: "not_found" | "forbidden" }> {
      if (!paused && !who.mayResume) return { ok: false, reason: "forbidden" };
      const at = now();
      const found = await inWorkspace(workspaceId, async (tx) => {
        const state = await pauseOf(tx, credentialId);
        if (!state) return false;
        if (paused) await setPause(tx, credentialId, { reason: "person", by: who.userId, at });
        else if (state.pausedAt) await clearPause(tx, credentialId, at);
        return true;
      });
      if (!found) return { ok: false, reason: "not_found" };
      if (!paused) await deps.ledger().resumeMailboxPaused(workspaceId, credentialId, { userId: who.userId });
      return { ok: true };
    },
  };
}
export type MailboxPauses = ReturnType<typeof createMailboxPauses>;
