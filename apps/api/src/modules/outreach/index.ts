// SPDX-License-Identifier: AGPL-3.0-only
// The outreach module's only public entry point: writing one email to one Person, and the floors
// every Touch passes at dispatch.
export { outreachFloors, senderIdentity, sendingPaused } from "./application/check";
export { createOutreach, mailFrom, OPTED_OUT, whyNot, type Compose, type Outreach, type SendFor } from "./application/outreach";
export { clearOldReplyText, connectedMailboxes } from "./adapters/mailboxes";
export { newsletterSync } from "./application/subscribers";
export { createHolds, recordSentMail, IN_CONVERSATION, MAY_BE_TALKING, type Holds } from "./application/holds";
export { createReplies, humanReply, type InboundEvent, mailboxNeedsReconnect, messageIds, optOutReviewKind, type Replies } from "./application/replies";
export { BASES, ENTITY_TYPES, WARNINGS, type Basis, type Confidence, type EntityType, type Warning as EligibilityWarning } from "./domain/eligibility";
export { outreachRoutes } from "./routes";
export { createHoldHooks } from "./application/hold-hooks";
export { createMailboxPauses, pauseOnProviderAbuse, type MailboxPauses } from "./application/mailboxes";
export { createMailboxDomains, type MailboxDomains } from "./application/domain-report";
export { CHANNELS as OUTSIDE_CHANNELS, createOutsideTouches, type OutsideTouches, type ReplyStop } from "./application/outside-touches";
export { createHeaderCheck, finishHeaderCheck, isProbeCapability, probeRecipient, probeWordingVersion, PROBE_WORDING_VERSION, type ProbeFor } from "./application/header-check";
export { OPTOUT_PROMPT, optOutEval } from "./application/optout-model";
export { createReplyDesk, mailMembers, replyDeskKind } from "./application/reply-desk";
export { isPublicHttps, optOutFooter } from "./domain/footer";
