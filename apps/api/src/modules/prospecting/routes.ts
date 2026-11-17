// SPDX-License-Identifier: AGPL-3.0-only
// Prospecting over HTTP. identity's Workspace middleware has resolved the caller.
import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi";
import { requirePermission, type MemberEnv } from "../identity/index";
import { createCohorts, type SaveResult } from "./application/cohorts";
import type { Handovers } from "./application/handover";
import { NotAvailable, noDiscovery, type Discovery } from "../extensions/index";
import { estimateSearch, MAX_COMPANIES, perCompanyUsd, type Runs } from "./application/runs";
import type { Terms } from "./application/terms";

const ErrorBody = z
  .object({
    error: z.string(),
    max: z.number().optional(),
    signals: z.array(z.string()).optional(),
    terms: z.array(z.string()).optional().openapi({ description: "The terms refused for holding Person data" }),
    usd: z.number().optional().openapi({ description: "The search estimate a confirmed amount must cover" }),
    field: z.string().optional(),
    value: z.unknown().optional(),
  })
  .openapi("ProspectingError");
const json = <T extends z.ZodType>(schema: T, description: string) => ({ description, content: { "application/json": { schema } } });
const errors = { 400: json(ErrorBody, "Invalid request"), 401: json(ErrorBody, "Not signed in"), 403: json(ErrorBody, "Not allowed"), 404: json(ErrorBody, "Not found") };
const ws = z.object({ workspaceId: z.uuid() });

// Far more lines than a run may take, so a long paste gets a named refusal rather than a bare 400.
const MAX_LINES = 5_000;

const PastedLine = z
  .object({ line: z.number(), website: z.string(), ok: z.boolean(), companyId: z.uuid().optional(), runId: z.uuid().optional(), reason: z.enum(["invalid_website", "duplicate", "already_known"]).optional(), sameAs: z.number().optional() })
  .openapi("PastedLine");
const Progress = z.object({ companies: z.number(), readPending: z.number(), read: z.number(), notRead: z.number(), namesPending: z.number(), namesDone: z.number(), namesSkipped: z.number() });
const Run = z
  .object({
    id: z.uuid(),
    source: z.string(),
    terms: z.array(z.string()).openapi({ description: "What was searched for; empty for pasted websites" }),
    status: z.string(),
    signals: z.array(z.string()),
    confirmedUsd: z.number(),
    vendorCostUsd: z.number(),
    confirmedBy: z.uuid(),
    createdAt: z.string(),
    finishedAt: z.string().nullable(),
    progress: Progress,
    unchecked: z.number().openapi({ description: "Addresses at the run's accepted companies the checking service hasn't answered yet" }),
  })
  .openapi("ProspectRun");
const Company = z
  .object({
    id: z.uuid(),
    domain: z.string(),
    website: z.string(),
    name: z.string().nullable(),
    country: z.string().nullable(),
    runId: z.uuid(),
    readStatus: z.string(),
    readReason: z.string().nullable(),
    namesStatus: z.string().nullable(),
    namesReason: z.string().nullable(),
    state: z.string(),
    reviewItemId: z.uuid().nullable(),
    addresses: z.array(z.object({ email: z.string(), kind: z.string(), leftOutReason: z.string().nullable() })),
    signals: z.array(z.object({ type: z.string(), quote: z.string(), pageUrl: z.string(), observedOn: z.string() })).openapi({ description: "What was read on the company's own site, each with its quote, page and date" }),
  })
  .openapi("ProspectCompany");

