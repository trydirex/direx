// SPDX-License-Identifier: AGPL-3.0-only
// Each sweep's queue, cron and handler, through a pg-boss that records what it is given: running a
// recorded handler must reach the module behind it. The reply-text and retention sweeps run against the database.
import { expect, test } from "vitest";
import { recordedBoss } from "./fixtures/boss";
import { DRIFT_CHECK, MEDIA_SWEEP, REPLY_TEXT_SWEEP, RESULT_READINGS_SWEEP, RETENTION_SWEEP, RULE_CAP_SWEEP, SETTLE_SWEEP, STALL_CHECK, sweeps } from "./sweeps";

test("every sweep registers on its cron and its handler reaches its module", async () => {
  const calls: string[] = [];
  const r = recordedBoss();
  sweeps({
    boss: r.boss,
    later: r.later,
    standingRules: { sweepOverCap: async () => void calls.push("rules over cap") },
    campaigns: () => ({
      followAnchors: async () => void calls.push("follow anchors"),
      offerStalls: async () => void calls.push("offer stalls"),
      settleAll: async () => void calls.push("settle all"),
      countReadings: async () => void calls.push("count readings"),
    }),
    media: () => ({
      sweep: async () => {
        calls.push("media sweep");
        return { removed: 0, failed: 0 };
      },
    }),
    drift: { driftAll: async () => void calls.push("drift check") },
  });
  // Nothing registers until the starts run, after every module is built.
  expect(r.queues).toEqual([]);
  await r.start();

  expect(Object.fromEntries(r.crons)).toEqual({
    [RULE_CAP_SWEEP]: "5 0 * * *",
    [STALL_CHECK]: "30 7 * * *",
    [SETTLE_SWEEP]: "*/5 * * * *",
    [REPLY_TEXT_SWEEP]: "0 3 * * *",
    [RETENTION_SWEEP]: "15 3 * * *",
    [MEDIA_SWEEP]: "30 4 * * *",
    [DRIFT_CHECK]: "0 5 * * *",
    [RESULT_READINGS_SWEEP]: "0 6 * * *",
  });
  expect(r.queues.sort()).toEqual([DRIFT_CHECK, MEDIA_SWEEP, REPLY_TEXT_SWEEP, RESULT_READINGS_SWEEP, RETENTION_SWEEP, RULE_CAP_SWEEP, SETTLE_SWEEP, STALL_CHECK].sort());

  for (const queue of [RULE_CAP_SWEEP, STALL_CHECK, SETTLE_SWEEP, MEDIA_SWEEP, DRIFT_CHECK, RESULT_READINGS_SWEEP]) await r.run(queue);
  expect(calls).toEqual(["rules over cap", "follow anchors", "offer stalls", "settle all", "media sweep", "drift check", "count readings"]);
  // The real reply-text sweep, against the test database.
  await expect(r.run(REPLY_TEXT_SWEEP)).resolves.not.toThrow();
  await expect(r.run(RETENTION_SWEEP)).resolves.toMatchObject({ "public.trigger_events": 0, "public.model_calls": 0 });
});

test("campaigns, media and drift are required: every sweep registers, and one handed in empty fails when run rather than skipping", async () => {
  const r = recordedBoss();
  // @ts-expect-error campaigns, media and drift are required ports (ADR 0027 rule 003)
  sweeps({ boss: r.boss, later: r.later, standingRules: { sweepOverCap: async () => {} } });
  await r.start();
  expect([...r.crons.keys()].sort()).toEqual([DRIFT_CHECK, MEDIA_SWEEP, REPLY_TEXT_SWEEP, RESULT_READINGS_SWEEP, RETENTION_SWEEP, RULE_CAP_SWEEP, SETTLE_SWEEP, STALL_CHECK].sort());
  await expect(r.run(SETTLE_SWEEP)).rejects.toThrow(TypeError);
  await expect(r.run(RESULT_READINGS_SWEEP)).rejects.toThrow(TypeError);
  await expect(r.run(MEDIA_SWEEP)).rejects.toThrow(TypeError);
  await expect(r.run(DRIFT_CHECK)).rejects.toThrow(TypeError);
});
