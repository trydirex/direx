// SPDX-License-Identifier: AGPL-3.0-only
// Pure: why an Item is Held or Blocked, in the words every screen shows.

const LABELS: Record<string, string> = {
  outcome_unknown: "not sure it sent",
  provider_rejected: "provider rejected",
  approval_invalid: "approval no longer valid",
  approval_expired: "approval expired",
  snapshot_changed: "something it relies on changed",
  plan_changed: "the plan changed",
  rule_needs_review: "rule needs review",
  cap: "frequency cap reached",
  post_limit_reached: "this month's post limit is used up",
  approver_permission_lost: "approver can no longer approve",
  credential_unavailable: "credential can't be used",
  keys_unavailable: "this Workspace's approval keys can't be read",
  late: "it would go out more than a day after its approved time",
  provider_refused_permanently: "provider refused it for good",
  touch_undeclared: "doesn't say whom it reaches",
  workspace_paused: "sending is paused",
  mailbox_paused: "this email account is paused",
  workspace_deleted: "the Workspace was deleted",
  operator_hold: "whoever runs this Direx stopped sending",
  suppressed: "this Person opted out",
  hard_bounced: "this address doesn't exist",
  reply_unread: "a reply hasn't been read yet",
  replies_not_read: "replies to this mailbox aren't being read",
  not_eligible: "no recorded basis to contact this Person",
  newsletter_subscriber: "this Person is on your newsletter list",
  mailbox_unchecked: "this Mailbox hasn't passed its unsubscribe check",
  mailbox_replies_only: "this Mailbox's provider changes unsubscribe links",
  probe_recipient: "a Mailbox check can only go to the Mailbox itself",
  in_conversation: "you're already talking to this Person",
  may_be_talking: "you may already be talking to this Person",
};

/** Where a "may be talking" guess came from: the founder's own Sent mail, or a colleague's hold. */
function guessFrom(detail: string): string | null {
  if (detail === "sent_mail") return "you wrote to them in the last 90 days";
  if (detail.startsWith("company:")) return `you're talking to someone else at ${detail.slice("company:".length)}`;
  return null;
}

/** A reason nobody has worded yet still shows something true, never a raw code. */
export const FALLBACK_REASON = "see details";

export function reasonLabel(code: string, detail?: string | null): string {
  const label = LABELS[code] ?? FALLBACK_REASON;
  if (code === "may_be_talking" && detail && guessFrom(detail)) return `${label}: ${guessFrom(detail)}`;
  if (code === "in_conversation" && detail) return `${label}: ${detail}`;
  return (code === "provider_rejected" || code === "rule_needs_review") && detail ? `${label}: ${detail}` : label;
}