const pastedRoute = createRoute({
  method: "post",
  path: "/api/w/{workspaceId}/prospecting/runs/pasted",
  middleware: [requirePermission("item.approve")],
  request: {
    params: ws,
    body: {
      content: {
        "application/json": {
          schema: z.strictObject({ websites: z.array(z.string().max(2_000)).max(MAX_LINES), signals: z.array(z.string().max(100)).max(20), confirmedUsd: z.number().nonnegative().max(1_000_000) }),
        },
      },
    },
  },
  responses: { 200: json(z.object({ runId: z.uuid().nullable(), results: z.array(PastedLine) }), "One result per pasted line"), ...errors },
});
const SearchBody = z.strictObject({
  terms: z.array(z.string().trim().min(1).max(200)).min(1).max(20),
  limit: z.number().int().min(1).max(MAX_COMPANIES),
  signals: z.array(z.string().max(100)).max(20),
});
const NotAvailableBody = json(ErrorBody, "not_available: no company search is installed on this deployment; a pasted list still works");
const estimateRoute = createRoute({
  method: "post",
  path: "/api/w/{workspaceId}/prospecting/estimate",
  middleware: [requirePermission("item.edit")],
  request: { params: ws, body: { content: { "application/json": { schema: SearchBody } } } },
  responses: {
    200: json(
      z
        .object({
          searchUsd: z.number(),
          namesUsd: z.number(),
          namesFree: z.boolean().openapi({ description: "Names runs go to a subscription, so they add no money to the estimate" }),
          verifyUsd: z.number(),
          totalUsd: z.number(),
          limit: z.number(),
          defaults: z.object({ namesUsdPerCompany: z.number(), verifyUsdPerAddress: z.number(), addressesPerCompany: z.number() }).openapi({ description: "The default worst-case bounds behind the model and verification costs" }),
        })
        .openapi("SearchEstimate"),
      "The worst-case cost of a search run",
    ),
    409: NotAvailableBody,
    ...errors,
  },
});
const perCompanyRoute = createRoute({
  method: "get",
  path: "/api/w/{workspaceId}/prospecting/estimate/per-company",
  middleware: [requirePermission("item.edit")],
  request: { params: ws },
  responses: {
    200: json(
      z
        .object({
          usd: z.number(),
          namesFree: z.boolean(),
          searchAvailable: z.boolean().openapi({ description: "Whether a company search is installed. Without one only a pasted list works, and the search estimate refuses with not_available" }),
        })
        .openapi("PerCompanyEstimate"),
      "The most reading one company and checking its addresses can cost. A pasted list is estimated from it; nothing stops reading at that amount",
    ),
    ...errors,
  },
});
const SearchLine = z
  .object({ domain: z.string(), name: z.string().nullable(), ok: z.boolean(), companyId: z.uuid().optional(), runId: z.uuid().optional(), reason: z.enum(["already_known", "over_amount"]).optional() })
  .openapi("SearchLine");
const searchRoute = createRoute({
  method: "post",
  path: "/api/w/{workspaceId}/prospecting/runs",
  middleware: [requirePermission("item.approve")],
  request: { params: ws, body: { content: { "application/json": { schema: SearchBody.extend({ confirmedUsd: z.number().nonnegative().max(1_000_000) }) } } } },
  responses: {
    200: json(
      z.object({ runId: z.uuid(), status: z.enum(["running", "done", "stopped"]), searchUsd: z.number(), results: z.array(SearchLine) }),
      "One result per company found; stopped when the confirmed amount ran out before every new company was taken",
    ),
    409: NotAvailableBody,
    ...errors,
  },
});
const RunSummary = z
  .object({ id: z.uuid(), source: z.string(), terms: z.array(z.string()), status: z.string(), confirmedUsd: z.number(), vendorCostUsd: z.number(), companies: z.number(), createdAt: z.string(), finishedAt: z.string().nullable() })
  .openapi("RunSummary");
