// SPDX-License-Identifier: AGPL-3.0-only
// The reply desk: each human reply that isn't an opt-out becomes one reply Item per Person and thread, with a
// label, its quote and an owner. The label only orders the queue; a person settles the Item, and settling it
// drops the thread's reply text. Reply text is untrusted and is never logged.
import { z } from "zod";
import type { ItemKind, Items } from "../../items";
import { clearThreadText, liveApprover, mailboxOwner, sentSubject, threadWasInterested, workspaceOwners } from "../adapters/desk-repo";
import { inWorkspace, type Signal } from "../adapters/repo";
import { REPLY_LABELS } from "../domain/reply-label";
import type { Generate } from "./optout-model";
import { labelReply } from "./reply-label";

export const REPLY_KIND = "reply";
const SETTLE_CHOICES = ["no_answer", "answered_elsewhere"] as const;

const LABEL_WORDS: Record<(typeof REPLY_LABELS)[number] | "unlabelled", string> = {
  interested: "wants to talk",
  question: "asked a question",
  not_now: "said not now",
  referral: "pointed to someone else",
  wrong_person: "says they're the wrong person",
  no: "said no",
  unlabelled: "replied",
};

export const ReplyPayload = z.object({
  signalId: z.uuid(),
  personId: z.uuid(),
  actionId: z.uuid().nullable(),
  label: z.enum([...REPLY_LABELS, "unlabelled"]),
  quote: z.string().nullable(),
  owner: z.object({ userIds: z.array(z.uuid()), rule: z.enum(["approver", "mailbox", "workspace_owners"]) }),
});
export type ReplyPayload = z.infer<typeof ReplyPayload>;

// The approver knows the thread; a Mailbox's person is the fallback, never the other way round.
export function replyOwner(approverId: string | null, mailboxOwnerId: string | null, owners: string[]): ReplyPayload["owner"] {
  if (approverId) return { userIds: [approverId], rule: "approver" };
  if (mailboxOwnerId) return { userIds: [mailboxOwnerId], rule: "mailbox" };
  return { userIds: owners, rule: "workspace_owners" };
}

/** System mail to members by user id; a member who left gets nothing. */
export type NotifyMembers = (workspaceId: string, userIds: string[], mail: { subject: string; text: string }) => Promise<void>;

/** NotifyMembers over the system mailer. With no mailer configured, nobody is mailed. */
export const mailMembers =
  (send: ((m: { to: string; subject: string; text: string }) => Promise<void>) | undefined, emailOf: (workspaceId: string, userId: string) => Promise<string | undefined>): NotifyMembers =>
  async (workspaceId, userIds, mail) => {
    if (!send) return;
    for (const id of userIds) {
      const to = await emailOf(workspaceId, id);
      if (to) await send({ to, ...mail });
    }
  };

/** The owner's alert for a reply that wants to talk. It never carries the reply's words, only where to read them. */
export function interestedAlert(sender: string, subject: string | null): { subject: string; text: string } {
  const about = subject ? `your email "${subject}"` : "an email from this Workspace";
  return { subject: `${sender} wants to talk`, text: `${sender} replied to ${about}, and Direx sorted the reply as wanting to talk. It's waiting for you in Needs you, with their reply.` };
}

export function createReplyDesk(deps: { items: () => Pick<Items, "createItem">; generate?: () => Generate | undefined; notify?: NotifyMembers }) {
  return {
    /** Opens the reply Item for a settled `not_opt_out` reply, replacing the one waiting for the same thread. */
    async open(s: Signal): Promise<void> {
      if (s.kind !== "reply" || s.status !== "not_opt_out" || !s.text || !s.personId) return;
      const reading = await labelReply(deps.generate?.(), s.workspaceId, s.id, s.text);
      const groupKey = `reply:${s.personId}:${s.actionId ?? "none"}`;
      const { owner, told, subject } = await inWorkspace(s.workspaceId, async (tx) => ({
        owner: replyOwner(s.actionId ? await liveApprover(tx, s.actionId) : null, s.credentialId ? await mailboxOwner(tx, s.credentialId) : null, await workspaceOwners(tx)),
        told: await threadWasInterested(tx, groupKey),
        subject: s.actionId ? await sentSubject(tx, s.actionId) : null,
      }));
      const payload: ReplyPayload = { signalId: s.id, personId: s.personId, actionId: s.actionId, label: reading.label, quote: "quote" in reading ? reading.quote : null, owner };
      const made = await deps.items().createItem(s.workspaceId, {
        kind: REPLY_KIND,
        replace: true,
        payload,
        actor: { system: "outreach" },
        details: { title: `${s.senderEmail} ${LABEL_WORDS[reading.label]}`, workArea: "outreach", channel: "email", groupKey, warnings: [] },
      });
      if (!made.ok) throw new Error(`outreach: ${made.reason}: the reply kind isn't registered`);
      // After the Item exists, and never failing the job: a retry would find the thread already told and stay quiet.
      if (reading.label === "interested" && !told) {
        await deps.notify?.(s.workspaceId, owner.userIds, interestedAlert(s.senderEmail, subject)).catch((e) => console.error("outreach: the reply alert failed", s.id, e));
      }
    },
  };
}
export type ReplyDesk = ReturnType<typeof createReplyDesk>;

/** A person settles a reply Item by saying it needs no answer, or that it was answered elsewhere. */
export function replyDeskKind(): Record<string, ItemKind> {
  return {
    [REPLY_KIND]: {
      permission: "item.approve",
      bulk: false,
      dismiss: false,
      async apply(tx, item, _actor, choice) {
        if (!SETTLE_CHOICES.includes(choice as (typeof SETTLE_CHOICES)[number])) return { ok: false, reason: "choice_required" };
        const p = ReplyPayload.parse(item.payload);
        await clearThreadText(tx, p.personId, p.actionId);
        return { ok: true };
      },
    },
  };
}
