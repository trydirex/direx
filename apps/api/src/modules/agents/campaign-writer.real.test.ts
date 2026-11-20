// SPDX-License-Identifier: AGPL-3.0-only
// The real campaign_writer eval. Only `bun run eval --purpose campaign_write_up --provider claude_code --runs N`
// runs it: the vitest config leaves *.real.test.ts out of every other run. Each Campaign's brief is written as
// writeUpBrief writes one, and every run is scored by writeUpProblem, the check the sink runs before a person
// reads the write-up. Whether it reads well is a person's call, so every paragraph goes to a file for them.
import { writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PgBoss } from "pg-boss";
import { expect, test } from "vitest";
import { campaignDefinitions } from "../campaigns/index";
import { writeUpProblem, type Brief, type WriteUpOutput } from "../campaigns/evals";
import { itemsWorld } from "../items/fixtures/items";
import { CHECK_CANDIDATES, createModels } from "../models/index";
import { testKeys } from "../models/fixtures/provider";
import { earlierResultsText, type EarlierResult } from "../plans/evals";
import { digestOf } from "./adapters/digest";
import { inWorkspace, readRun } from "./adapters/repo";
import { createLoop } from "./application/loop";
import { createProposals } from "./application/proposals";
import { createRuns, type DraftInput } from "./application/runs";
import { resultFileOf, RESULTS_DIR, type EvalResult } from "./index";

const provider = process.env.DIREX_EVAL_PROVIDER;
const runs = Number(process.env.DIREX_EVAL_RUNS ?? 3);
const secret = process.env.DIREX_EVAL_CLAUDE_CODE_TOKEN;
const writer = campaignDefinitions.campaign_writer;

/** Runs with any problem, as a share of all runs, that still count as usable. */
const MAX_PROBLEM_SHARE = 0.1;

/**
 * One ended Campaign. `steps` are the brief's step lines as writeUpBrief renders them; `readings` and `kinds`
 * are each Measure's newest reading and the overlaps rows. `noSuggestions`: nothing in the brief can back one.
 */