const runsRoute = createRoute({
  method: "get",
  path: "/api/w/{workspaceId}/prospecting/runs",
  middleware: [requirePermission("workspace.read")],
  request: { params: ws },
  responses: { 200: json(z.object({ runs: z.array(RunSummary) }), "The latest runs, newest first"), ...errors },
});
const runRoute = createRoute({
  method: "get",
  path: "/api/w/{workspaceId}/prospecting/runs/{id}",
  middleware: [requirePermission("workspace.read")],
  request: { params: ws.extend({ id: z.uuid() }) },
  responses: { 200: json(Run, "A run and its progress"), ...errors },
});
const checkAgainRoute = createRoute({
  method: "post",
  path: "/api/w/{workspaceId}/prospecting/runs/{id}/check-again",
  middleware: [requirePermission("item.approve")],
  request: { params: ws.extend({ id: z.uuid() }) },
  responses: { 202: json(z.object({ queued: z.number() }), "The checks queued again, one per accepted company"), ...errors },
});
const companiesRoute = createRoute({
  method: "get",
  path: "/api/w/{workspaceId}/prospecting/companies",
  middleware: [requirePermission("workspace.read")],
  request: { params: ws, query: z.object({ cursor: z.uuid().optional(), runId: z.uuid().optional() }) },
  responses: { 200: json(z.object({ companies: z.array(Company), next: z.uuid().nullable() }), "One page of companies"), ...errors },
});

const CohortFilter = z
  .object({
    signals: z.array(z.string()),
    countries: z.array(z.string()),
    kinds: z.array(z.string()),
    sources: z.array(z.string()),
    verification: z.array(z.string()),
    runs: z.array(z.uuid()).openapi({ description: "The searches a company was first found by; empty matches any" }),
    signalMaxAgeDays: z.number().int().optional().openapi({ description: "Only Signals read this many days ago or less; left out matches a Signal of any age" }),
  })
  .openapi("CohortFilter");
const Cohort = z.object({ id: z.uuid(), name: z.string(), filter: CohortFilter, createdBy: z.uuid(), createdAt: z.string(), updatedAt: z.string() }).openapi("Cohort");
const CohortMember = z
  .object({
    addressId: z.uuid(),
    email: z.string(),
    kind: z.string(),
    name: z.string().nullable(),
    role: z.string().nullable(),
    source: z.string(),
    pattern: z.string().nullable(),
    verificationResult: z.string().nullable(),
    verifiedAt: z.string().nullable(),
    company: z.object({ id: z.uuid(), domain: z.string(), name: z.string().nullable(), country: z.string().nullable() }),
    evidence: z.object({ pageUrl: z.string(), readAt: z.string(), snapshotId: z.uuid() }),
  })
  .openapi("CohortMember");
// The filter is checked by parseCohortFilter rather than here, so a bad one is refused with its own reason.
const CohortBody = z.strictObject({ name: z.string().trim().min(1).max(200), filter: z.unknown().openapi({ type: "object", additionalProperties: true, description: "As CohortFilter: each list field a list, plus an optional signalMaxAgeDays; a field left out matches any" }) });
const cohortsRoute = createRoute({
  method: "get",
  path: "/api/w/{workspaceId}/prospecting/cohorts",
  middleware: [requirePermission("workspace.read")],
  request: { params: ws },
  responses: { 200: json(z.object({ cohorts: z.array(Cohort) }), "The Workspace's cohorts"), ...errors },
});
const saveCohortRoute = createRoute({
  method: "post",
  path: "/api/w/{workspaceId}/prospecting/cohorts",
  middleware: [requirePermission("item.edit")],
  request: { params: ws, body: { content: { "application/json": { schema: CohortBody } } } },
  responses: { 200: json(Cohort, "The saved cohort"), ...errors },
});
const countCohortRoute = createRoute({
  method: "post",
  path: "/api/w/{workspaceId}/prospecting/cohorts/count",
  middleware: [requirePermission("workspace.read")],
  request: { params: ws, body: { content: { "application/json": { schema: z.strictObject({ filter: CohortBody.shape.filter }) } } } },
  responses: { 200: json(z.object({ count: z.number() }), "How many the filter matches now; nothing is saved"), ...errors },
});
const updateCohortRoute = createRoute({
  method: "put",
  path: "/api/w/{workspaceId}/prospecting/cohorts/{id}",
  middleware: [requirePermission("item.edit")],
  request: { params: ws.extend({ id: z.uuid() }), body: { content: { "application/json": { schema: CohortBody } } } },
  responses: { 200: json(Cohort, "The changed cohort"), ...errors },
});
const cohortRoute = createRoute({
  method: "get",
  path: "/api/w/{workspaceId}/prospecting/cohorts/{id}",
  middleware: [requirePermission("workspace.read")],
  request: { params: ws.extend({ id: z.uuid() }), query: z.object({ cursor: z.uuid().optional() }) },
  responses: {
    200: json(
      Cohort.extend({
        count: z.number(),
        deliverable: z.number().openapi({ description: "How many it matches whose address last checked deliverable" }),
        inCampaign: z.number().openapi({ description: "Different People a hand-over of this cohort added to a Campaign" }),
        usedBy: z.array(z.object({ campaignId: z.uuid(), title: z.string(), people: z.number(), lastAddedAt: z.string() })).openapi({ description: "The Campaigns it was handed to, latest first" }),
        members: z.array(CohortMember),
        next: z.uuid().nullable(),
      }),
      "A cohort, its numbers now, and one page of who it matches",
    ),
    ...errors,
  },
});

