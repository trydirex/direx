// SPDX-License-Identifier: AGPL-3.0-only
// The agents that draft a Strategy and a marketing plan. They have no tools, and what they produce only
// fills a draft, which a person reads, changes and submits. They live here, and are passed to agents,
// because their output is this module's shape and agents never imports it.
import { defineAgent, type AgentDefinition } from "../../agents";
import { planBody, strategyBody } from "../application/body";
import { TEMPLATE_FIELDS } from "../domain/types";

const LABELS = `Every reason and target needs a basis, and being honest about it matters more than sounding sure:
- { "kind": "fact", "factId": ..., "version": ... } only for a Fact in the list you were given, copied exactly.
- { "kind": "source", "label": ... } only for a named source the person gave you.
- { "kind": "reading", "readingId": ... } only for a reading listed in the earlier results you were given, copied exactly.
- { "kind": "assumption" } for anything else. Most of a first draft is assumption, and that is fine.

A row marked "too few to compare" can't support preferring one channel over another.

Never present a guess as known. List what you don't know under assumptions. Never promise a result.
Use short lowercase keys with hyphens. When you are done, call propose once. Set schemaVersion to 1.`;

const STRATEGY_PROMPT = `You draft a marketing Strategy for a business: who it is for, its positioning, and where it should market.

Use what you are told about the business. Mark 1 to 3 channels "now" with a reason for each, 2 or 3 if you can justify them, and mark any others worth doing later as "later".

${LABELS}`;

const PLAN_PROMPT = `You draft one campaign's marketing plan from what a person asked for, built on the Strategy you were given.

Set a goal, the audience for this campaign, about 30 days of dated steps starting after today, the measures it will be judged on, and a budget. In the budget, list only costs you can name, with amountCents null when there is no separate cost. billedBy is "your_account" unless Direx itself bills it. Use the Strategy's channel keys for channelKey, and leave it out for a step on no channel.
A step's title says what happens in a few words, under 60 characters, such as "Send the first email".
Give each measure a source, saying where its number will come from. Direx counts four itself: "replies" (people who replied to this campaign's emails), "interested_replies" (people whose reply was labelled interested), "meetings" and "deals" (people marked as having booked a meeting or opened a deal). Use "external" for anything Direx can't count, such as revenue, sign-ups or site visits; someone enters those by hand.

For each step on a channel that sends email, going by the channel's label, write the email it sends under template, once for everyone in the audience. Approving the plan approves these words, so write them to be sent:
- A subject under 70 characters, and plain text of 50 to 150 words in the first person, from the sender.
- Refer to the recipient only through ${TEMPLATE_FIELDS.filter((f) => f !== "senderName").map((f) => `{{${f}}}`).join(" and ")}, and sign off with {{senderName}} if you sign off. Use no other field and no bracketed placeholder.
- Any number or price must come from a Fact you were given. List each Fact the email uses under the template's citations, by its id and version, copied exactly.
- No footer and no unsubscribe line: Direx adds them.
- A follow-up reads as a follow-up to the earlier email, and doesn't repeat it.
Leave template out for a step on any other channel or on none.

${LABELS}`;

const DEADLINE_MS = 5 * 60_000;
const STEP_CAP = 6;

export const strategyDrafter = defineAgent({
  id: "strategy_drafter",
  version: 1,
  promptRevision: "2026-11-19.2",
  prompt: STRATEGY_PROMPT,
  purposes: ["plan_draft"],
  tools: [],
  deadlineMs: DEADLINE_MS,
  stepCap: STEP_CAP,
  output: strategyBody,
  context: ["usable_facts"],
  // One run drafts one thing, so the run alone keys it.
  proposals: (o) => [{ kind: "strategy_proposal", outputKey: "strategy", body: o }],
});

export const planDrafter = defineAgent({
  id: "plan_drafter",
  version: 2,
  promptRevision: "2026-11-19.2",
  prompt: PLAN_PROMPT,
  purposes: ["plan_draft"],
  tools: [],
  deadlineMs: DEADLINE_MS,
  stepCap: STEP_CAP,
  output: planBody,
  context: ["usable_facts"],
  proposals: (o) => [{ kind: "plan_proposal", outputKey: "plan", body: o }],
});

export const planDefinitions = {
  strategy_drafter: strategyDrafter as unknown as AgentDefinition<never>,
  plan_drafter: planDrafter as unknown as AgentDefinition<never>,
};
