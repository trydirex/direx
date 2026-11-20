// SPDX-License-Identifier: AGPL-3.0-only
import { expect, test } from "vitest";
import { unsupportedChannelComparison } from "./plan-comparison";

test.each([
  "Prioritize LinkedIn because it worked better in the October test.",
  "Email performed better in the latest test.",
  "LinkedIn is the best channel for testing outreach.",
  "Email isn't cheap, but it worked better.",
  "We cannot delay: LinkedIn worked better.",
  "We cannot really delay: LinkedIn worked better.",
  "LinkedIn worked better than email, but there are too few meetings to set a target.",
  "Email worked better.",
])("rejects an unsupported claim: %s", (sentence) => {
  expect(unsupportedChannelComparison(sentence)).toBe(true);
});

test.each([
  "There are too few replies to say LinkedIn worked better.",
  "There is no clear winner between email and LinkedIn.",
  "We cannot tell whether email worked better.",
  "We cannot yet say whether LinkedIn worked better than email.",
  "We can't really tell whether email worked better than LinkedIn.",
  "We cannot really yet determine whether LinkedIn worked better.",
  "It isn't clear whether LinkedIn worked better.",
  "Test whether LinkedIn works better than email.",
  "Test if email is more effective than LinkedIn.",
  "Send email and LinkedIn messages next month.",
  "The October test worked better.",
  "Finance leads who worked at charities and use email.",
])("allows uncertainty or no channel comparison: %s", (sentence) => {
  expect(unsupportedChannelComparison(sentence)).toBe(false);
});