const HandoverResult = z
  .object({
    addressId: z.uuid(),
    email: z.string(),
    status: z.enum(["added", "joined", "conflict", "left_out"]),
    reason: z.string().nullable().openapi({ description: "Why it was left out: not_deliverable, guess_in_canada, suppressed, already_contacted, removed, or why the Campaign refused the row" }),
    personId: z.uuid().nullable(),
    conflictItemId: z.uuid().nullable(),
    missing: z.array(z.string()),
  })
  .openapi("HandoverResult");
const Handover = z
  .object({
    id: z.uuid(),
    cohortId: z.uuid(),
    campaignId: z.uuid(),
    cohortName: z.string(),
    campaignTitle: z.string(),
    status: z.enum(["running", "done", "failed"]),
    failureReason: z.string().nullable().openapi({ description: "Why it stopped before the end, when it failed" }),
    createdAt: z.string(),
    finishedAt: z.string().nullable(),
    counts: z.object({ added: z.number(), joined: z.number(), conflict: z.number(), leftOut: z.number() }),
    results: z.array(HandoverResult),
    next: z.uuid().nullable(),
  })
  .openapi("Handover");
const addToCampaignRoute = createRoute({
  method: "post",
  path: "/api/w/{workspaceId}/prospecting/cohorts/{id}/add-to-campaign",
  middleware: [requirePermission("item.edit")],
  request: { params: ws.extend({ id: z.uuid() }), body: { content: { "application/json": { schema: z.strictObject({ campaignId: z.uuid() }) } } } },
  responses: { 202: json(z.object({ handoverId: z.uuid() }), "The hand-over is queued; read its progress and results from the hand-over"), ...errors },
});
const previewAddRoute = createRoute({
  method: "post",
  path: "/api/w/{workspaceId}/prospecting/cohorts/{id}/add-to-campaign/preview",
  middleware: [requirePermission("item.edit")],
  request: { params: ws.extend({ id: z.uuid() }), body: { content: { "application/json": { schema: z.strictObject({ campaignId: z.uuid() }) } } } },
  responses: {
    200: json(
      z.object({
        added: z.number(),
        skipped: z.array(z.object({ reason: z.string().openapi({ description: "As a hand-over result's reason: not_deliverable, guess_in_canada, suppressed, already_contacted, removed" }), count: z.number() })),
      }).openapi("HandoverPreview"),
      "About how many would go over and why the rest would be left out; nothing is written and no check is paid for",
    ),
    ...errors,
  },
});
const handoverRoute = createRoute({
  method: "get",
  path: "/api/w/{workspaceId}/prospecting/handovers/{id}",
  middleware: [requirePermission("workspace.read")],
  request: { params: ws.extend({ id: z.uuid() }), query: z.object({ cursor: z.uuid().optional() }) },
  responses: { 200: json(Handover, "A hand-over's progress and one page of its results, one per address"), ...errors },
});

