// SPDX-License-Identifier: AGPL-3.0-only
// Standing rules over HTTP. Schemas are strict, so a granter in a request is refused, not ignored.
import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi";
import { requirePermission, requireStepUp, type MemberEnv } from "../identity/index";
import type { StandingRules } from "./application/rules";
import { writerWords, type RuleProducer } from "./domain/cover";

// A refused agent-written grant also says what is missing, or how many approvals there are so far.
const ErrorBody = z.object({ error: z.string(), missing: z.array(z.string()).optional(), count: z.number().optional() }).openapi("StandingRuleError");
const json = <T extends z.ZodType>(schema: T, description: string) => ({ description, content: { "application/json": { schema } } });
const errors = {
  400: json(ErrorBody, "Invalid request"),
  401: json(ErrorBody, "Not signed in"),
  403: json(ErrorBody, "Not allowed, or step-up required"),
  404: json(ErrorBody, "Not found"),
  409: json(ErrorBody, "Refused"),
};
const ws = z.object({ workspaceId: z.uuid() });
const one = ws.extend({ id: z.uuid() });
const Rule = z
  .object({
    id: z.uuid(),
    campaignId: z.uuid(),
    stepKey: z.string(),
    mode: z.enum(["template", "agent_written"]),
    templateRevision: z.number().nullable(),
    dailyCap: z.number().nullable(),
    // The drafter an agent-written rule trusts, in words. Null for a template rule.
    writtenBy: z.string().nullable(),
    expiresAt: z.iso.datetime(),
    grantedBy: z.uuid(),
    granterEmail: z.string().nullable(),
    grantedAt: z.iso.datetime(),
    status: z.enum(["active", "suspended", "revoked", "expired"]),
    suspendedReason: z.string().nullable(),
    // Who stopped a revoked rule and the reason they gave. Null otherwise.
    stoppedByEmail: z.string().nullable(),
    stopReason: z.string().nullable(),
    usedToday: z.number(),
    total: z.number(),
  })
  .openapi("StandingRule");
const Changed = json(z.object({ ok: z.literal(true) }), "Done");
const TemplateGrant = z.strictObject({ campaignId: z.uuid(), stepKey: z.string().min(1).max(200), dailyCap: z.number().int().min(1).max(10_000), expiresAt: z.iso.datetime().optional() });
// No daily cap in this mode, and the person ticked the statement whose version they read.
const AgentGrant = z.strictObject({ mode: z.literal("agent_written"), campaignId: z.uuid(), stepKey: z.string().min(1).max(200), expiresAt: z.iso.datetime().optional(), acknowledged: z.literal(true), wordingVersion: z.string().min(1).max(100) });
const GrantBody = z.union([TemplateGrant, AgentGrant]);
const RevokeBody = z.strictObject({ reason: z.string().trim().min(1).max(500) });

const listRoute = createRoute({ method: "get", path: "/api/w/{workspaceId}/standing-rules", middleware: [requirePermission("workspace.read")], request: { params: ws }, responses: { 200: json(z.object({ rules: z.array(Rule) }), "Every rule in this Workspace"), ...errors } });
const coverageRoute = createRoute({
  method: "get",
  path: "/api/w/{workspaceId}/standing-rules/coverage",
  middleware: [requirePermission("workspace.read")],
  request: { params: ws, query: z.object({ campaignId: z.uuid(), stepKey: z.string().min(1).max(200) }) },
  responses: { 200: json(z.object({ people: z.number(), waiting: z.number() }), "What a rule on this step would cover"), ...errors },
});
const agentOfferRoute = createRoute({
  method: "get",
  path: "/api/w/{workspaceId}/standing-rules/agent-written",
  middleware: [requirePermission("workspace.read")],
  request: { params: ws, query: z.object({ campaignId: z.uuid(), stepKey: z.string().min(1).max(200) }) },
  responses: {
    200: json(z.object({ offered: z.boolean(), missing: z.array(z.string()), approvals: z.number(), needed: z.number(), wordingVersion: z.string(), statements: z.array(z.string()) }), "Whether a rule over agent-written email may be offered on this step"),
    ...errors,
  },
});
const grantRoute = createRoute({
  method: "post",
  path: "/api/w/{workspaceId}/standing-rules",
  middleware: [requirePermission("rule.grant"), requireStepUp()],
  request: { params: ws, body: { content: { "application/json": { schema: GrantBody } } } },
  responses: { 200: Changed, ...errors },
});
const reconfirmRoute = createRoute({ method: "post", path: "/api/w/{workspaceId}/standing-rules/{id}/reconfirm", middleware: [requirePermission("rule.grant"), requireStepUp()], request: { params: one }, responses: { 200: Changed, ...errors } });
// Any Member may stop a rule, with no step-up: stopping must never be harder than starting.
const revokeRoute = createRoute({
  method: "post",
  path: "/api/w/{workspaceId}/standing-rules/{id}/revoke",
  middleware: [requirePermission("workspace.read")],
  request: { params: one, body: { required: true, content: { "application/json": { schema: RevokeBody } } } },
  responses: { 200: Changed, ...errors },
});

