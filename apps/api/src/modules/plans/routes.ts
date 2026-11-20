// SPDX-License-Identifier: AGPL-3.0-only
// Strategy and marketing plans over HTTP. identity's Workspace middleware has already resolved the
// caller, and the actor comes from the session. Approving and dismissing are items routes.
import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi";
import { draftRuns, type StartDraft } from "./application/draft-runs";
import { requirePermission, type MemberEnv } from "../identity/index";
import type { Plans } from "./application/create";

// A draft can be partial, so it has no shape here; submitting checks it in full.
const MAX_DRAFT_CHARS = 200_000;

const ErrorBody = z.object({ error: z.string(), missing: z.array(z.object({ path: z.string(), message: z.string() })).optional() }).openapi("PlanError");
const json = <T extends z.ZodType>(schema: T, description: string) => ({
  description,
  content: { "application/json": { schema } },
});
const body = <T extends z.ZodType>(schema: T) => ({ body: { content: { "application/json": { schema } } } });
const errors = {
  400: json(ErrorBody, "Invalid request"),
  401: json(ErrorBody, "Not signed in"),
  403: json(ErrorBody, "Not allowed"),
  404: json(ErrorBody, "Not found"),
  409: json(ErrorBody, "Refused, with a named reason"),
};
const ws = z.object({ workspaceId: z.uuid() });
const one = ws.extend({ id: z.uuid() });
const lineKey = z.string().regex(/^[a-z0-9_-]{1,64}$/);

const Missing = z.array(z.object({ path: z.string(), message: z.string() }));
const Waiting = z.object({ id: z.uuid(), revision: z.number(), version: z.number(), warnings: z.array(z.string()) }).nullable();
const Version = z.object({ version: z.number(), baseVersion: z.number().nullable(), body: z.any(), actorUserId: z.string(), at: z.iso.datetime() }).openapi("PlanVersionRow");
// What a cited reading says, for its label. An id this Workspace doesn't have is found: false, with nulls.
const CitedReading = z
  .object({ id: z.string(), found: z.boolean(), measureLabel: z.string().nullable(), value: z.string().nullable(), source: z.enum(["person", "system"]).nullable(), observedOn: z.string().nullable(), newer: z.boolean() })
  .openapi("CitedReading");
const Strategy = z
  .object({
    id: z.uuid().nullable(),
    currentVersion: z.number().nullable(),
    current: z.any(),
    draft: z.any(),
    draftRevision: z.number(),
    missing: Missing,
    waiting: Waiting,
    notes: z.array(z.object({ kind: z.literal("reading_changed"), readingId: z.string() })),
    citedReadings: z.array(CitedReading),
  })
  .openapi("Strategy");
const PlanSummary = z.object({ id: z.uuid(), title: z.string(), request: z.string().nullable(), currentVersion: z.number().nullable() }).openapi("PlanSummary");
// A plan's row in the list: dates, first measure and channels from its approved version, all empty for a draft.
const ListedPlan = PlanSummary.extend({
  startsOn: z.string().nullable(),
  endsOn: z.string().nullable(),
  measure: z.object({ label: z.string(), target: z.string(), value: z.string().nullable() }).nullable(),
  channels: z.array(z.string()),
}).openapi("ListedPlan");
const Plan = PlanSummary.extend({
  archived: z.boolean(),
  current: z.any(),
  draft: z.any(),
  draftRevision: z.number(),
  strategyVersion: z.number().nullable(),
  missing: Missing,
  waiting: Waiting,
  tracking: z.any(),
  notes: z.array(z.object({ kind: z.enum(["strategy_changed", "fact_changed", "reading_changed"]), factId: z.string().optional(), readingId: z.string().optional() })),
  citedReadings: z.array(CitedReading),
}).openapi("Plan");
const Saved = z.object({ revision: z.number(), missing: Missing }).openapi("PlanDraftSaved");
const Submitted = z.object({ version: z.number(), itemId: z.uuid() }).openapi("PlanSubmitted");
const Draft = z.strictObject({
  revision: z.number().int().nonnegative(),
  body: z.any().refine((v) => JSON.stringify(v ?? null).length <= MAX_DRAFT_CHARS, "draft_too_large"),
});
const Submit = z.strictObject({ revision: z.number().int().nonnegative() });

