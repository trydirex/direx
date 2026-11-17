// SPDX-License-Identifier: AGPL-3.0-only
// Which SMTP refusals name a sending limit or abuse. A wrong yes stops an auto-approve rule; a wrong
// no leaves it running, so both directions have cases.
import { expect, test } from "vitest";
import { providerLimitOf } from "./smtp";

test.each([
  ["421 4.7.0 Try again later, closing connection", "sending_limit"],
  ["550 5.4.5 Daily user sending quota exceeded", "sending_limit"],
  ["451 Too many messages, slow down", "sending_limit"],
  ["550 5.7.1 Message rejected as spam", "abuse"],
  ["554 5.7.1 Service unavailable; client host blocked using a blocklist", "abuse"],
  ["550 5.7.350 Remote server returned message detected as spam -> 550 5.7.350", "abuse"],
  ["550 5.1.1 The email account that you tried to reach does not exist", undefined],
  ["552 5.3.4 Message size exceeds fixed limit", undefined],
  ["550 5.7.1 Relaying denied", undefined],
])("%s", (reply, want) => {
  expect(providerLimitOf(reply)).toBe(want);
});
