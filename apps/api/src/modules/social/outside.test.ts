// SPDX-License-Identifier: AGPL-3.0-only
// Outside posts (ADR 0039): own-post recognition, the kind filter, keep_until and the read state.
import { describe, expect, it } from "vitest";
import { isKept, keepUntil, originOf, readState, type OwnRecords } from "./domain/outside";

const own: OwnRecords = {
  refs: new Set(["sent-id"]),
  urls: new Set(["https://facebook.com/reel/1"]),
  sent: new Set(["Marked as posted by hand"]),
  pending: new Set(["Still dispatching"]),
};

describe("originOf", () => {
  it.each([
    ["the id of a sent Action", { id: "sent-id", text: "anything" }, "own"],
    ["a Facebook reel: id differs, permalink matches", { id: "reel-9", permalink: "https://facebook.com/reel/1", text: "x" }, "own"],
    ["a mark-sent post, by text only", { id: "p1", text: "Marked as posted by hand" }, "own"],
    ["whitespace around the text", { id: "p2", text: "  Marked as posted by hand\n" }, "own"],
    ["an unsettled send", { id: "p3", text: "Still dispatching" }, "possibly_own"],
    ["an unsettled send with whitespace", { id: "p4", text: "\tStill dispatching " }, "possibly_own"],
    ["a sent match beats a pending one", { id: "sent-id", text: "Still dispatching" }, "own"],
    ["inner whitespace differs", { id: "p5", text: "Marked as  posted by hand" }, "outside"],
    ["nothing matches", { id: "p6", permalink: "https://facebook.com/reel/2", text: "Mine alone" }, "outside"],
  ] as const)("%s", (_, post, origin) => expect(originOf(post, own)).toBe(origin));
});

describe("isKept", () => {
  it.each([
    ["original", true],
    ["quote", true],
    ["reply", false],
    ["repost", false],
  ])("%s: %s", (kind, kept) => expect(isKept(kind)).toBe(kept));
});

it("keepUntil adds the network's days", () => {
  expect(keepUntil(new Date("2026-01-01T12:00:00Z"), 90)).toEqual(new Date("2026-04-01T12:00:00Z"));
  expect(keepUntil(new Date("2026-01-01T12:00:00Z"), 30)).toEqual(new Date("2026-01-31T12:00:00Z"));
});

describe("readState", () => {
  const now = new Date("2026-11-21T12:00:00Z");
  const HOUR = 3_600_000;
  const at = (hoursAgo: number) => new Date(now.getTime() - hoursAgo * HOUR);
  const row = (r: Partial<Parameters<typeof readState>[0]>) => ({ postsReadAt: null, postsReadState: null, postsReadReason: null, postsCursor: null, ...r });

  it.each([
    ["the plugin can't read", row({ postsReadAt: at(1), postsReadState: "ok", postsCursor: "c" }), false, { state: "not_checked" }],
    ["never read", row({}), true, { state: "first_read" }],
    ["the first read is running", row({ postsReadState: "reading" }), true, { state: "first_read" }],
    ["a failed first read", row({ postsReadState: "failed", postsReadReason: "auth" }), true, { state: "failed", reason: "auth", at: null }],
    ["a failed later read", row({ postsReadAt: at(3), postsReadState: "failed", postsReadReason: "rate_limited", postsCursor: "c" }), true, { state: "failed", reason: "rate_limited", at: at(3) }],
    ["a later read running", row({ postsReadAt: at(1), postsReadState: "reading", postsCursor: "c" }), true, { state: "ok", at: at(1) }],
    ["a later read running without a cursor after a recent success", row({ postsReadAt: at(1), postsReadState: "reading" }), true, { state: "ok", at: at(1) }],
    ["a later read running without a cursor after a stale success", row({ postsReadAt: at(3), postsReadState: "reading" }), true, { state: "stale", at: at(3) }],
    ["read within twice the interval", row({ postsReadAt: at(2), postsReadState: "ok", postsCursor: "c" }), true, { state: "ok", at: at(2) }],
    ["no read in twice the interval", row({ postsReadAt: at(2.5), postsReadState: "ok", postsCursor: "c" }), true, { state: "stale", at: at(2.5) }],
  ] as const)("%s", (_, r, canRead, expected) => expect(readState(r, now, HOUR, canRead)).toEqual(expected));
});