const strategyRoute = createRoute({ method: "get", path: "/api/w/{workspaceId}/strategy", middleware: [requirePermission("workspace.read")], request: { params: ws }, responses: { 200: json(Strategy, "Current, draft and what waits"), ...errors } });
const strategyVersionsRoute = createRoute({ method: "get", path: "/api/w/{workspaceId}/strategy/versions", middleware: [requirePermission("workspace.read")], request: { params: ws }, responses: { 200: json(z.object({ versions: z.array(Version) }), "Every version, oldest first"), ...errors } });
const strategyDraftRoute = createRoute({ method: "put", path: "/api/w/{workspaceId}/strategy/draft", middleware: [requirePermission("item.edit")], request: { params: ws, ...body(Draft) }, responses: { 200: json(Saved, "Saved"), ...errors } });
const strategySubmitRoute = createRoute({ method: "post", path: "/api/w/{workspaceId}/strategy/submit", middleware: [requirePermission("item.edit")], request: { params: ws, ...body(Submit) }, responses: { 200: json(Submitted, "A version, waiting for a person"), ...errors } });
const plansRoute = createRoute({ method: "get", path: "/api/w/{workspaceId}/plans", middleware: [requirePermission("workspace.read")], request: { params: ws }, responses: { 200: json(z.object({ plans: z.array(ListedPlan) }), "Plans not archived, newest first"), ...errors } });
const createPlanRoute = createRoute({
  method: "post",
  path: "/api/w/{workspaceId}/plans",
  middleware: [requirePermission("item.edit")],
  request: { params: ws, ...body(z.strictObject({ title: z.string().trim().min(1).max(200), request: z.string().trim().max(1000).optional() })) },
  responses: { 200: json(PlanSummary, "Created, with an empty draft"), ...errors },
});
const planRoute = createRoute({ method: "get", path: "/api/w/{workspaceId}/plans/{id}", middleware: [requirePermission("workspace.read")], request: { params: one }, responses: { 200: json(Plan, "One plan and how it's going"), ...errors } });
const planVersionsRoute = createRoute({ method: "get", path: "/api/w/{workspaceId}/plans/{id}/versions", middleware: [requirePermission("workspace.read")], request: { params: one }, responses: { 200: json(z.object({ versions: z.array(Version) }), "Every version, oldest first"), ...errors } });
const planDraftRoute = createRoute({ method: "put", path: "/api/w/{workspaceId}/plans/{id}/draft", middleware: [requirePermission("item.edit")], request: { params: one, ...body(Draft) }, responses: { 200: json(Saved, "Saved"), ...errors } });
const planSubmitRoute = createRoute({ method: "post", path: "/api/w/{workspaceId}/plans/{id}/submit", middleware: [requirePermission("item.edit")], request: { params: one, ...body(Submit) }, responses: { 200: json(Submitted, "A version, waiting for a person"), ...errors } });
// Ideas: a sentence saved to start a Campaign from later. Not Items, so they never count as waiting.
const Idea = z.object({ id: z.uuid(), text: z.string(), createdBy: z.uuid(), createdAt: z.iso.datetime() }).openapi("Idea");
const StartedIdea = Idea.extend({ planId: z.uuid(), planTitle: z.string(), startedAt: z.iso.datetime() }).openapi("StartedIdea");
const idea = ws.extend({ id: z.uuid() });
const ideasRoute = createRoute({ method: "get", path: "/api/w/{workspaceId}/ideas", middleware: [requirePermission("workspace.read")], request: { params: ws }, responses: { 200: json(z.object({ open: z.array(Idea), started: z.array(StartedIdea) }), "Open Ideas, newest first, then those started in the last 14 days"), ...errors } });
const addIdeaRoute = createRoute({ method: "post", path: "/api/w/{workspaceId}/ideas", middleware: [requirePermission("item.edit")], request: { params: ws, ...body(z.strictObject({ text: z.string().trim().min(1).max(500) })) }, responses: { 200: json(Idea, "Saved"), ...errors } });
const dismissIdeaRoute = createRoute({ method: "post", path: "/api/w/{workspaceId}/ideas/{id}/dismiss", middleware: [requirePermission("item.edit")], request: { params: idea }, responses: { 200: json(z.object({ ok: z.literal(true) }), "Hidden; the row stays"), ...errors } });
const startedIdeaRoute = createRoute({ method: "post", path: "/api/w/{workspaceId}/ideas/{id}/started", middleware: [requirePermission("item.edit")], request: { params: idea, ...body(z.strictObject({ planId: z.uuid() })) }, responses: { 200: json(z.object({ ok: z.literal(true) }), "Linked to the plan started from it"), ...errors } });
const archiveRoute = createRoute({ method: "post", path: "/api/w/{workspaceId}/plans/{id}/archive", middleware: [requirePermission("item.edit")], request: { params: one }, responses: { 200: json(z.object({ ok: z.literal(true) }), "Hidden; every version stays"), ...errors } });
const progressRoute = createRoute({
  method: "post",
  path: "/api/w/{workspaceId}/plans/{id}/steps/{key}/progress",
  middleware: [requirePermission("item.edit")],
  request: { params: one.extend({ key: lineKey }), ...body(z.strictObject({ status: z.enum(["open", "done", "skipped"]) })) },
  responses: { 200: json(z.object({ ok: z.literal(true) }), "Recorded"), ...errors },
});
const readingRoute = createRoute({
  method: "post",
  path: "/api/w/{workspaceId}/plans/{id}/measures/{key}/readings",
  middleware: [requirePermission("item.edit")],
  request: { params: one.extend({ key: lineKey }), ...body(z.strictObject({ value: z.string().max(200), observedOn: z.iso.date(), note: z.string().max(500).optional() })) },
  responses: { 200: json(z.object({ ok: z.literal(true) }), "Recorded"), ...errors },
});

