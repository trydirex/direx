// SPDX-License-Identifier: AGPL-3.0-only
// The real plan drafter eval. Only `bun run eval --purpose plan_draft --provider claude_code --runs N`
// runs it: the vitest config leaves *.real.test.ts out of every other run. The drafter writes each
// email step's template with the plan, and approving the plan approves those words, so every template
// is checked by code and written to a file for a person to read: "usable" is finally their call.
import { writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PgBoss } from "pg-boss";
import { expect, test } from "vitest";
import { itemsWorld } from "../items/fixtures/items";
import { CHECK_CANDIDATES, createModels } from "../models/index";
import { testKeys } from "../models/fixtures/provider";
import { planDefinitions, planDrafter, type PlanBody } from "../plans/index";
import { digestOf } from "./adapters/digest";
import { inWorkspace, readRun } from "./adapters/repo";
import { createLoop } from "./application/loop";
import { createProposals } from "./application/proposals";
import { createRuns, type DraftInput } from "./application/runs";
import { resultFileOf, RESULTS_DIR, type EvalResult } from "./index";

const provider = process.env.DIREX_EVAL_PROVIDER;
const runs = Number(process.env.DIREX_EVAL_RUNS ?? 3);
const secret = process.env.DIREX_EVAL_CLAUDE_CODE_TOKEN;

const SUBJECT_MAX = 70;
const BODY_WORDS = { min: 40, max: 180 };
// The prompt asks for under 60 characters; past this a title is carrying its reasons.
const TITLE_MAX = 80;
/** Runs with any problem, as a share of all runs, that still count as usable. */
const MAX_PROBLEM_SHARE = 0.1;

/** `emailChannel` null: the Strategy has no email channel, so no step may carry a template. */
type Case = { id: string; facts: string[]; strategy: object; request: string; emailChannel: string | null };
const factId = (n: number) => `7f1c3a52-3f0e-4a8e-9b1d-0c2d4e6f8a${String(n).padStart(2, "0")}`;
const CASES: Case[] = [
  {
    id: "charity-audits",
    facts: ["A yearly audit costs $4,500.", "Ledgerline audits 40 charities in Leeds."],
    strategy: { whoFor: "Finance leads at small UK charities", positioning: "Audits that find the error before the regulator does", channels: [{ key: "email", label: "Cold email", timing: "now" }] },
    request: "Book 4 intro calls with charity finance leads, by email.",
    emailChannel: "email",
  },
  {
    id: "shopify-ops",
    facts: ["Parcelwise cut mis-shipments by 30% in a pilot with 3 stores.", "Parcelwise has a free 14-day trial."],
    strategy: { whoFor: "Ops leads at Shopify stores with 500 to 5,000 orders a month", positioning: "Fewer wrong parcels without a new warehouse system", channels: [{ key: "cold-email", label: "Cold email", timing: "now" }, { key: "linkedin", label: "LinkedIn", timing: "now" }] },
    request: "Get 10 trial signups from Shopify ops leads, with email and LinkedIn.",
    emailChannel: "cold-email",
  },
  {
    id: "design-agency",
    facts: ["Northlight builds Webflow sites from $8,000.", "Northlight delivers a site in 4 weeks."],
    strategy: { whoFor: "Founders of seed-stage SaaS companies", positioning: "A site that sells the product, live in a month", channels: [{ key: "email", label: "Email", timing: "now" }] },
    request: "A month of outreach to SaaS founders, email only, a first email and two follow-ups.",
    emailChannel: "email",
  },
  {
    // Asked for an email the Strategy has no channel for: why there is no template goes under assumptions, not in a title.
    id: "no-email-channel",
    facts: ["Clinicdesk books patient recalls for dental clinics.", "Clinicdesk has a free trial."],
    strategy: { whoFor: "Practice managers at small dental clinics", positioning: "Recalls booked without the phone calls", channels: [{ key: "linkedin", label: "LinkedIn", timing: "now" }] },
    request: "Get 5 trial signups from practice managers. Start with one short email, then LinkedIn posts.",
    emailChannel: null,
  },
];

