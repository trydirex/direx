// SPDX-License-Identifier: AGPL-3.0-only
import { expect, test } from "vitest";
import { draftInput, listsOutput, profileInput, publishInput, sendInput, subscriber, subscribersInput, subscriberState, toSubscriberState } from "./contract";

test("a draft, a publish, a subscriber read and a profile may name one list in the account", () => {
  const issue = { title: "Week 12", html: "<p>Hi</p>", listId: "a1b2c3" };
  expect(draftInput.safeParse(issue).success).toBe(true);
  expect(publishInput.safeParse(issue).success).toBe(true);
  expect(subscribersInput.safeParse({ listId: "a1b2c3" }).success).toBe(true);
  expect(profileInput.safeParse({}).success).toBe(true);
  expect(profileInput.safeParse({ listId: "a1b2c3" }).success).toBe(true);
  expect(profileInput.safeParse({ listId: "" }).success).toBe(false);
  expect(draftInput.safeParse({ ...issue, listId: "x".repeat(101) }).success).toBe(false);
});

test("an account's lists each have an id, a name and a size", () => {
  expect(listsOutput.safeParse([{ id: "a1b2c3", name: "Weekly", subscriberCount: 340 }]).success).toBe(true);
  expect(listsOutput.safeParse([{ id: "a1b2c3", name: "Weekly", subscriberCount: -1 }]).success).toBe(false);
  expect(listsOutput.safeParse([{ id: "", name: "Weekly", subscriberCount: 3 }]).success).toBe(false);
});

const KIT = { active: "subscribed", cancelled: "unsubscribed", bounced: "bounced", complained: "complained" } as const;

test("a tool's known states map to ours", () => {
  expect(toSubscriberState("active", KIT)).toBe("subscribed");
  expect(toSubscriberState("cancelled", KIT)).toBe("unsubscribed");
});

test("an unknown state is other, never subscribed", () => {
  expect(toSubscriberState("inactive", KIT)).toBe("other");
  expect(toSubscriberState("toString", KIT)).toBe("other");
  expect(toSubscriberState("", KIT)).toBe("other");
});

test("the schema refuses a state that wasn't mapped", () => {
  expect(subscriberState.safeParse("active").success).toBe(false);
  expect(subscriber.safeParse({ email: "a@b.co", state: "active", createdAt: "2026-11-04T20:29:05Z" }).success).toBe(false);
  expect(subscriber.safeParse({ email: "a@b.co", state: "subscribed", createdAt: "2026-11-04T20:29:05Z" }).success).toBe(true);
});

test("a draft needs a one-line title and a body", () => {
  expect(draftInput.safeParse({ title: "Week 12", html: "<p>Hi</p>" }).success).toBe(true);
  expect(draftInput.safeParse({ title: "Week\n12", html: "<p>Hi</p>" }).success).toBe(false);
  expect(draftInput.safeParse({ title: "Week 12", html: "" }).success).toBe(false);
  expect(draftInput.safeParse({ title: "Week 12", html: "<p>Hi</p>", to: "everyone" }).success).toBe(false);
});

test("a send names an issue and, optionally, a time with a zone", () => {
  expect(sendInput.safeParse({ issueId: "26803362" }).success).toBe(true);
  expect(sendInput.safeParse({ issueId: "26803362", at: "2026-11-04T21:29:07Z" }).success).toBe(true);
  expect(sendInput.safeParse({ issueId: "26803362", at: "2026-11-04 21:29" }).success).toBe(false);
  expect(sendInput.safeParse({ issueId: "" }).success).toBe(false);
});
