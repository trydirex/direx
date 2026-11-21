// SPDX-License-Identifier: AGPL-3.0-only
// The sending floors as a ledger check, run at claim and again at dispatch. Nothing here reads a
// setting that could turn a floor off.
import { storedSpec } from "@direx/plugin-sdk/host";
import type { SuppressionHasher } from "../../credentials";
import type { Check } from "../../ledger";
import { emailsOfGroup } from "../../people";
import { PLACEMENT_EFFECTS } from "../../plugins";
import { touchOf } from "../../schedule";
import { eligibilityOf, hashedOptOut, hashedOptOutsExist, hasOpenSignal, readSettings, subscribedAmong, suppressionReasons, type OutreachTx } from "../adapters/repo";
import { notEligible } from "../domain/eligibility";
import { mailboxHold } from "./header-check";
import { holdOf, holdResult } from "./holds";
import { MAILBOX_PAUSED, isMailboxMailEffect, mailboxPaused } from "./mailboxes";
import { subscriberHold } from "../domain/subscribers";

/** Whether replies to this Action's mailbox are being read. Required, so wiring can't leave it out. */
export type RepliesRead = (tx: OutreachTx, action: { capability: string; credentialId: string | null; workspaceId: string }) => Promise<boolean>;

const placementEffect = (capability: string) => PLACEMENT_EFFECTS.has(capability.slice(capability.lastIndexOf("/") + 1));
// Every placement effect that sends mail sends a message, so its spec reads as one; an archive has no `to`.
const recipientsOf = (spec: unknown): string[] => (storedSpec("placement.send", spec).to ?? []).map((r) => (typeof r === "string" ? r : r.address).trim().toLowerCase());

/** The sender name and postal address every email's footer carries, or null until both are set. */
export const senderIdentity = async (tx: OutreachTx): Promise<{ name: string; postalAddress: string } | null> => {
  const s = await readSettings(tx);
  return s?.senderName && s.postalAddress ? { name: s.senderName, postalAddress: s.postalAddress } : null;
};

/** Whether a person has paused sending for this Workspace. */
export const sendingPaused = async (tx: OutreachTx): Promise<boolean> => Boolean((await readSettings(tx))?.pausedAt);

/** Whether one of these addresses opted out in a purged Workspace of the same Organization. */
async function optedOutBefore(tx: OutreachTx, hasher: SuppressionHasher | undefined, emails: string[]): Promise<boolean> {
  if (!hasher || !emails.length || !(await hashedOptOutsExist(tx))) return false;
  const hash = await hasher();
  return hash ? hashedOptOut(tx, emails.map(hash)) : false;
}

/** `hasher` reads the opt-outs a purged Workspace of the same Organization left as hashes (ADR 0030 Q6). */
export const outreachFloors = (repliesRead: RepliesRead, now: () => Date = () => new Date(), hasher?: SuppressionHasher): Check => async (tx, action) => {
  if (await sendingPaused(tx)) return { kind: "hold", reason: "workspace_paused" };
  const touch = touchOf(action.spec);
  // An effect that reaches a Person with no Touch is refused by the schedule's check. A placement
  // effect has none, and still never goes to an address that opted out or bounced.
  if (!touch) {
    if (placementEffect(action.capability)) {
      const to = recipientsOf(action.spec);
      if ((await suppressionReasons(tx, to)).length || (await optedOutBefore(tx, hasher, to))) return { kind: "block", reason: "suppressed" };
    }
    if (isMailboxMailEffect(action.capability) && await mailboxPaused(tx, action.credentialId)) return { kind: "hold", reason: MAILBOX_PAUSED };
    return { kind: "ok" };
  }
  const { personId, touchClass } = touch;
  // An opt-out from any address of this Person's group stops mail to all of them.
  const emails = await emailsOfGroup(tx, personId);
  const reasons = await suppressionReasons(tx, emails);
  if (reasons.length) return { kind: "block", reason: reasons.every((r) => r === "hard_bounce") ? "hard_bounced" : "suppressed" };
  if (await optedOutBefore(tx, hasher, emails)) return { kind: "block", reason: "suppressed" };
  // A paused Mailbox sends nothing, whatever the email is, until a person resumes it.
  if (await mailboxPaused(tx, action.credentialId)) return { kind: "hold", reason: MAILBOX_PAUSED };
  // Someone once on the Workspace's newsletter list gets no cold email unless a person said yes to this one.
  if (touchClass === "cold" && subscriberHold(touch, (await subscribedAmong(tx, emails)).length > 0)) return { kind: "hold", reason: "newsletter_subscriber" };
  // Someone the Workspace is already talking to gets no cold mail, wherever that conversation is recorded.
  if (touchClass === "cold" || touchClass === "consented_marketing") {
    const held = holdResult(await holdOf(tx, action.workspaceId, personId, now()), touchClass);
    if (held) return held;
  }
  // Mail that may say stop hasn't been read yet, so nothing more goes to them until it has.
  if (touchClass === "cold" || touchClass === "sales_follow_up" || touchClass === "consented_marketing") {
    if (await hasOpenSignal(tx, emails, personId)) return { kind: "hold", reason: "reply_unread" };
    if (!(await repliesRead(tx, action))) return { kind: "hold", reason: "replies_not_read" };
    // Until Direx has seen this Mailbox deliver its opt-out unchanged, a recipient's unsubscribe may never reach it.
    const mailbox = await mailboxHold(tx, action.credentialId);
    if (mailbox) return { kind: "hold", reason: mailbox };
  }
  const [record] = await eligibilityOf(tx, [personId]);
  const why = notEligible(touchClass, record ?? null, now());
  return why ? { kind: "hold", reason: "not_eligible", detail: why } : { kind: "ok" };
};