// A call's length ("a 15-minute call") is the sender's ask, which the person reads, not a claim about the business.
const numbersIn = (text: string) => (text.replace(/\d+[- ]minutes?\b/gi, "").match(/\d[\d,.]*%?/g) ?? []).map((n) => n.replace(/[.,]$/, ""));

/** What makes one run's templates unusable as written. Empty means a person could approve them. */
function templateProblems(c: Case, plan: PlanBody): string[] {
  const problems: string[] = [];
  // What a person approved: the Facts, the request and the Strategy.
  const known = [...c.facts, c.request, JSON.stringify(c.strategy)].join(" ");
  const emailSteps = plan.steps.filter((s) => s.channelKey === c.emailChannel);
  if (c.emailChannel && emailSteps.length === 0) problems.push("no email step");
  if (!c.emailChannel && !plan.assumptions.some((a) => /e-?mail/i.test(a.text))) problems.push("no assumption says the email has no channel");
  for (const s of plan.steps) {
    if (s.title.length > TITLE_MAX) problems.push(`${s.key}: title is ${s.title.length} characters`);
    if (s.channelKey === c.emailChannel && !s.template) problems.push(`${s.key}: email step with no template`);
    if (s.channelKey !== c.emailChannel && s.template) problems.push(`${s.key}: template on a step that isn't email`);
  }
  const templates = emailSteps.flatMap((s) => (s.template ? [{ key: s.key, ...s.template }] : []));
  for (const t of templates) {
    const all = `${t.subject} ${t.text}`;
    if (t.subject.length > SUBJECT_MAX) problems.push(`${t.key}: subject is ${t.subject.length} characters`);
    const words = t.text.split(/\s+/).filter(Boolean).length;
    if (words < BODY_WORDS.min || words > BODY_WORDS.max) problems.push(`${t.key}: text is ${words} words`);
    if (/\[[^\]]{2,40}\]/.test(all)) problems.push(`${t.key}: bracketed placeholder`);
    if (/unsubscribe|opt out|opt-out/i.test(t.text)) problems.push(`${t.key}: footer text`);
    for (const n of numbersIn(all)) if (!known.includes(n)) problems.push(`${t.key}: number ${n} isn't in a Fact`);
    for (const cited of t.citations) if (!c.facts.some((_, i) => factId(i) === cited.factId)) problems.push(`${t.key}: cites a Fact it wasn't given`);
    c.facts.forEach((f, i) => {
      if (numbersIn(f).some((n) => numbersIn(all).includes(n)) && !t.citations.some((x) => x.factId === factId(i))) problems.push(`${t.key}: uses "${f}" without citing it`);
    });
  }
  const openers = templates.map((t) => t.text.split(/(?<=[.!?])\s/)[0]?.trim().toLowerCase());
  if (new Set(openers).size !== openers.length) problems.push("two templates open with the same sentence");
  return problems;
}

const sampleOf = (p: PlanBody) =>
  [p.steps.map((s) => `- ${s.on} ${s.key} (${s.channelKey ?? "no channel"}): ${s.title}`).join("\n"), ...p.steps.flatMap((s) => (s.template ? [`### ${s.key}: ${s.template.subject}\n\n${s.template.text}\n\nCites: ${s.template.citations.map((x) => x.factId.slice(-2)).join(", ") || "nothing"}`] : []))].join("\n\n");

