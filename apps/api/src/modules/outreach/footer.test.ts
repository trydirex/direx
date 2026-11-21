// SPDX-License-Identifier: AGPL-3.0-only
import { expect, test } from "vitest";
import { isPublicHttps, optOutFooter, REPLY_STOP, TRACKED_PER_RECIPIENT } from "./domain/footer";
import { ownWords } from "./domain/reply-rules";

test.each(["https://app.direx.example", "https://direx.example:8443/base", "https://203.0.113.7", "https://[2001:db8::1]"])("%s is public HTTPS", (url) => {
  expect(isPublicHttps(url)).toBe(true);
});

test.each([
  "http://direx.example",
  "http://localhost:3000",
  "https://localhost",
  "https://app.localhost",
  "https://direx.local",
  "https://box.internal",
  "https://127.0.0.1",
  "https://10.1.2.3",
  "https://172.20.0.5",
  "https://192.168.1.10",
  "https://169.254.1.1",
  "https://100.64.0.1",
  "https://[::1]",
  "https://[fd00::1]",
  "https://intranet",
  "not a url",
])("%s is not", (url) => {
  expect(isPublicHttps(url)).toBe(false);
});

test("the footer asks for a stop reply, and carries the link only when there is one", () => {
  const who = { senderName: "Sam at Acme", postalAddress: "1 Main St" };
  expect(optOutFooter({ ...who, unsubscribeUrl: null })).toBe(`--\nSam at Acme\n1 Main St\n${REPLY_STOP}`);
  expect(optOutFooter({ ...who, unsubscribeUrl: "https://d.example/u/1" })).toBe(`--\nSam at Acme\n1 Main St\n${REPLY_STOP}\nUnsubscribe: https://d.example/u/1`);
});

test("only an email whose links carry a token says so, just before the reply-stop line, and a reply still drops the footer", () => {
  const who = { senderName: "Sam at Acme", postalAddress: "1 Main St", unsubscribeUrl: "https://d.example/u/1" };
  const tracked = optOutFooter({ ...who, trackedPerRecipient: true });
  expect(tracked).toBe(`--\nSam at Acme\n1 Main St\n${TRACKED_PER_RECIPIENT}\n${REPLY_STOP}\nUnsubscribe: https://d.example/u/1`);
  expect(optOutFooter({ ...who, trackedPerRecipient: false })).toBe(optOutFooter(who));
  expect(optOutFooter(who)).not.toContain(TRACKED_PER_RECIPIENT);
  expect(ownWords(`Sounds good, call me.\n\n${tracked}`)).toBe("Sounds good, call me.");
});