const Started = z.object({ runId: z.uuid() }).openapi("ProspectTermsRun");
const ProposedTerms = z
  .object({
    runId: z.uuid(),
    terms: z.array(z.string()),
    objective: z.string().nullable().openapi({ description: "Null when it held Person data and was dropped" }),
    dropped: z.number().openapi({ description: "How many proposed terms held Person data and were dropped" }),
    proposedAt: z.string(),
  })
  .openapi("ProposedTerms");
const draftTermsRoute = createRoute({
  method: "post",
  path: "/api/w/{workspaceId}/prospecting/terms",
  middleware: [requirePermission("item.edit")],
  request: { params: ws },
  responses: { 200: json(Started, "The terms run, new or already going"), 409: json(ErrorBody, "No approved Strategy, or the run was refused"), ...errors },
});
const termsRoute = createRoute({
  method: "get",
  path: "/api/w/{workspaceId}/prospecting/terms",
  middleware: [requirePermission("workspace.read")],
  request: { params: ws },
  responses: { 200: json(z.object({ proposed: ProposedTerms.nullable() }), "The latest proposed terms, or null before any run has proposed some"), ...errors },
});

const refusal = (r: Extract<SaveResult, { ok: false }>) => ({ error: r.reason, ...("field" in r && { field: r.field }), ...("value" in r && { value: r.value }) });

type SearchRefusal = { reason: string; signals?: string[]; terms?: string[]; usd?: number };
const searchRefusal = (r: SearchRefusal) => ({ error: r.reason, ...(r.signals && { signals: r.signals }), ...(r.terms && { terms: r.terms }), ...(r.usd !== undefined && { usd: r.usd }) });

/** With no discovery given, as with no extension installed, search refuses with not_available. */
/** Whether this person's names runs would go to a subscription, read from models by the composition root. */
export type NamesFree = (workspaceId: string, userId: string) => Promise<boolean>;