const writtenBy = (producer: unknown) => {
  const w = (producer as RuleProducer | null)?.writer;
  return w ? writerWords(w) : null;
};

export function standingRuleRoutes({ rules }: { rules: () => StandingRules }) {
  const app = new OpenAPIHono<MemberEnv>({
    defaultHook: (result, c) => {
      if (!result.success) return c.json({ error: result.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ") }, 400);
    },
  });
  const answer = (c: { json: (b: unknown, s: number) => unknown }, r: { ok: true } | { ok: false; reason: string; missing?: readonly string[]; count?: number }) =>
    r.ok
      ? c.json({ ok: true }, 200)
      : c.json({ error: r.reason, ...(r.missing ? { missing: [...r.missing] } : {}), ...(r.count !== undefined ? { count: r.count } : {}) }, r.reason === "not_found" ? 404 : r.reason === "forbidden" ? 403 : 409);

  return app
    .openapi(listRoute, async (c) => {
      const list = await rules().list(c.get("member").workspaceId);
      return c.json({ rules: list.map((r) => ({ id: r.id, campaignId: r.campaignId, stepKey: r.stepKey, mode: r.mode as "template", writtenBy: writtenBy(r.producer), templateRevision: r.templateRevision, dailyCap: r.dailyCap, expiresAt: r.expiresAt.toISOString(), grantedBy: r.grantedBy, granterEmail: r.granterEmail, grantedAt: r.grantedAt.toISOString(), status: r.status as "active", suspendedReason: r.suspendedReason, stoppedByEmail: r.stoppedByEmail, stopReason: r.stopReason, usedToday: r.usedToday, total: r.total })) }, 200);
    })
    .openapi(coverageRoute, async (c) => {
      const q = c.req.valid("query");
      return c.json(await rules().coverage(c.get("member").workspaceId, q.campaignId, q.stepKey), 200);
    })
    .openapi(agentOfferRoute, async (c) => {
      const q = c.req.valid("query");
      return c.json(await rules().agentWrittenOffer(c.get("member").workspaceId, q.campaignId, q.stepKey), 200);
    })
    .openapi(grantRoute, async (c) => {
      const m = c.get("member");
      const body = c.req.valid("json");
      const expiresAt = body.expiresAt ? new Date(body.expiresAt) : undefined;
      if ("mode" in body) return answer(c as never, await rules().grantAgentWritten(m.workspaceId, { campaignId: body.campaignId, stepKey: body.stepKey, expiresAt, wordingVersion: body.wordingVersion }, { userId: m.userId })) as never;
      return answer(c as never, await rules().grant(m.workspaceId, { campaignId: body.campaignId, stepKey: body.stepKey, dailyCap: body.dailyCap, expiresAt }, { userId: m.userId })) as never;
    })
    .openapi(reconfirmRoute, async (c) => {
      const m = c.get("member");
      return answer(c as never, await rules().reconfirm(m.workspaceId, c.req.valid("param").id, { userId: m.userId })) as never;
    })
    .openapi(revokeRoute, async (c) => {
      const m = c.get("member");
      return answer(c as never, await rules().revoke(m.workspaceId, c.req.valid("param").id, { userId: m.userId }, c.req.valid("json").reason)) as never;
    });
}
