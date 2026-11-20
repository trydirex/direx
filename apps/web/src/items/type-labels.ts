// SPDX-License-Identifier: AGPL-3.0-only
// Item labels and filter choices, independent of the API client and generated schemas.
export const KIND_LABEL: Record<string, string> = {
  company_review: "Company review",
  brief: "SEO Brief",
  fact_proposal: "Brand suggestion",
  fact_conflict: "Brand conflict",
  lesson_proposal: "Lesson",
  lesson_fact: "Lesson",
  plan_version: "Plan",
  strategy_version: "Strategy",
  strategy_assumptions: "Strategy assumptions",
  plan_change: "Plan change",
  next_step: "Next step",
  campaign_conflict: "Campaign conflict",
  // Notices and choices about a running Campaign, not drafts to approve.
  campaign_waiting: "Campaign",
  campaign_launch_moved: "Campaign",
  campaign_stall: "Campaign",
  campaign_plan_unfinished: "Campaign",
  standing_rule_offer: "Standing rule",
  newsletter_skipped: "Newsletter",
  opt_out_review: "Opt-out",
  reply: "Reply",
  manual_post: "Post",
};
export const ACTION_LABEL: Record<string, string> = { outreach: "Email", newsletter: "Newsletter", social: "Post" };

/** Each name `kindLabel` gives, with the kinds and work areas behind it, as the list's `type` filter takes them. */
export const TYPES: [label: string, keys: string[]][] = Object.entries(
  [...Object.entries(KIND_LABEL), ...Object.entries(ACTION_LABEL)].reduce<Record<string, string[]>>((by, [key, label]) => ({ ...by, [label]: [...(by[label] ?? []), key] }), {}),
).sort(([a], [b]) => a.localeCompare(b));

