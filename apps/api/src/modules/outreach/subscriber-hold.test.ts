// SPDX-License-Identifier: AGPL-3.0-only
import { expect, test } from "vitest";
import { blocking, EXEMPT_PROVENANCE, warn } from "../items";
import { subscriberHold, subscriberWarningText } from "./domain/subscribers";

test("a standing rule can never cover the subscriber warning", () => {
  expect(EXEMPT_PROVENANCE.has("newsletter_subscriber")).toBe(false);
  expect(blocking([warn("newsletter_subscriber", subscriberWarningText("anna@example.com"))])).toHaveLength(1);
});

const CLASSES = ["cold", "sales_follow_up", "reply_in_thread", "service", "transactional", "consented_marketing"] as const;

test("only cold email to someone on the list waits, and not once a person said yes to it", () => {
  for (const touchClass of CLASSES) {
    expect(subscriberHold({ touchClass }, true)).toBe(touchClass === "cold");
    expect(subscriberHold({ touchClass }, false)).toBe(false);
    expect(subscriberHold({ touchClass, newsletterSubscriber: true }, true)).toBe(false);
  }
});
