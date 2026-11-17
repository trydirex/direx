// SPDX-License-Identifier: AGPL-3.0-only
// After a connect, a person lands back on the page they connected from.
import { GOOGLE_PROVIDER, GOOGLE_SEARCH_CONSOLE_PROVIDER, socialNetworks } from "@direx/extensions";
import { expect, test } from "vitest";
import { landingPage } from "./main";

test("Search Console goes back to the SEO page, a network to Social accounts, a Mailbox to Credentials", () => {
  expect(landingPage(GOOGLE_SEARCH_CONSOLE_PROVIDER.connection)).toBe("seo");
  expect(landingPage(socialNetworks()[0]!.connection)).toBe("social");
  expect(landingPage(GOOGLE_PROVIDER.connection)).toBe("credentials");
  expect(landingPage(null)).toBe("credentials");
});
