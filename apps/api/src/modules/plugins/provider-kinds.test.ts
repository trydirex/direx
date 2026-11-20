// SPDX-License-Identifier: AGPL-3.0-only
// What makes a connection a provider comes from the SDK catalogue (ADR 0028 rule 001). Every
// first-party manifest reads as the same providers it did before the lists moved there.
import { firstPartyPlugins } from "@direx/extensions";
import { expect, test } from "vitest";
import { docsConnections } from "./application/docs";
import { mailboxShapes } from "./application/mailbox";
import { newsletterShapes } from "./application/newsletter";
import { searchConnections } from "./application/search";

test("every first-party manifest gives the providers it gave before", () => {
  const shapes = firstPartyPlugins().map(({ manifest: m }) => ({ id: m.id, mailbox: mailboxShapes(m), newsletter: newsletterShapes(m), search: searchConnections(m), docs: docsConnections(m) }));
  expect(shapes).toMatchInlineSnapshot(`
    [
      {
        "docs": [],
        "id": "com.trydirex.gmail",
        "mailbox": {
          "incomplete": [],
          "shapes": [
            {
              "connection": "google",
              "dedupe": "queryable",
            },
          ],
        },
        "newsletter": {
          "incomplete": [],
          "shapes": [],
        },
        "search": [],
      },
      {
        "docs": [],
        "id": "com.trydirex.imap-smtp",
        "mailbox": {
          "incomplete": [],
          "shapes": [
            {
              "connection": "imap_smtp",
              "dedupe": "queryable",
            },
          ],
        },
        "newsletter": {
          "incomplete": [],
          "shapes": [],
        },
        "search": [],
      },
      {
        "docs": [],
        "id": "com.trydirex.linkedin",
        "mailbox": {
          "incomplete": [],
          "shapes": [],
        },
        "newsletter": {
          "incomplete": [],
          "shapes": [],
        },
        "search": [],
      },
      {
        "docs": [],
        "id": "com.trydirex.linkedin-page",
        "mailbox": {
          "incomplete": [],
          "shapes": [],
        },
        "newsletter": {
          "incomplete": [],
          "shapes": [],
        },
        "search": [],
      },
      {
        "docs": [],
        "id": "com.trydirex.x",
        "mailbox": {
          "incomplete": [],
          "shapes": [],
        },
        "newsletter": {
          "incomplete": [],
          "shapes": [],
        },
        "search": [],
      },
      {
        "docs": [],
        "id": "com.trydirex.bluesky",
        "mailbox": {
          "incomplete": [],
          "shapes": [],
        },
        "newsletter": {
          "incomplete": [],
          "shapes": [],
        },
        "search": [],
      },
      {
        "docs": [],
        "id": "com.trydirex.facebook",
        "mailbox": {
          "incomplete": [],
          "shapes": [],
        },
        "newsletter": {
          "incomplete": [],
          "shapes": [],
        },
        "search": [],
      },
      {
        "docs": [],
        "id": "com.trydirex.instagram",
        "mailbox": {
          "incomplete": [],
          "shapes": [],
        },
        "newsletter": {
          "incomplete": [],
          "shapes": [],
        },
        "search": [],
      },
      {
        "docs": [],
        "id": "com.trydirex.threads",
        "mailbox": {
          "incomplete": [],
          "shapes": [],
        },
        "newsletter": {
          "incomplete": [],
          "shapes": [],
        },
        "search": [],
      },
      {
        "docs": [],
        "id": "com.trydirex.reoon",
        "mailbox": {
          "incomplete": [],
          "shapes": [],
        },
        "newsletter": {
          "incomplete": [],
          "shapes": [],
        },
        "search": [],
      },
      {
        "docs": [],
        "id": "com.trydirex.kit",
        "mailbox": {
          "incomplete": [],
          "shapes": [],
        },
        "newsletter": {
          "incomplete": [],
          "shapes": [
            {
              "connection": "kit",
              "hasLists": false,
              "hasStats": true,
              "publishDedupe": "queryable",
              "publishLeadMs": 300000,
              "sendDedupe": "queryable",
            },
          ],
        },
        "search": [],
      },
      {
        "docs": [],
        "id": "com.trydirex.beehiiv",
        "mailbox": {
          "incomplete": [],
          "shapes": [],
        },
        "newsletter": {
          "incomplete": [],
          "shapes": [
            {
              "connection": "beehiiv",
              "hasLists": false,
              "hasStats": true,
              "publishDedupe": "blind",
              "publishLeadMs": 0,
              "sendDedupe": "blind",
            },
          ],
        },
        "search": [],
      },
      {
        "docs": [],
        "id": "com.trydirex.mailchimp",
        "mailbox": {
          "incomplete": [],
          "shapes": [],
        },
        "newsletter": {
          "incomplete": [],
          "shapes": [
            {
              "connection": "mailchimp",
              "hasLists": true,
              "hasStats": true,
              "publishDedupe": "queryable",
              "publishLeadMs": 0,
              "sendDedupe": "queryable",
            },
          ],
        },
        "search": [],
      },
      {
        "docs": [],
        "id": "com.trydirex.search-console",
        "mailbox": {
          "incomplete": [],
          "shapes": [],
        },
        "newsletter": {
          "incomplete": [],
          "shapes": [],
        },
        "search": [
          "google_search_console",
        ],
      },
      {
        "docs": [
          "notion",
          "notion_oauth",
        ],
        "id": "com.trydirex.notion",
        "mailbox": {
          "incomplete": [],
          "shapes": [],
        },
        "newsletter": {
          "incomplete": [],
          "shapes": [],
        },
        "search": [],
      },
    ]
  `);
});
