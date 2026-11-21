// SPDX-License-Identifier: AGPL-3.0-only
// Pure: which refusal codes say an agent wrote something that broke a rule, and when a new version's
// rate has risen enough over the one before to tell a Workspace's Owners (ADR 0008 rule 026).

/** A citation that didn't hold: a sink's check, or a citation result other than `ok`. */
export const CITATION_CODES: readonly string[] = [
  "number_not_in_brief",
  "unknown_reading",
  "reading_id_in_text",
  "suggestion_without_reading",
  "citation_not_ok",
  "outside_manifest",
  "stale",
  "malformed",
];

/** What the model wrote broke a rule. Only these count towards a version's rejection rate. */
export const QUALITY_CODES: readonly string[] = [
  // A campaign write-up's checks.
  "too_long",
  "too_many_suggestions",
  "credit",
  "winner_without_comparison",
  "repeats_assumption",
  // Drafting: a merge field or a recipient detail that doesn't exist, or a price no Fact says.
  "unknown_merge_field",
  "unknown_detail",
  "needs_decision",
  // Competitor and SEO briefs and posts, refused with their problems.
  "labels_refused",
  "brief_refused",
  "post_refused",
  // A fact from a page the run never read, and a clip pick whose every moment failed its checks.
  "source_not_read",
  "no_moment",
  ...CITATION_CODES,
];

/**
 * Refusals that say nothing about the model's words: the world moved under the run (a person's edit
 * won, the Person left), or the Workspace isn't set up for the draft. Counting them would raise an
 * alarm every time a team edits its plan.
 */
export const WORLD_CODES: readonly string[] = [
  // Agents: no owner for the output, an offer already closed, a repeated output key.
  "no_sink",
  "offer_closed",
  "duplicate_key",
  // Facts: already said, or already waiting for a person.
  "already_in_brand",
  "already_waiting",
  "blank_value",
  "value_too_long",
  // What the run was for is gone or has moved on.
  "target_changed",
  "changed_since",
  "not_found",
  "archived",
  "superseded",
  "wrong_state",
  "outcome_unknown",
  "person_left",
  "person_removed",
  "plan_not_approved",
  "names_not_pending",
  "waiting_on_step",
  // The Workspace or deployment can't take the draft.
  "mailbox_required",
  "mailbox_replies_only",
  "credential_not_found",
  "sender_identity_missing",
  "person_not_found",
  "posts_unavailable",
  "no_clips",
  "no_clip_run",
  "no_company",
  "no_input",
  "no_item",
  "no_message",
  "no_page",
  "no_write_ups",
  "no_start_draft",
  "no_outreach",
  "no_items",
  "unknown_kind",
  "group_key_required",
  // A writer run that couldn't start.
  "unknown_agent",
  "no_route",
  "disabled",
  // A post rewrite the network or its connection refuses.
  "unknown_network",
  "unknown_account",
  "unknown_media",
  "video_and_images",
  "too_many_images",
  "account_required",
  "reconnect",
  "reconnect_for_video",
  "reconnect_for_images",
  "not_available",
  "follow_ups_not_available",
  "refused_by_network",
];

const QUALITY = new Set(QUALITY_CODES);
const CITATION = new Set(CITATION_CODES);

/** A code without its detail: `too_long:140` and `brief_refused: …` count as `too_long` and `brief_refused`. */
export const normalise = (code: string): string => code.split(":", 1)[0]!.trim().toLowerCase();
export const isQuality = (code: string): boolean => QUALITY.has(normalise(code));
export const isCitation = (code: string): boolean => CITATION.has(normalise(code));

/** Below this many runs a version's rate says too little to compare. */
export const MIN_RUNS = 50;
const RISE = 0.1;
// Rates are fractions, so 0.3 - 0.2 is a hair under 0.1; a rise of exactly ten points still counts.
const EPSILON = 1e-9;

export type Rate = { rate: number; runs: number };

/** The ADR's alert: over 50 runs on both sides, the rate rose by ten points or, from above zero, doubled. */
export function crossed(old: Rate, next: Rate): boolean {
  if (old.runs < MIN_RUNS || next.runs < MIN_RUNS) return false;
  return next.rate - old.rate >= RISE - EPSILON || (old.rate > 0 && next.rate >= 2 * old.rate);
}

/** The version to compare with: the same agent's most recent earlier one (by first run) with enough runs. */
export function previousOf<V extends { agent: string; firstRunAt: Date; runs: number }>(versions: readonly V[], current: V): V | undefined {
  let best: V | undefined;
  for (const v of versions) {
    if (v.agent !== current.agent || v.runs < MIN_RUNS || v.firstRunAt >= current.firstRunAt) continue;
    if (!best || v.firstRunAt > best.firstRunAt) best = v;
  }
  return best;
}
