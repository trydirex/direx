// SPDX-License-Identifier: MIT
// What makes a connection a provider of one kind: the capabilities it must declare, each as
// [kind, name]. Core finds providers from these, never from a plugin's name (DX-R-0006-007).
export const PROVIDER_KINDS = {
  mailbox: [
    ["effect", "email.send"],
    ["trigger", "email.received"],
    ["query", "mailbox.profile"],
    ["query", "mail.from"],
  ],
  newsletter: [
    ["effect", "newsletter.draft"],
    ["effect", "newsletter.send"],
    ["effect", "newsletter.cancel"],
    ["effect", "newsletter.publish"],
    ["query", "newsletter.subscribers"],
    ["query", "newsletter.profile"],
  ],
  search: [
    ["query", "search.properties"],
    ["query", "search.analytics"],
  ],
  docs: [
    ["query", "docs.sources"],
    ["query", "docs.page_text"],
  ],
} as const;
