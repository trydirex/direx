// SPDX-License-Identifier: AGPL-3.0-only
// The placement jobs through a pg-boss that records what it is given: which Mailboxes each pass reaches,
// in what order, and once per Workspace for the sweep. The real passes are covered by mail-intake.test.ts.
import { expect, test } from "vitest";
import { recordedBoss } from "./fixtures/boss";
import { PLACEMENT_DAILY, PLACEMENT_SWEEP, placementJobs } from "./placement";

function setup() {
  const r = recordedBoss();
  const calls: string[] = [];
  const asked: string[][] = [];
  placementJobs({
    boss: r.boss,
    later: r.later,
    connections: () => ["google", "imap"],
    connected: async (connections) => {
      asked.push(connections);
      return [
        { workspaceId: "w1", credentialId: "m1" },
        { workspaceId: "w1", credentialId: "m2" },
        { workspaceId: "w2", credentialId: "m3" },
      ];
    },
    sending: { daily: async (w, m) => void calls.push(`send ${w} ${m}`), cancelLate: async (w) => void calls.push(`cancel ${w}`) },
    reading: { plan: async (w, m) => void calls.push(`plan ${w} ${m}`), readDue: async (w) => void calls.push(`read ${w}`) },
    reporting: { daily: async (w, m) => void calls.push(`report ${w} ${m}`) },
  });
  return { r, calls, asked };
}

test("both placement queues register on their crons, only once everything is built", async () => {
  const { r } = setup();
  expect(r.queues).toEqual([]);
  await r.start();
  expect(Object.fromEntries(r.crons)).toEqual({ [PLACEMENT_DAILY]: "0 6 * * *", [PLACEMENT_SWEEP]: "*/5 * * * *" });
});

test("the daily pass sends, plans and reports for each Mailbox on a Mailbox connection, in that order", async () => {
  const { r, calls, asked } = setup();
  await r.start();
  await r.run(PLACEMENT_DAILY);
  expect(asked).toEqual([["google", "imap"]]);
  expect(calls).toEqual(["send w1 m1", "plan w1 m1", "report w1 m1", "send w1 m2", "plan w1 m2", "report w1 m2", "send w2 m3", "plan w2 m3", "report w2 m3"]);
});

test("the sweep cancels late checks and reads due ones once per Workspace", async () => {
  const { r, calls } = setup();
  await r.start();
  await r.run(PLACEMENT_SWEEP);
  expect(calls).toEqual(["cancel w1", "read w1", "cancel w2", "read w2"]);
});
