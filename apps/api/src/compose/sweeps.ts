// SPDX-License-Identifier: AGPL-3.0-only
// The periodic sweeps the worker side schedules: rules over their cap, campaign stalls and owed plan
// work, old reply text, unused media, counted plan readings, agent versions that got worse and the
// operational tables' retention windows. Each queue, schedule and consumer goes through `later`, so it
// starts only after every module is built (ADR 0027 rule 001).
import type { PgBoss } from "pg-boss";
import type { Drift } from "../modules/agents/index";
import type { Campaigns } from "../modules/campaigns/index";
import type { Media } from "../modules/media/index";
import { clearOldReplyText } from "../modules/outreach/index";
import { sweepRetention } from "../modules/retention/index";
import type { StandingRules } from "../modules/standing-rules/index";

export const RULE_CAP_SWEEP = "standing_rules.cap_sweep";
export const STALL_CHECK = "campaigns.stall_check";
export const SETTLE_SWEEP = "campaigns.settle_sweep";
export const REPLY_TEXT_SWEEP = "outreach.reply_text_sweep";
export const MEDIA_SWEEP = "media.sweep";
export const RETENTION_SWEEP = "retention.sweep";
export const RESULT_READINGS_SWEEP = "campaigns.readings_sweep";
export const DRIFT_CHECK = "agents.drift_check";

export type Later = (start: () => Promise<unknown>) => void;

export function sweeps(d: {
  boss: Pick<PgBoss, "createQueue" | "schedule" | "work">;
  later: Later;
  standingRules: Pick<StandingRules, "sweepOverCap">;
  campaigns: () => Pick<Campaigns, "followAnchors" | "offerStalls" | "settleAll" | "countReadings">;
  media: () => Pick<Media, "sweep">;
  drift: Pick<Drift, "driftAll">;
}) {
  const { boss, later } = d;
  /** One queue on a cron, worked by `run`. */
  const every = (queue: string, cron: string, run: () => Promise<unknown>) => {
    later(() => boss.createQueue(queue));
    later(() => boss.schedule(queue, cron));
    later(() => boss.work(queue, async () => run()));
  };
  every(RULE_CAP_SWEEP, "5 0 * * *", () => d.standingRules.sweepOverCap());
  // Daily [DEFAULT]: asks about each step others wait on whose output is 3 days overdue.
  every(STALL_CHECK, "30 7 * * *", async () => {
    await d.campaigns().followAnchors();
    await d.campaigns().offerStalls();
  });
  // Plan change work a crash or a refusal left owed, every 5 minutes [DEFAULT].
  every(SETTLE_SWEEP, "*/5 * * * *", () => d.campaigns().settleAll());
  every(REPLY_TEXT_SWEEP, "0 3 * * *", () => clearOldReplyText());
  // Daily [DEFAULT]: each operational table loses the rows its window has passed (ADR 0030 rule 002).
  every(RETENTION_SWEEP, "15 3 * * *", () => sweepRetention());
  // Daily [DEFAULT], after the reply-text sweep.
  every(MEDIA_SWEEP, "30 4 * * *", () => d.media().sweep());
  // Daily [DEFAULT]: each agent version whose rejection or citation-failure rate rose past ADR 0008's line tells the Workspace's Owners once.
  every(DRIFT_CHECK, "0 5 * * *", () => d.drift.driftAll());
  // Daily [DEFAULT]: each counted Measure gets a reading when its count moved.
  every(RESULT_READINGS_SWEEP, "0 6 * * *", () => d.campaigns().countReadings());
}
