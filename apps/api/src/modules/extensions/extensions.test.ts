// SPDX-License-Identifier: AGPL-3.0-only
import { expect, test } from "vitest";
import { EXTENSIONS_VERSION, noDiscovery, NotAvailable } from "./index";

test("with no discovery installed, estimating and searching both refuse with not_available", async () => {
  await expect(noDiscovery.estimate(["dentists in Leeds"], 50)).rejects.toMatchObject({ reason: "not_available" });
  await expect(noDiscovery.search("w", ["dentists in Leeds"], 50)).rejects.toBeInstanceOf(NotAvailable);
  expect(EXTENSIONS_VERSION).toBe(2);
});