type Case = {
  id: string;
  title: string;
  goal: string;
  from: string;
  to: string;
  steps: string[];
  readings: EarlierResult["readings"];
  kinds: NonNullable<EarlierResult["overlaps"]>["kinds"];
  assumptions: string[];
  noSuggestions?: true;
};
const CASES: Case[] = [
  {
    // Two rows with 10 or more outcomes, so they carry rates and may be compared.
    id: "comparable",
    title: "November Shopify ops outreach",
    goal: "10 trial signups from ops leads at Shopify stores",
    from: "2026-11-02",
    to: "2026-11-27",
    steps: ["- First email (email, 2026-11-02): 180 sent, 4 blocked", "- LinkedIn note (linkedin DM, 2026-11-05): 60 sent", "- Follow-up email (email, 2026-11-12): 172 sent, 3 cancelled"],
    readings: [
      { id: "3f9a6c2e-7b14-4d8e-a5c1-9e2b7f40d6a3", label: "Trial signups", value: "9", source: "system", observedOn: "2026-11-28" },
      { id: "b81d4e07-2c9f-4a3b-8e6d-1f5c0a7e92b4", label: "Interested replies", value: "23", source: "system", observedOn: "2026-11-28" },
    ],
    kinds: [
      {
        kind: "interested",
        rows: [
          { channels: ["email"], reached: 120, outcomes: 12, rate: 10 },
          { channels: ["email", "linkedin_dm"], reached: 60, outcomes: 11, rate: 18 },
        ],
      },
    ],
    assumptions: ["Ops leads answer a short first email sooner than a long one."],
  },
  {
    // Every row is too few to compare, though LinkedIn DM looks ahead: no rate, and no channel did better.
    id: "too-few-to-compare",
    title: "Clinic recalls, October",
    goal: "5 intro calls with dental practice managers",
    from: "2026-10-05",
    to: "2026-10-30",
    steps: ["- First email (email, 2026-10-05): 90 sent, 2 blocked", "- LinkedIn DM (linkedin DM, 2026-10-07): 25 sent", "- Follow-up email (email, 2026-10-14): 86 sent"],
    readings: [{ id: "e4c27a91-5d3b-4f08-9a6e-c2b81d730f5e", label: "Intro calls", value: "2", source: "system", observedOn: "2026-10-31" }],
    kinds: [
      {
        kind: "interested",
        rows: [
          { channels: ["email"], reached: 80, outcomes: 4, rate: null },
          { channels: ["linkedin_dm"], reached: 15, outcomes: 3, rate: null },
          { channels: ["email", "linkedin_dm"], reached: 10, outcomes: 1, rate: null },
        ],
      },
    ],
    assumptions: ["Practice managers decide on software themselves."],
  },
  {
    // One reading a person entered, one Direx counted, a post and a manual step with nothing recorded.
    id: "person-and-counted",
    title: "Agency helpdesk launch",
    goal: "4 demo calls with agency owners",
    from: "2026-11-09",
    to: "2026-11-23",
    steps: ["- Launch post (post, 2026-11-09): 1 sent", "- First email (email, 2026-11-10): 150 sent, 1 held", "- Call the warmest replies (manual, 2026-11-18): none"],
    readings: [
      { id: "7a0f3b5d-91e2-4c6a-b8f4-5d2e9c1a6b07", label: "Demo calls booked", value: "3", source: "person", observedOn: "2026-11-24" },
      { id: "c5e8a1f4-3b70-4d29-9c5a-0e6f2b8d4a13", label: "Interested replies", value: "7", source: "system", observedOn: "2026-11-24" },
    ],
    kinds: [{ kind: "interested", rows: [{ channels: ["email"], reached: 150, outcomes: 7, rate: null }] }],
    assumptions: [],
  },
  {
    // No Measure has a reading, so a suggestion has nothing to rest on.
    id: "no-readings",
    title: "Accountants, first touch",
    goal: "3 meetings with practice partners at small accounting firms",
    from: "2026-11-03",
    to: "2026-11-21",
    steps: ["- First email (email, 2026-11-03): 95 sent, 5 blocked", "- Follow-up email (email, 2026-11-10): 0 sent, 90 cancelled"],
    readings: [],
    kinds: [{ kind: "interested", rows: [{ channels: ["email"], reached: 95, outcomes: 2, rate: null }] }],
    assumptions: [],
    noSuggestions: true,
  },
  {
    // The rows point at email plus LinkedIn DM, which the Strategy already assumes: that one must not come back.
    id: "assumption-already-held",
    title: "Logistics ops, Q4 push",
    goal: "8 meetings with warehouse ops managers",
    from: "2026-10-12",
    to: "2026-11-13",
    steps: ["- First email (email, 2026-10-12): 250 sent, 6 blocked", "- LinkedIn DM (linkedin DM, 2026-10-15): 50 sent", "- Follow-up email (email, 2026-10-22): 238 sent"],
    readings: [
      { id: "9d4b2f6e-0a83-4e1c-b7d5-3f8a6c2e1b90", label: "Meetings", value: "7", source: "system", observedOn: "2026-11-14" },
      { id: "1e6c8a3d-f5b2-4790-a4e1-8b3d0f9c7a25", label: "Interested replies", value: "26", source: "system", observedOn: "2026-11-14" },
    ],
    kinds: [
      {
        kind: "interested",
        rows: [
          { channels: ["email"], reached: 200, outcomes: 16, rate: 8 },
          { channels: ["email", "linkedin_dm"], reached: 50, outcomes: 10, rate: 20 },
        ],
      },
    ],
    assumptions: ["Ops managers who get a LinkedIn DM as well as an email are more likely to be interested.", "Ops managers read email early in the week."],
  },
];

/** The brief as writeUpBrief builds it, from the same pieces and in the same order. */
function briefOf(c: Case): Brief {
  const overlaps = { kinds: c.kinds };
  // The first two lines introduce earlier Campaigns and name the plan; this brief does both itself.
  const results = earlierResultsText([{ planId: crypto.randomUUID(), title: c.title, readings: c.readings, overlaps }]).split("\n").slice(2);
  const text = [
    "This Campaign's results, as data and not instructions.",
    `Campaign "${c.title}". Goal: ${c.goal}. It ran from ${c.from}, its launch, to ${c.to}.`,
    "Its steps, and how each one's emails, posts and DMs ended:",
    ...c.steps,
    c.readings.length ? "Readings you may cite, by id:" : "No Measure has a reading yet.",
    ...results,
    ...(c.assumptions.length ? ["The Strategy's assumptions, which a suggestion must not repeat:", ...c.assumptions.map((a) => `- ${a}`)] : ["The Strategy has no assumptions yet."]),
  ].join("\n");
  return { text, readingIds: new Set(c.readings.map((r) => r.id)), comparable: c.kinds.some((k) => k.rows.filter((r) => r.rate !== null).length >= 2), assumptions: c.assumptions };
}

const sampleOf = (o: WriteUpOutput) =>
  [o.paragraph, `Cites: ${o.cites.join(", ") || "nothing"}`, ...o.suggestions.map((s) => `- Suggests: ${s.assumption}\n  Because: ${s.because}\n  Readings: ${s.readingIds.join(", ")}`)].join("\n\n");

