// SPDX-License-Identifier: AGPL-3.0-only
// Runs and their settings over HTTP. identity's Workspace middleware has already resolved the
// caller. Who started a run comes from the session, never the request.
import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi";
import { can, requirePermission, type MemberEnv } from "../identity/index";
import type { Agents } from "./application/create";
import { BRAND_INPUT } from "./definitions/brand-reader";
import { isIncomplete, type RunStatus } from "./domain/states";

const ErrorBody = z.object({ error: z.string() }).openapi("AgentError");
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
  409: json(ErrorBody, "Can't be done in this state"),
};
const ws = z.object({ workspaceId: z.uuid() });
const one = ws.extend({ id: z.uuid() });
const forAgent = ws.extend({ agent: z.enum(["brand_reader", "strategy_drafter", "plan_drafter", "campaign_drafter", "recipient_reader", "recipient_writer"]) });

const Run = z
  .object({
    id: z.uuid(),
    agent: z.string(),
    status: z.string(),
    statusReason: z.string().nullable(),
    address: z.string().nullable(),
    startedBy: z.uuid().nullable(),
    steps: z.number(),
    costMicros: z.string(),
    /** It ran on a person's subscription, so its cost reads as that rather than $0.00. */
    subscription: z.boolean(),
    tainted: z.boolean(),
    unevaluated: z.boolean(),
    incomplete: z.boolean(),
    proposalCount: z.number(),
    createdAt: z.iso.datetime(),
    endedAt: z.iso.datetime().nullable(),
  })
  .openapi("AgentRun");
const RunDetail = Run.extend({
  read: z.array(z.object({ kind: z.string(), ref: z.string(), trust: z.string(), truncated: z.boolean() })),
  failedPages: z.array(z.object({ address: z.string(), reason: z.string() })),
  log: z.array(z.object({ kind: z.string(), name: z.string(), outcome: z.string(), at: z.iso.datetime() })),
  proposals: z.array(z.object({ kind: z.string(), itemId: z.uuid().nullable(), rejectionCode: z.string().nullable(), incomplete: z.boolean() })),
}).openapi("AgentRunDetail");
const Settings = z.object({ enabled: z.boolean(), maxConcurrentRuns: z.number(), maxDailyRuns: z.number(), revision: z.number() }).openapi("AgentSettings");
const Cap = z.number().int().positive().max(1_000_000);

const startRoute = createRoute({
  method: "post",
  path: "/api/w/{workspaceId}/agents/brand_reader/runs",
  middleware: [requirePermission("item.edit")],
  request: { params: ws, ...body(BRAND_INPUT) },
  responses: { 200: json(Run, "The run, new or already going"), ...errors },
});
const listRoute = createRoute({
  method: "get",
  path: "/api/w/{workspaceId}/agents/runs",
  middleware: [requirePermission("workspace.read")],
  request: { params: ws, query: z.object({ agent: z.string().min(1).max(64).optional() }) },
  responses: { 200: json(z.object({ runs: z.array(Run) }), "Recent runs, newest first"), ...errors },
});
const getRoute = createRoute({
  method: "get",
  path: "/api/w/{workspaceId}/agents/runs/{id}",
  middleware: [requirePermission("workspace.read")],
  request: { params: one },
  responses: { 200: json(RunDetail, "What the run read and did"), ...errors },
});
const cancelRoute = createRoute({
  method: "post",
  path: "/api/w/{workspaceId}/agents/runs/{id}/cancel",
  middleware: [requirePermission("workspace.read")],
  request: { params: one },
  responses: { 200: json(z.object({ ok: z.literal(true) }), "Cancelled"), ...errors },
});
const getSettingsRoute = createRoute({
  method: "get",
  path: "/api/w/{workspaceId}/agents/{agent}/settings",
  middleware: [requirePermission("workspace.read")],
  request: { params: forAgent },
  responses: { 200: json(Settings, "Enabled and run caps"), ...errors },
});
const patchSettingsRoute = createRoute({
  method: "patch",
  path: "/api/w/{workspaceId}/agents/{agent}/settings",
  middleware: [requirePermission("workspace.settings")],
  request: { params: forAgent, ...body(z.strictObject({ enabled: z.boolean().optional(), maxConcurrentRuns: Cap.optional(), maxDailyRuns: Cap.optional() })) },
  responses: { 200: json(Settings, "Saved as a new revision"), ...errors },
});

type Summary = Awaited<ReturnType<Agents["list"]>>[number];
const view = ({ run, costMicros, subscription, proposals }: Summary) => ({
  id: run.id,
  agent: run.agent,
  status: run.status,
  statusReason: run.statusReason,
  address: (run.input as { url?: string }).url ?? null,
  startedBy: run.startedBy,
  steps: run.steps,
  costMicros: String(costMicros),
  subscription,
  tainted: run.tainted,
  unevaluated: run.unevaluated,
  incomplete: isIncomplete(run.status as RunStatus),
  proposalCount: proposals.filter((p) => p.itemId).length,
  createdAt: run.createdAt.toISOString(),
  endedAt: run.endedAt && run.endedAt.toISOString(),
});