const Started = z.object({ runId: z.uuid() }).openapi("PlanDraftRun");
const strategyDraftRunRoute = createRoute({
  method: "post",
  path: "/api/w/{workspaceId}/strategy/draft-run",
  middleware: [requirePermission("item.edit")],
  request: { params: ws, ...body(z.strictObject({ request: z.string().trim().min(1).max(1000) })) },
  responses: { 200: json(Started, "The run, new or already going"), ...errors },
});
const planDraftRunRoute = createRoute({ method: "post", path: "/api/w/{workspaceId}/plans/{id}/draft-run", middleware: [requirePermission("item.edit")], request: { params: one }, responses: { 200: json(Started, "The run, new or already going"), ...errors } });


const asVersion = (v: { version: number; baseVersion: number | null; body: unknown; actorUserId: string; at: Date }) => ({ version: v.version, baseVersion: v.baseVersion, body: v.body, actorUserId: v.actorUserId, at: v.at.toISOString() });
const asSummary = (p: { id: string; title: string; request: string | null; currentVersion: number | null }) => ({ id: p.id, title: p.title, request: p.request, currentVersion: p.currentVersion });

type Refusal = { reason: string; missing?: { path: string; message: string }[] };
const refused = (r: Refusal) => ({ error: r.reason, ...(r.missing && { missing: r.missing }) });
const status = (reason: string) => (reason === "not_found" ? 404 : reason === "blank_value" ? 400 : 409);

