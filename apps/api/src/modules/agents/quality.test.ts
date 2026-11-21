// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, test } from "vitest";
import { CITATION_CODES, crossed, isCitation, isQuality, normalise, previousOf, QUALITY_CODES, WORLD_CODES } from "./domain/quality";

/**
 * Every refusal code a sink can hand back, as it is written, read from the sinks and what they pass on.
 * A new sink code goes here, and into QUALITY_CODES or WORLD_CODES on purpose: a quality code counts
 * towards a version's drift alert, a world code never does.
 */
const SINK_CODES: Record<string, readonly string[]> = {
  "agents/application/proposals.ts, offers.ts": ["no_sink", "offer_closed", "duplicate_key"],
  "agents/adapters/fact-sink.ts": ["source_not_read", "already_in_brand"],
  "facts propose, passed on by the fact sink": ["blank_value", "value_too_long", "already_waiting"],
  "agents/domain/citations.ts": ["malformed", "outside_manifest", "stale"],
  "plans/application/kinds.ts": ["citation_not_ok:1b9d6bcd-bbfd-4b2d-9b5d-ab8dfbbd4bed"],
  "plans/application/drafting.ts": ["target_changed", "not_found", "archived"],
  "prospecting/application/names.ts": ["no_company", "names_not_pending"],
  "competitors/application/labels.ts, moves.ts": ["no_input", "no_item", "labels_refused: two labels for one change", "brief_refused: names no page", "post_refused: too long"],
  "seo/application/briefs.ts": ["no_page", "brief_refused: no gaps"],
  "items createItem, passed on by the SEO brief sink": ["unknown_kind", "group_key_required", "superseded"],
  "clips/application/runs.ts, worker.ts": ["no_clip_run", "no_moment", "no_clips"],
  "ask/application/messages.ts": ["no_message"],
  "campaigns/application/drafting.ts": ["unknown_merge_field", "posts_unavailable", "changed_since", "needs_decision"],
  "social posts edit, passed on by a post rewrite": [
    "unknown_network",
    "video_and_images",
    "too_many_images",
    "unknown_media",
    "unknown_account",
    "account_required",
    "reconnect",
    "not_available",
    "follow_ups_not_available",
    "reconnect_for_video",
    "reconnect_for_images",
    "refused_by_network",
    "wrong_state",
    "stale",
    "outcome_unknown",
  ],
  "campaigns/application/write-up.ts": ["no_write_ups"],
  "campaigns/domain/write-up.ts writeUpProblem": [
    "too_long:140",
    "too_many_suggestions:4",
    "number_not_in_brief:42%",
    "credit:thanks to",
    "winner_without_comparison",
    "reading_id_in_text",
    "unknown_reading:r9",
    "suggestion_without_reading",
    "repeats_assumption",
  ],
  "campaigns/application/person-drafts.ts": ["no_start_draft", "no_outreach", "no_items", "unknown_detail", "mailbox_required", "person_left", "waiting_on_step"],
  "agents start, passed on by the reader sink": ["unknown_agent", "no_route", "disabled"],
  "outreach prepare and campaign approval, passed on by placing or revising an email": [
    "credential_not_found",
    "sender_identity_missing",
    "person_not_found",
    "mailbox_replies_only",
    "plan_not_approved",
    "person_removed",
  ],
};

test("every code a sink returns is filed as quality or world, never both", () => {
  const unfiled: string[] = [];
  for (const code of Object.values(SINK_CODES).flat()) {
    const n = normalise(code);
    if (QUALITY_CODES.includes(n) === WORLD_CODES.includes(n)) unfiled.push(code);
  }
  expect(unfiled).toEqual([]);
});

test("the lists don't repeat a code, and citation codes are quality codes", () => {
  const all = [...QUALITY_CODES, ...WORLD_CODES];
  expect(new Set(all).size).toBe(all.length);
  for (const c of CITATION_CODES) expect(isQuality(c)).toBe(true);
});

test("a code is normalised to the part before its first colon, trimmed and lower case", () => {
  expect(normalise("too_long:140")).toBe("too_long");
  expect(normalise("brief_refused: names no page: twice")).toBe("brief_refused");
  expect(normalise(" Target_Changed ")).toBe("target_changed");
  expect(normalise("")).toBe("");
});

test("quality and citation codes are told apart, their detail ignored", () => {
  expect(isQuality("too_long:140")).toBe(true);
  expect(isCitation("too_long:140")).toBe(false);
  expect(isQuality("unknown_reading:r9")).toBe(true);
  expect(isCitation("unknown_reading:r9")).toBe(true);
  expect(isCitation("citation_not_ok:f1")).toBe(true);
  expect(isQuality("target_changed")).toBe(false);
  expect(isQuality("something_new")).toBe(false);
});

describe("crossed", () => {
  const at = (rate: number, runs = 50) => ({ rate, runs });

  test("a rise of ten points fires, exactly at the line included", () => {
    expect(crossed(at(0.06), at(0.16))).toBe(true);
    expect(crossed(at(0.2), at(0.3))).toBe(true);
    expect(crossed(at(0.2), at(0.29))).toBe(false);
  });

  test("doubling from above zero fires, exactly at the line included", () => {
    expect(crossed(at(0.02), at(0.04))).toBe(true);
    expect(crossed(at(0.02), at(0.039))).toBe(false);
  });

  test("from zero only the ten points count, since anything doubles zero", () => {
    expect(crossed(at(0), at(0.05))).toBe(false);
    expect(crossed(at(0), at(0.1))).toBe(true);
    expect(crossed(at(0), at(0))).toBe(false);
  });

  test("fewer than 50 runs on either side never fires", () => {
    expect(crossed(at(0.1, 49), at(0.5))).toBe(false);
    expect(crossed(at(0.1), at(0.5, 49))).toBe(false);
    expect(crossed(at(0.1, 50), at(0.5, 50))).toBe(true);
  });

  test("a fall never fires", () => {
    expect(crossed(at(0.5), at(0.1))).toBe(false);
  });
});

describe("previousOf", () => {
  const v = (agent: string, definitionVersion: number, day: number, runs = 60) => ({ agent, definitionVersion, routeHash: "h", firstRunAt: new Date(Date.UTC(2026, 10, day)), runs });

  test("is the same agent's most recent earlier version, whatever the order given", () => {
    const current = v("writer", 4, 20);
    const versions = [v("writer", 1, 1), v("writer", 3, 10), current, v("writer", 2, 5), v("writer", 5, 25)];
    expect(previousOf(versions, current)?.definitionVersion).toBe(3);
  });

  test("skips versions under 50 runs", () => {
    const current = v("writer", 3, 20);
    expect(previousOf([v("writer", 1, 1), v("writer", 2, 10, 49), current], current)?.definitionVersion).toBe(1);
  });

  test("ignores other agents", () => {
    const current = v("writer", 2, 20);
    expect(previousOf([v("reader", 1, 10), current], current)).toBeUndefined();
  });

  test("is none for an agent's first version", () => {
    const current = v("writer", 1, 1);
    expect(previousOf([current], current)).toBeUndefined();
  });
});