test("the plan drafter writes a usable template for every email step", { timeout: 3 * 3_600_000 }, async () => {
  if (provider !== "claude_code" || !secret || !(runs >= 1)) throw new Error("run through bun run eval --purpose plan_draft --provider claude_code --runs N");
  const candidate = { ...CHECK_CANDIDATES.claude_code, maxOutputTokens: 8192 };
  const { W } = await itemsWorld({ kinds: {} });
  const now = () => new Date();
  const handed: { body?: PlanBody } = {};
  const agentRuns = createRuns({ boss: { send: async () => {} } as unknown as PgBoss, now, notify: async () => {}, warnItem: async () => {} });
  const models = createModels({ deployment: "self_host", routes: { plan_draft: { candidates: [candidate] } }, keys: testKeys(secret, candidate.provider), runGate: agentRuns.runGate, now });
  const accept = createProposals({
    definitions: planDefinitions,
    sinks: {
      plan_proposal: async (_ws, p) => {
        handed.body = p.body as PlanBody;
        return { ok: true, itemId: null };
      },
    },
    warnItem: async () => {},
    now,
  });

  const scored: { id: string; problems: string[] }[] = [];
  const samples: string[] = [];
  // A refusal's reason never reaches the run's record, so the eval keeps it to say why a run failed.
  let refusals: string[] = [];
  const watched: Pick<typeof models, "generate"> = {
    generate: async (req) => {
      const r = await models.generate(req);
      if (!r.ok && "reason" in r && r.reason) refusals.push(r.reason);
      return r;
    },
  };
  for (let n = 1; n <= runs; n++) {
    for (const c of CASES) {
      refusals = [];
      const usable = c.facts.map((f, i) => ({ id: factId(i), version: 1, text: f }));
      const loop = createLoop({ models: watched, runs: agentRuns, fetchPage: async () => ({ ok: false, reason: "http_error", url: "" }), now, definitions: planDefinitions, context: async () => usable, accept });
      const input: DraftInput = {
        request: c.request,
        brief: [
          { kind: "date", refId: "today", version: null, text: `Today is ${now().toISOString().slice(0, 10)}.` },
          { kind: "citable_facts", refId: "usable_facts", version: null, text: `Facts you may cite, by id and version:\n${usable.map((f) => `${f.id} version 1: ${f.text}`).join("\n")}` },
          { kind: "strategy", refId: crypto.randomUUID(), version: "1", text: `The Strategy, version 1:\n${JSON.stringify({ schemaVersion: 1, personas: [], assumptions: [], ...c.strategy })}` },
        ],
        target: { id: null, draftRevision: 0 },
      };
      handed.body = undefined;
      const started = await agentRuns.start(W, { definition: planDrafter, input, idempotencyKey: crypto.randomUUID(), trigger: "person" });
      await loop.execute((await agentRuns.wake({ workspaceId: W, runId: started.id }))!);
      const body = handed.body as PlanBody | undefined;
      // A run that hands nothing over says why on its own record: a reply that isn't the schema, a timeout.
      const ended = body ? null : await inWorkspace(W, (tx) => readRun(tx, started.id));
      const problems = body ? templateProblems(c, body) : [`no plan handed over (${ended?.status}: ${ended?.statusReason ?? "no reason"})${refusals.length ? `; refused because: ${refusals.join(" | ")}` : ""}`];
      if (problems.length) console.log(`${c.id} run ${n}: ${problems.join("; ")}`);
      scored.push({ id: c.id, problems });
      if (body) samples.push(`## ${c.id}, run ${n}${problems.length ? ` (problems: ${problems.join("; ")})` : ""}\n\n${sampleOf(body)}`);
    }
  }

  const samplesFile = join(tmpdir(), "direx-plan-drafter.md");
  writeFileSync(samplesFile, `# Plan drafter templates, ${new Date().toISOString()}\n\n${samples.join("\n\n")}\n`);
  const problemRuns = scored.filter((s) => s.problems.length).length;
  const passed = problemRuns <= scored.length * MAX_PROBLEM_SHARE;
  const evalOf = { id: planDrafter.id, version: planDrafter.version };
  const result: EvalResult = {
    agent: evalOf.id,
    definitionVersion: evalOf.version,
    promptDigest: digestOf(planDrafter.prompt),
    provider: candidate.provider,
    model: candidate.model,
    at: new Date().toISOString(),
    runs,
    passed,
    ...(!passed && { why: `${problemRuns} of ${scored.length} runs had a problem` }),
    cases: CASES.map((c) => {
      const mine = scored.filter((s) => s.id === c.id);
      return { name: c.id, passed: mine.every((s) => s.problems.length === 0), passes: mine.filter((s) => s.problems.length === 0).length };
    }),
    measures: { problemRuns },
  };
  writeFileSync(join(RESULTS_DIR, resultFileOf(evalOf, candidate.provider, candidate.model)), `${JSON.stringify(result, null, 2)}\n`);
  console.log(`templates to read: ${samplesFile}`);
  console.log(JSON.stringify(result, null, 2));
  expect(result.passed).toBe(true);
});
