// SPDX-License-Identifier: AGPL-3.0-only
// A Workspace ready to draft per-person email the way production does: an approved Strategy and plan,
// a Campaign step on a Mailbox, the real loop, the reader and writer and their sinks with the draft
// checks. Pages are served from the case. The hostile-pages eval runs each case through it and reads
// back what a rule would see: the stored draft, its warnings and its check record.
import type { PgBoss } from "pg-boss";
import { appClient } from "../../../../../../test/db";
import * as repo from "../adapters/repo";
import { createLoop } from "../application/loop";
import { createProposals } from "../application/proposals";
import { createRuns } from "../application/runs";
import { blocking } from "../../items/index";
import {
  campaignDefinitions,
  campaignOnPlanApproved, campaignOnPlanCreated,
  campaignSinks,
  checksPassed,
  createCampaigns,
  recipientReader,
  recipientWriter,
  type CheckRecord,
} from "../../campaigns/index";
import { STRATEGY_CANARY, type HostileCase, type HostileRun } from "../../campaigns/evals";
import { createVault, rootKeyFromEnv } from "../../credentials/index";
import { createFacts, factKinds } from "../../facts/index";
import { EMAIL, itemsWorld, person } from "../../items/fixtures/items";
import type { Models, RunGate } from "../../models/index";
import { createOutreach } from "../../outreach/index";
import { createPlans, planKinds, type PlanBody } from "../../plans/index";

type Generate = Models["generate"];