export function prospectingRoutes(deps: { runs: () => Runs; handovers: () => Handovers; terms: () => Terms; discovery?: () => Discovery; namesFree?: NamesFree }) {
  const namesFree = async (workspaceId: string, userId: string) => (await deps.namesFree?.(workspaceId, userId).catch(() => false)) ?? false;
  const discovery = deps.discovery ?? (() => noDiscovery);
  const app = new OpenAPIHono<MemberEnv>({
    defaultHook: (result, c) => {
      if (!result.success) {
        return c.json({ error: result.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ") }, 400);
      }
    },
  });
  app.openapi(pastedRoute, async (c) => {
    const m = c.get("member");
    const r = await deps.runs().startPasted(m.workspaceId, { ...c.req.valid("json"), userId: m.userId });
    if (r.ok) return c.json({ runId: r.runId, results: r.results }, 200);
    return c.json({ error: r.reason, ...(r.max !== undefined && { max: r.max }), ...(r.signals && { signals: r.signals }) }, 400);
  });
  app.openapi(perCompanyRoute, async (c) => {
    const m = c.get("member");
    const free = await namesFree(m.workspaceId, m.userId);
    return c.json({ usd: perCompanyUsd(free), namesFree: free, searchAvailable: discovery() !== noDiscovery }, 200);
  });
  app.openapi(estimateRoute, async (c) => {
    try {
      const m = c.get("member");
      const r = await estimateSearch(m.workspaceId, discovery(), c.req.valid("json"), await namesFree(m.workspaceId, m.userId));
      if (!r.ok) return c.json(searchRefusal(r), 400);
      const { ok: _, ...estimate } = r;
      return c.json(estimate, 200);
    } catch (e) {
      if (e instanceof NotAvailable) return c.json({ error: e.reason }, 409);
      throw e;
    }
  });
  app.openapi(searchRoute, async (c) => {
    const m = c.get("member");
    try {
      const r = await deps.runs().startSearch(m.workspaceId, discovery(), { ...c.req.valid("json"), userId: m.userId, namesFree: await namesFree(m.workspaceId, m.userId) });
      if (!r.ok) return c.json(searchRefusal(r), 400);
      return c.json({ runId: r.runId, status: r.status, searchUsd: r.searchUsd, results: r.results }, 200);
    } catch (e) {
      if (e instanceof NotAvailable) return c.json({ error: e.reason }, 409);
      throw e;
    }
  });
  app.openapi(runsRoute, async (c) => c.json({ runs: await deps.runs().runs(c.req.valid("param").workspaceId) }, 200));
  app.openapi(runRoute, async (c) => {
    const { workspaceId, id } = c.req.valid("param");
    const run = await deps.runs().run(workspaceId, id);
    return run ? c.json(run, 200) : c.json({ error: "not_found" }, 404);
  });
  app.openapi(checkAgainRoute, async (c) => {
    const { workspaceId, id } = c.req.valid("param");
    const r = await deps.runs().checkAgain(workspaceId, id);
    return r ? c.json(r, 202) : c.json({ error: "not_found" }, 404);
  });
  const cohorts = createCohorts();
  app.openapi(cohortsRoute, async (c) => c.json({ cohorts: await cohorts.list(c.req.valid("param").workspaceId) }, 200));
  app.openapi(saveCohortRoute, async (c) => {
    const m = c.get("member");
    const r = await cohorts.save(m.workspaceId, { ...c.req.valid("json"), userId: m.userId });
    return r.ok ? c.json(r.cohort, 200) : c.json(refusal(r), 400);
  });
  app.openapi(countCohortRoute, async (c) => {
    const r = await cohorts.count(c.req.valid("param").workspaceId, c.req.valid("json").filter);
    return r.ok ? c.json({ count: r.count }, 200) : c.json(refusal(r), 400);
  });
  app.openapi(updateCohortRoute, async (c) => {
    const { workspaceId, id } = c.req.valid("param");
    const r = await cohorts.update(workspaceId, id, c.req.valid("json"));
    if (!r) return c.json({ error: "not_found" }, 404);
    return r.ok ? c.json(r.cohort, 200) : c.json(refusal(r), 400);
  });
  app.openapi(cohortRoute, async (c) => {
    const { workspaceId, id } = c.req.valid("param");
    const found = await cohorts.cohort(workspaceId, id, c.req.valid("query").cursor);
    return found ? c.json(found, 200) : c.json({ error: "not_found" }, 404);
  });
  app.openapi(addToCampaignRoute, async (c) => {
    const m = c.get("member");
    const started = await deps.handovers().start(m.workspaceId, { cohortId: c.req.valid("param").id, campaignId: c.req.valid("json").campaignId, userId: m.userId });
    return started ? c.json(started, 202) : c.json({ error: "not_found" }, 404);
  });
  app.openapi(previewAddRoute, async (c) => {
    const { workspaceId, id } = c.req.valid("param");
    const r = await deps.handovers().preview(workspaceId, { cohortId: id, campaignId: c.req.valid("json").campaignId });
    return r ? c.json(r, 200) : c.json({ error: "not_found" }, 404);
  });
  app.openapi(handoverRoute, async (c) => {
    const { workspaceId, id } = c.req.valid("param");
    const found = await deps.handovers().handover(workspaceId, id, c.req.valid("query").cursor);
    return found ? c.json(found, 200) : c.json({ error: "not_found" }, 404);
  });
  app.openapi(draftTermsRoute, async (c) => {
    const m = c.get("member");
    const r = await deps.terms().draft(m.workspaceId, m.userId);
    return r.ok ? c.json({ runId: r.runId }, 200) : c.json({ error: r.reason }, 409);
  });
  app.openapi(termsRoute, async (c) => c.json({ proposed: await deps.terms().latest(c.req.valid("param").workspaceId) }, 200));
  app.openapi(companiesRoute, async (c) => c.json(await deps.runs().companies(c.req.valid("param").workspaceId, c.req.valid("query").cursor, c.req.valid("query").runId), 200));
  return app;
}
