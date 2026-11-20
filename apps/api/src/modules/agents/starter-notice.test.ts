// SPDX-License-Identifier: AGPL-3.0-only
// The notice to whoever started a run that stopped at a limit or has to wait: each of its three
// versions names the Workspace, and nobody is told when the starter has left (TASKS #35).
import { beforeAll, expect, test } from "vitest";
import { seedMember } from "../identity/fixtures/member";
import { logMailer, type Mail } from "../identity/index";
import type { RunRow } from "./adapters/repo";
import { starterNotice } from "./index";

const W = crypto.randomUUID();
const starter = crypto.randomUUID();
const outbox: Mail[] = [];
const notify = starterNotice(logMailer(outbox));
const run = (agent: string, startedBy: string | null = starter) => ({ workspaceId: W, agent, startedBy }) as RunRow;

beforeAll(() => seedMember(W, starter, "marketer"));

test.each([
  ["campaign_drafter", "capped", "Test: Direx hasn't finished a draft"],
  ["campaign_drafter", "waiting", "Test: Direx hasn't finished a draft"],
  ["brand_reader", "capped", "Test: Direx stopped reading before it finished"],
  ["brand_reader", "waiting", "Test: Direx is waiting to finish a read"],
] as const)("%s %s: the notice names the Workspace", async (agent, what, subject) => {
  outbox.length = 0;
  await notify(run(agent), what);
  expect(outbox).toHaveLength(1);
  expect(outbox[0]!.to).toBe(`${starter}@example.com`);
  expect(outbox[0]!.subject).toBe(subject);
  expect(outbox[0]!.text).toMatch(/^Workspace: Test\n\n\S/);
});

test("a run whose starter has left, or that nobody started, sends nothing", async () => {
  outbox.length = 0;
  await notify(run("brand_reader", crypto.randomUUID()), "capped");
  await notify(run("brand_reader", null), "capped");
  expect(outbox).toEqual([]);
});
