// SPDX-License-Identifier: AGPL-3.0-only
// The newsletter module's only public entry point: the Workspace's weekly issue, its list and slot.
export { createNewsletter, type Newsletter, type NewsletterDeps, type SettingsView } from "./application/settings";
export { newsletterRoutes } from "./routes";
export { newsletterKinds, newsletterWeekly, SKIPPED_KIND, type NewsletterWeekly } from "./application/weekly";
export { issueDesk, type IssueDesk } from "./application/issues";
export { newsletterAfterSend, notDeliveredText, readOnlyText, STATS_AT, type NewsletterAfterSend } from "./application/after-send";
export { HANDOFF_KIND, SUBSTACK, type HandoffPayload } from "./application/handoff";
