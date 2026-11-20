// SPDX-License-Identifier: AGPL-3.0-only
export { GMAIL_SCOPES, gmailManifest } from "./gmail/manifest";
export { createGmailPlugin, type GmailPluginOptions } from "./gmail/plugin";
export { GOOGLE_PROVIDER, GOOGLE_SEARCH_CONSOLE_PROVIDER, SEARCH_CONSOLE_SCOPES } from "./google";

export { createImapSmtpPlugin, type ImapSmtpOptions } from "./imap-smtp/plugin";
export { imapSmtpManifest } from "./imap-smtp/manifest";
export { mailboxProviders, type MailboxProviderInfo } from "./mailbox-providers";

export { socialProviders } from "./social-providers";
export { socialNetworks, type NetworkFeature, type SocialAvailability, type SocialNetworkInfo } from "./social-networks";

export { createKitPlugin } from "./kit/plugin";
export { createBeehiivPlugin, NEEDS_PRO } from "./beehiiv/plugin";
export { createFakeKit } from "./kit/fake-kit";
export { createLinkedInPlugin } from "./social/linkedin/plugin";
export { createXPlugin } from "./social/x/plugin";
export { createThreadsPlugin } from "./social/threads/plugin";
export { fakeThreads } from "./social/threads/fake-threads";
export { fakeLinkedIn } from "./social/linkedin/fake-linkedin";
export { createFakeBeehiiv } from "./beehiiv/fake-beehiiv";
export { createSearchConsolePlugin, SearchConsoleError, type SearchConsoleReason } from "./search-console/plugin";
export { createFakeSearchConsole } from "./search-console/fake-search-console";
export { createNotionPlugin, NotionError, type NotionReason } from "./notion/plugin";
export { NOTION_OAUTH_PROVIDER } from "./notion/provider";
export { createFakeNotion, type FakeNotionSource } from "./notion/fake-notion";

import { createBeehiivPlugin } from "./beehiiv/plugin";
import { createGmailPlugin } from "./gmail/plugin";
import { createKitPlugin } from "./kit/plugin";
import { createMailchimpPlugin } from "./mailchimp/plugin";
import { createImapSmtpPlugin } from "./imap-smtp/plugin";
import { createReoonPlugin } from "./reoon/plugin";
import { createSearchConsolePlugin } from "./search-console/plugin";
import { createNotionPlugin } from "./notion/plugin";
import { createBlueskyPlugin } from "./social/bluesky/plugin";
import { createFacebookPlugin } from "./social/facebook/plugin";
import { createInstagramPlugin } from "./social/instagram/plugin";
import { createLinkedInPagePlugin, createLinkedInPlugin } from "./social/linkedin/plugin";
import { createThreadsPlugin } from "./social/threads/plugin";
import { createXPlugin } from "./social/x/plugin";

/** Every first-party plugin the worker loads. A new provider joins here and core stays as it is. */
export const firstPartyPlugins = () => [createGmailPlugin(), createImapSmtpPlugin(), createLinkedInPlugin(), createLinkedInPagePlugin(), createXPlugin(), createBlueskyPlugin(), createFacebookPlugin(), createInstagramPlugin(), createThreadsPlugin(), createReoonPlugin(), createKitPlugin(), createBeehiivPlugin(), createMailchimpPlugin(), createSearchConsolePlugin(), createNotionPlugin()];
