// SPDX-License-Identifier: AGPL-3.0-only
// The paused-model and budget notices go to every Owner and Admin and name the Workspace, so an Admin
// of several Workspaces can tell which one is meant (TASKS #35).
import { beforeAll, expect, test } from "vitest";
import { seedMember } from "../identity/fixtures/member";
import { adminEmails, logMailer, type Mail } from "../identity/index";
import { adminNotices } from "./index";

const W = crypto.randomUUID();
const outbox: Mail[] = [];
const notices = adminNotices({ mailer: logMailer(outbox), adminEmails });

beforeAll(() => seedMember(W, crypto.randomUUID(), "owner"));

test("a paused model choice names the Workspace", async () => {
  outbox.length = 0;
  await notices.notifyPaused(W, { agent: "brand_reader", model: "second-model" });
  expect(outbox.map((m) => m.to)).toEqual(await adminEmails(W));
  expect(outbox[0]!.subject).toBe("Test: Direx paused your choice of second-model for brand_reader");
  expect(outbox[0]!.text).toMatch(/^Workspace: Test\n\nYour choice of second-model/);
});

test("a budget threshold names the Workspace", async () => {
  outbox.length = 0;
  await notices.notifyAdmins(W, { month: "2026-11", threshold: 80 });
  expect(outbox).toHaveLength(1);
  expect(outbox[0]!.subject).toBe("Test: Direx model cost reached 80% of this month's budget");
  expect(outbox[0]!.text).toMatch(/^Workspace: Test\n\nModel cost for 2026-11/);
});