// A draft that lost to a person's save: anyone who may read sees it, anyone who may save uses it.
const OfferQuery = z.object({ target: z.enum(["strategy", "plan", "step"]), id: z.uuid().optional(), stepKey: z.string().min(1).optional() });
const offerKey = ws.extend({ runId: z.uuid(), outputKey: z.string().min(1) });
const Offer = z.object({ runId: z.uuid(), outputKey: z.string(), kind: z.string(), body: z.unknown(), at: z.iso.datetime(), costMicros: z.string(), subscription: z.boolean() }).openapi("DraftOffer");
const Done = z.object({ ok: z.literal(true) });
const offerRoute = createRoute({
  method: "get",
  path: "/api/w/{workspaceId}/drafts/offer",
  middleware: [requirePermission("workspace.read")],
  request: { params: ws, query: OfferQuery },
  responses: { 200: json(Offer, "The draft kept for this target"), ...errors },
});
const useOfferRoute = createRoute({
  method: "post",
  path: "/api/w/{workspaceId}/drafts/offer/{runId}/{outputKey}/use",
  middleware: [requirePermission("item.edit")],
  request: { params: offerKey, ...body(z.object({ revision: z.number().int().min(0) })) },
  responses: { 200: json(Done, "The kept draft is now the draft"), ...errors },
});
const dismissOfferRoute = createRoute({
  method: "post",
  path: "/api/w/{workspaceId}/drafts/offer/{runId}/{outputKey}/dismiss",
  middleware: [requirePermission("item.edit")],
  request: { params: offerKey },
  responses: { 200: json(Done, "Dismissed"), ...errors },
});

export function agentRoutes({ agents }: { agents: () => Agents }) {
  const app = new OpenAPIHono<MemberEnv>({
    defaultHook: (result, c) => {
      if (!result.success) {
        return c.json({ error: result.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ") }, 400);
      }
    },
  });

  return app
    .openapi(startRoute, async (c) => {
      const m = c.get("member");
      const r = await agents().start(m.workspaceId, { input: c.req.valid("json"), startedBy: m.userId });
      if (!r.ok) return c.json({ error: r.reason }, 409);
      return c.json(view({ run: r.run, costMicros: 0n, subscription: false, proposals: [] }), 200);
    })
    .openapi(listRoute, async (c) => c.json({ runs: (await agents().list(c.get("member").workspaceId, c.req.valid("query").agent)).map(view) }, 200))
    .openapi(getRoute, async (c) => {
      const d = await agents().get(c.get("member").workspaceId, c.req.valid("param").id);
      if (!d) return c.json({ error: "not_found" }, 404);
      return c.json(
        {
          ...view(d),
          read: d.parts.map((p) => ({ kind: p.kind, ref: p.refId, trust: p.trust, truncated: p.truncated })),
          failedPages: d.events.filter((e) => e.ref).map((e) => ({ address: e.ref!, reason: e.outcome.replace(/^failed:/, "") })),
          log: d.events.map((e) => ({ kind: e.kind, name: e.name, outcome: e.outcome, at: e.at.toISOString() })),
          proposals: d.proposals.map((p) => ({ kind: p.kind, itemId: p.itemId, rejectionCode: p.rejectionCode, incomplete: p.incomplete })),
        },
        200,
      );
    })
    .openapi(cancelRoute, async (c) => {
      const m = c.get("member");
      const r = await agents().cancel(m.workspaceId, c.req.valid("param").id, { userId: m.userId, admin: can(m.role, "workspace.settings") });
      if (r.ok) return c.json({ ok: true as const }, 200);
      if (r.reason === "not_found") return c.json({ error: r.reason }, 404);
      return r.reason === "not_allowed" ? c.json({ error: r.reason }, 403) : c.json({ error: r.reason }, 409);
    })
    .openapi(getSettingsRoute, async (c) => c.json(await agents().settings(c.get("member").workspaceId, c.req.valid("param").agent), 200))
    .openapi(patchSettingsRoute, async (c) => {
      const m = c.get("member");
      const { agent } = c.req.valid("param");
      const r = await agents().changeSettings(m.workspaceId, agent, c.req.valid("json"), m.userId);
      if (!r.ok) return c.json({ error: r.reason }, 400);
      return c.json(await agents().settings(m.workspaceId, agent), 200);
    })
    .openapi(offerRoute, async (c) => {
      const { workspaceId } = c.get("member");
      const q = c.req.valid("query");
      const target = q.target === "strategy" ? { targetKind: q.target, targetId: null, targetStepKey: null } : { targetKind: q.target, targetId: q.id ?? null, targetStepKey: q.target === "step" ? (q.stepKey ?? null) : null };
      if (target.targetKind !== "strategy" && (!target.targetId || (target.targetKind === "step" && !target.targetStepKey))) return c.json({ error: "target_required" }, 400);
      const offer = await agents().offers.read(workspaceId, target);
      if (!offer) return c.json({ error: "not_found" }, 404);
      const run = await agents().get(workspaceId, offer.runId);
      return c.json({ ...offer, at: offer.at.toISOString(), costMicros: String(run?.costMicros ?? 0n), subscription: run?.subscription ?? false }, 200);
    })
    .openapi(useOfferRoute, async (c) => {
      const m = c.get("member");
      const { runId, outputKey } = c.req.valid("param");
      const r = await agents().offers.use(m.workspaceId, { runId, outputKey }, c.req.valid("json").revision, m.userId);
      if (r.ok) return c.json({ ok: true as const }, 200);
      return r.code === "not_found" ? c.json({ error: r.code }, 404) : c.json({ error: r.code }, 409);
    })
    .openapi(dismissOfferRoute, async (c) => {
      const m = c.get("member");
      const r = await agents().offers.dismiss(m.workspaceId, c.req.valid("param"), m.userId);
      return r.ok ? c.json({ ok: true as const }, 200) : c.json({ error: r.code }, 409);
    });
}