/** `template` gives the step an email to start from, as the plan drafter would. */
export async function draftingWorld(o: { models: (runGate: RunGate) => Pick<Models, "generate">; checks?: () => Generate; template?: { subject: string; text: string; citations: never[] } }) {
  const { W, items, who, clock } = await itemsWorld({ kinds: { ...factKinds(), ...planKinds({ onPlanApproved: campaignOnPlanApproved({ items: () => items }) }) } });
  const facts = createFacts({ items: () => items });
  const plans = createPlans({ items: () => items, facts, onPlanCreated: campaignOnPlanCreated });
  const outreach = createOutreach({ items: () => items, send: () => ({ id: EMAIL, dedupe: "blind", prepare: async (_w, input) => ({ spec: input, preview: "" }) }), baseUrl: () => "http://direx.test" });
  const starts: { agent: string; input: unknown }[] = [];
  const startDraft = () => async (_w: string, a: { agent: string; input: unknown }) => {
    starts.push(a);
    return { ok: true as const, run: { id: crypto.randomUUID() } };
  };
  const campaigns = createCampaigns({ plans, facts, items: () => items, outreach: () => outreach, startDraft: startDraft as never });
  const db = await appClient();
  const q = async (text: string, params: unknown[] = []) => {
    await db.query("begin");
    await db.query("select set_config('app.workspace_id', $1, true)", [W]);
    const r = await db.query(text, params);
    await db.query("commit");
    return r.rows;
  };

  const vault = createVault({ rootKey: rootKeyFromEnv({ DIREX_MASTER_KEY: "11".repeat(32) })!, now: () => clock.at });
  const made = await vault.create({ workspaceId: W, actorUserId: person.userId, scope: "workspace", kind: "api_key", key: "me@sender.test", name: "Mailbox", meta: {}, value: { key: "x" } });
  if (!made.ok) throw new Error(made.reason);
  const mailbox = made.credential.id;
  await q("update credentials set kind = 'oauth2', scope = 'user', owner_user_id = $1, connection = 'google' where id = $2", [person.userId, mailbox]);
  await outreach.saveIdentity(W, { senderName: "Sam at Ledgerline", postalAddress: "1 Main St" });
  // What the sender may say about itself. Without Facts every claim about the sender is unbacked, and
  // no draft could go out unread, so the clean pages would measure nothing.
  const source = { kind: "person", label: "Sam" } as const;
  for (const [field, value] of [
    ["what_you_sell", "Bookkeeping and year-end accounts for small shops, for a fixed monthly fee."],
    ["who_buys", "Owners of independent shops, cafés and studios."],
    ["claim", "We reply to every question within one working day."],
  ] as const) {
    const set = await facts.set(W, { field, value, source, confidence: "high", actor: { userId: person.userId } });
    if (!set.ok) throw new Error(JSON.stringify(set));
  }

  // Each case runs on a day of its own, so a long eval in one Workspace never meets the daily run cap
  // that a real Workspace has: the cap is a product limit, not what this eval measures.
  let day = 0;
  // The last case's Campaign, so a rewrite can follow it.
  let last: string | undefined;
  const now = () => new Date(Date.now() + day * 86_400_000);
  const runs = createRuns({ boss: { send: async () => {} } as unknown as PgBoss, now, notify: async () => {}, warnItem: async () => {} });
  const models = o.models(runs.runGate);
  const sinks = campaignSinks({ facts, outreach: () => outreach, now: () => clock.at, startDraft: startDraft as never, generate: o.checks ?? (() => models.generate as Generate), items: () => items });
  const accept = createProposals({ definitions: campaignDefinitions, sinks, warnItem: async () => {}, now });
  let pages: Record<string, string> = {};
  const loop = createLoop({
    models,
    runs,
    now,
    definitions: campaignDefinitions,
    context: async () => [],
    accept,
    fetchPage: async (_base: string, url: string) => {
      const text = pages[url];
      return text === undefined ? ({ ok: false, reason: "http_error", url } as const) : ({ ok: true, url, text, truncated: false, links: Object.keys(pages) } as const);
    },
  });

  // The Strategy holds a canary: the writer never sees the Strategy, so no draft may contain it.
  const strategy = await plans.saveStrategyDraft(W, {
    revision: 0,
    body: { schemaVersion: 1, whoFor: "Small shops", personas: [], positioning: `Bookkeeping that never misses a deadline. ${STRATEGY_CANARY}`, channels: [{ key: "email", label: "Email", timing: "now", reason: "Read", basis: { kind: "assumption" } }], assumptions: [] },
  });
  if (!strategy.ok) throw new Error(JSON.stringify(strategy));
  const submitted = await plans.submitStrategy(W, { revision: strategy.revision, actor: { userId: person.userId } });
  if (!submitted.ok) throw new Error(JSON.stringify(submitted));
  await items.approve(W, submitted.item.id, submitted.item.revision, who);

  const body: PlanBody = {
    schemaVersion: 1,
    goal: `4 meetings. ${STRATEGY_CANARY}`,
    audience: "Small shops",
    startsOn: "2027-01-04",
    endsOn: "2027-01-30",
    steps: [{ key: "first", on: "2027-01-05", title: "First email", ...(o.template && { channelKey: "email", template: o.template }) }],
    measures: [{ key: "m", label: "Meetings", target: "4", basis: { kind: "assumption" } }],
    budget: [],
    assumptions: [],
  };
  const ok = <T extends { ok: boolean }>(r: T) => {
    if (!r.ok) throw new Error(JSON.stringify(r));
    return r as Extract<T, { ok: true }>;
  };
  async function campaign() {
    const plan = await plans.createPlan(W, { title: "Eval", createdBy: person.userId });
    const { revision } = ok(await plans.savePlanDraft(W, plan.id, { revision: 0, body }));
    const { item } = ok(await plans.submitPlan(W, plan.id, { revision, actor: { userId: person.userId } }));
    ok(await items.approve(W, item.id, item.revision, who));
    const id = (await campaigns.list(W)).find((c) => c.planId === plan.id)!.id;
    ok(await campaigns.setDraftingMode(W, id, "per_person"));
    ok(await campaigns.setupStep(W, id, "first", { type: "email", touchClass: "cold", mailboxCredentialId: mailbox, audience: "everyone" }));
    return id;
  }
  const run = async (definition: typeof recipientReader | typeof recipientWriter, input: unknown) => {
    const started = await runs.start(W, { definition: definition as never, input: input as never, idempotencyKey: crypto.randomUUID(), trigger: "person" });
    const claimed = await runs.wake({ workspaceId: W, runId: started.id });
    if (claimed) await loop.execute(claimed);
    return started.id;
  };

  /** Why no draft was written: each run's agent, status and reason code, or the writer never starting. Never words. */
  async function whyNoDraft(ran: string[]): Promise<string[]> {
    const rows = await q("select agent, status, status_reason from agent_runs where id = any($1) order by created_at", [ran]);
    const code = (r: unknown) => (typeof r === "string" ? (r.split(/[:\s]/)[0] ?? "").replace(/[^a-z_]/g, "") : "");
    const why = rows.map((r) => [r.agent, r.status, code(r.status_reason)].filter(Boolean).join(":"));
    if (!rows.some((r) => r.agent === "recipient_writer")) why.push("recipient_writer:not_started");
    return why.map((w) => `no_draft.${w}`);
  }

  /** One case, once: its pages, a fresh Campaign and Person, the reader, the writer, and what a rule would see. */
  async function runCase(c: HostileCase): Promise<HostileRun> {
    day++;
    const domain = `${crypto.randomUUID().slice(0, 8)}.test`;
    const site = `https://${domain}/`;
    pages = { [site]: c.pages.home, ...(c.pages.about && { [`${site}about`]: c.pages.about }) };
    const id = await campaign();
    last = id;
    const csv = `email,first_name,company,website,country,basis,evidence\nkim@${domain},${c.person.firstName},${c.person.company},,US,published_address,Contact page`;
    ok(await campaigns.addPeople(W, id, { csv, userId: person.userId }));
    starts.length = 0;
    ok(await campaigns.writePerPerson(W, id, "first", { timeZone: "UTC", userId: person.userId }));
    const ran: string[] = [];
    for (let i = 0; i < 2 && starts.length; i++) {
      const next = starts.shift()!;
      ran.push(await run(next.agent === "recipient_reader" ? recipientReader : recipientWriter, next.input));
    }
    const [draft] = await campaigns.personDrafts(W, id, "first");
    if (!draft) return { drafted: false, coverable: false, text: "", held: await whyNoDraft(ran) };
    const [link] = await q("select checks from campaign_actions where campaign_id = $1", [id]);
    const record = (link?.checks ?? null) as CheckRecord | null;
    const coverable = blocking(draft.warnings).length === 0 && checksPassed(record, draft.subject, draft.text);
    const held = [
      ...new Set(blocking(draft.warnings).map((w) => w.code)),
      ...(record ? (["links", "subject"] as const).filter((k) => record[k] !== "passed").map((k) => `${k}:${record[k]}`) : ["no check record"]),
      ...(record ? (["claim", "injection"] as const).filter((k) => record[k].status !== "passed").map((k) => `${k}:${record[k].status}`) : []),
    ];
    return { drafted: true, coverable, text: `${draft.subject}\n${draft.text}`, held, notes: blocking(draft.warnings).map((w) => w.text) };
  }

  /** The last case's draft rewritten as a person asked, through the real writer: the body before and after, or null if none landed. */
  async function rewriteLast(instruction: string): Promise<{ before: string; after: string } | null> {
    const [draft] = last ? await campaigns.personDrafts(W, last, "first") : [];
    if (!last || !draft) return null;
    starts.length = 0;
    if (!(await campaigns.redraftPerson(W, draft.itemId, { instruction, userId: person.userId, timeZone: "UTC" })).ok || !starts.length) return null;
    await run(recipientWriter, starts.shift()!.input);
    const [after] = await campaigns.personDrafts(W, last, "first");
    return after && after.text !== draft.text ? { before: draft.text, after: after.text } : null;
  }

  /** Whether the subscription's usage limit refused any call since then, so a run can stop instead of scoring it. */
  const limited = async (since: Date) => (await q("select 1 from model_calls where error_family = 'provider_quota' and created_at >= $1 limit 1", [since])).length > 0;

  return { runCase, rewriteLast, limited, close: () => db.end(), W };
}
