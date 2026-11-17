// SPDX-License-Identifier: AGPL-3.0-only
import { expect, test } from "vitest";
import { readOptOut } from "./domain/optout";

const reply = "Thanks, but please  take us OFF your list.";

test("an opt-out counts only with the sender's own words, spacing and case aside", () => {
  expect(readOptOut({ answer: "opt_out", quote: "take us off your list" }, reply)).toEqual({ decided: "opted_out", quote: "take us off your list" });
  expect(readOptOut({ answer: "opt_out", quote: "unsubscribe me" }, reply)).toEqual({ decided: "person" });
  expect(readOptOut({ answer: "opt_out", quote: null }, reply)).toEqual({ decided: "person" });
  expect(readOptOut({ answer: "opt_out", quote: "  " }, reply)).toEqual({ decided: "person" });
});

test("no answer or an unsure one is a person's call; a clear no settles it", () => {
  expect(readOptOut(null, reply)).toEqual({ decided: "person" });
  expect(readOptOut({ answer: "unsure", quote: null }, reply)).toEqual({ decided: "person" });
  expect(readOptOut({ answer: "not_opt_out", quote: null }, reply)).toEqual({ decided: "not_opt_out" });
});