export function planRoutes({ plans, startDraft }: { plans: () => Plans; startDraft: StartDraft }) {
  const runs = draftRuns({ plans, startDraft });
  const app = new OpenAPIHono<MemberEnv>({
    defaultHook: (result, c) => {
      if (!result.success) {
        return c.json({ error: result.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ") }, 400);
      }
    },
  });

  return app
    .openapi(strategyDraftRunRoute, async (c) => {
      const m = c.get("member");
      const r = await runs.strategy(m.workspaceId, c.req.valid("json").request, { startedBy: m.userId });
      return r.ok ? c.json({ runId: r.run.id }, 200) : c.json(refused(r), 409);
    })
    .openapi(planDraftRunRoute, async (c) => {
      const m = c.get("member");
      const r = await runs.plan(m.workspaceId, c.req.valid("param").id, { startedBy: m.userId });
      return r.ok ? c.json({ runId: r.run.id }, 200) : c.json(refused(r), status(r.reason));
    })
    .openapi(strategyRoute, async (c) => c.json(await plans().strategy(c.get("member").workspaceId), 200))
    .openapi(strategyVersionsRoute, async (c) => c.json({ versions: (await plans().strategyVersions(c.get("member").workspaceId)).map(asVersion) }, 200))
    .openapi(strategyDraftRoute, async (c) => {
      const r = await plans().saveStrategyDraft(c.get("member").workspaceId, c.req.valid("json"));
      return r.ok ? c.json({ revision: r.revision, missing: r.missing }, 200) : c.json(refused(r), 409);
    })
    .openapi(strategySubmitRoute, async (c) => {
      const m = c.get("member");
      const r = await plans().submitStrategy(m.workspaceId, { revision: c.req.valid("json").revision, actor: { userId: m.userId } });
      return r.ok ? c.json({ version: r.version, itemId: r.item.id }, 200) : c.json(refused(r), status(r.reason));
    })
    .openapi(plansRoute, async (c) => c.json({ plans: (await plans().plans(c.get("member").workspaceId)).map((p) => ({ ...asSummary(p), startsOn: p.startsOn, endsOn: p.endsOn, measure: p.measure, channels: p.channels })) }, 200))
    .openapi(createPlanRoute, async (c) => {
      const m = c.get("member");
      return c.json(asSummary(await plans().createPlan(m.workspaceId, { ...c.req.valid("json"), createdBy: m.userId })), 200);
    })
    .openapi(planRoute, async (c) => {
      const p = await plans().plan(c.get("member").workspaceId, c.req.valid("param").id);
      if (!p) return c.json({ error: "not_found" }, 404);
      return c.json({ ...asSummary(p), archived: p.archivedAt !== null, current: p.current, draft: p.draft, draftRevision: p.draftRevision, strategyVersion: p.strategyVersion, missing: p.missing, waiting: p.waiting, tracking: p.tracking, notes: p.notes, citedReadings: p.citedReadings }, 200);
    })
    .openapi(planVersionsRoute, async (c) => {
      const rows = await plans().planVersions(c.get("member").workspaceId, c.req.valid("param").id);
      return c.json({ versions: rows.map(asVersion) }, 200);
    })
    .openapi(planDraftRoute, async (c) => {
      const r = await plans().savePlanDraft(c.get("member").workspaceId, c.req.valid("param").id, c.req.valid("json"));
      return r.ok ? c.json({ revision: r.revision, missing: r.missing }, 200) : c.json(refused(r), status(r.reason));
    })
    .openapi(planSubmitRoute, async (c) => {
      const m = c.get("member");
      const r = await plans().submitPlan(m.workspaceId, c.req.valid("param").id, { revision: c.req.valid("json").revision, actor: { userId: m.userId } });
      return r.ok ? c.json({ version: r.version, itemId: r.item.id }, 200) : c.json(refused(r), status(r.reason));
    })
    .openapi(ideasRoute, async (c) => c.json(await plans().ideas(c.get("member").workspaceId), 200))
    .openapi(addIdeaRoute, async (c) => {
      const m = c.get("member");
      return c.json(await plans().addIdea(m.workspaceId, { text: c.req.valid("json").text, userId: m.userId }), 200);
    })
    .openapi(dismissIdeaRoute, async (c) => {
      const r = await plans().dismissIdea(c.get("member").workspaceId, c.req.valid("param").id);
      return r.ok ? c.json({ ok: true as const }, 200) : c.json({ error: r.reason }, 404);
    })
    .openapi(startedIdeaRoute, async (c) => {
      const r = await plans().startIdea(c.get("member").workspaceId, c.req.valid("param").id, c.req.valid("json").planId);
      return r.ok ? c.json({ ok: true as const }, 200) : c.json({ error: r.reason }, r.reason === "not_found" ? 404 : 409);
    })
    .openapi(archiveRoute, async (c) => {
      const r = await plans().archivePlan(c.get("member").workspaceId, c.req.valid("param").id);
      return r.ok ? c.json({ ok: true as const }, 200) : c.json(refused(r), 404);
    })
    .openapi(progressRoute, async (c) => {
      const m = c.get("member");
      const { id, key } = c.req.valid("param");
      const r = await plans().markStep(m.workspaceId, id, { stepKey: key, status: c.req.valid("json").status, actor: { userId: m.userId } });
      return r.ok ? c.json({ ok: true as const }, 200) : c.json(refused(r), status(r.reason));
    })
    .openapi(readingRoute, async (c) => {
      const m = c.get("member");
      const { id, key } = c.req.valid("param");
      const r = await plans().recordReading(m.workspaceId, id, { measureKey: key, ...c.req.valid("json"), actor: { userId: m.userId } });
      return r.ok ? c.json({ ok: true as const }, 200) : c.json(refused(r), status(r.reason));
    });
}