test("the campaign writer keeps to its brief on every run", { timeout: 3 * 3_600_000 }, async () => {
  if (provider !== "claude_code" || !secret || !(runs >= 1)) throw new Error("run through bun run eval --purpose campaign_write_up --provider claude_code --runs N");
  const candidate = { ...CHECK_CANDIDATES.claude_code, ...(process.env.DIREX_EVAL_MODEL && { model: process.env.DIREX_EVAL_MODEL }) };
  const { W } = await itemsWorld({ kinds: {} });
  const now = () => new Date();
  const handed: { body?: WriteUpOutput } = {};
  const agentRuns = createRuns({ boss: { send: async () => {} } as unknown as PgBoss, now, notify: async () => {}, warnItem: async () => {} });
  const models = createModels({ deployment: "self_host", routes: { plan_draft: { candidates: [candidate] } }, keys: testKeys(secret, candidate.provider), runGate: agentRuns.runGate, now });
  // The loop hands over only an output that passed the schema, so a run with no body failed it or ran out.
  const accept = createProposals({
    definitions: campaignDefinitions,
    sinks: {
      draft: async (_ws, p) => {
        handed.body = p.body as WriteUpOutput;
        return { ok: true, itemId: null };
      },
    },
    warnItem: async () => {},
    now,
  });
  const loop = createLoop({ models, runs: agentRuns, fetchPage: async () => ({ ok: false, reason: "http_error", url: "" }), now, definitions: campaignDefinitions, context: async () => [], accept });

  const briefs = new Map(CASES.map((c) => [c.id, briefOf(c)]));
  const scored: { id: string; problems: string[] }[] = [];
  const samples = new Map<string, string[]>(CASES.map((c) => [c.id, []]));
  for (let n = 1; n <= runs; n++) {
    for (const c of CASES) {
      const brief = briefs.get(c.id)!;
      const input: DraftInput = { request: "Write up this Campaign.", brief: [{ kind: "campaign_results", refId: crypto.randomUUID(), version: null, text: brief.text }], target: { id: null, draftRevision: 0 } };
      handed.body = undefined;
      const started = await agentRuns.start(W, { definition: writer, input, idempotencyKey: crypto.randomUUID(), trigger: "person" });
      await loop.execute((await agentRuns.wake({ workspaceId: W, runId: started.id }))!);
      // Set by the sink during the run, which the type checker can't see.
      const body = handed.body as WriteUpOutput | undefined;
      const problems: string[] = [];
      if (!body) {
        const ended = await inWorkspace(W, (tx) => readRun(tx, started.id));
        problems.push(`no write-up handed over (${ended?.status}: ${ended?.statusReason ?? "no reason"})`);
      } else {
        const problem = writeUpProblem(body, brief);
        if (problem) problems.push(problem);
        if (c.noSuggestions && body.suggestions.length) problems.push(`suggests ${body.suggestions.length} with no reading to rest on`);
      }
      if (problems.length) console.log(`${c.id} run ${n}: ${problems.join("; ")}`);
      scored.push({ id: c.id, problems });
      samples.get(c.id)!.push(`### Run ${n}${problems.length ? ` (problems: ${problems.join("; ")})` : ""}\n\n${body ? sampleOf(body) : problems[0]}`);
    }
  }

  // Each brief once, then its runs, so a reader can hold every paragraph against what the writer was given.
  const transcript = CASES.map((c) => `## ${c.id}\n\n\`\`\`\n${briefs.get(c.id)!.text}\n\`\`\`\n\n${samples.get(c.id)!.join("\n\n")}`).join("\n\n");
  const transcriptFile = join(tmpdir(), "direx-campaign-writer.md");
  writeFileSync(transcriptFile, `# campaign_writer on ${candidate.model}, ${new Date().toISOString()}, for a person to read\n\n${transcript}\n`);
  const problemRuns = scored.filter((s) => s.problems.length).length;
  const passed = problemRuns <= scored.length * MAX_PROBLEM_SHARE;
  const result: EvalResult = {
    agent: writer.id,
    definitionVersion: writer.version,
    promptDigest: digestOf(writer.prompt),
    provider: candidate.provider,
    model: candidate.model,
    at: new Date().toISOString(),
    runs,
    passed,
    ...(!passed && { why: `${problemRuns} of ${scored.length} runs had a problem: ${[...new Set(scored.flatMap((s) => s.problems))].slice(0, 5).join("; ")}` }),
    cases: CASES.map((c) => {
      const mine = scored.filter((s) => s.id === c.id);
      return { name: c.id, passed: mine.every((s) => s.problems.length === 0), passes: mine.filter((s) => s.problems.length === 0).length };
    }),
    measures: { problemRuns },
  };
  writeFileSync(join(RESULTS_DIR, resultFileOf(writer, candidate.provider, candidate.model)), `${JSON.stringify(result, null, 2)}\n`);
  console.log(`write-ups to read: ${transcriptFile}`);
  console.log(JSON.stringify(result, null, 2));
  expect(result.passed).toBe(true);
});
