// SPDX-License-Identifier: AGPL-3.0-only
// Models over HTTP. identity's Workspace middleware has already resolved the caller, and
// each route declares its permission. Amounts are strings of micro-dollars, since they are
// bigints. No response carries a key, a prompt or a reply.
import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi";
import type { Vault } from "../credentials/index";
import { requirePermission, requireStepUp, type MemberEnv, type Permission, type StepUpWindow } from "../identity/index";
import type { Models } from "./application/generate";
import { changeSettings, connect, disconnect, listProviders, readSettings, recentCalls, usage, type SettingsRefusal } from "./application/settings";
import type { Deployment } from "./domain/budget";
import { CLI_PROVIDERS, PROVIDERS } from "./domain/routes-check";
import { beginSignIn, chooseAdapter, chooseForAgent, finishSignIn, listAdapters, removeSignIn, testAdapter, type AdapterRefusal, type Evaluated, type OnUnevaluated, type OverrideAllowed, type SignInNeeds } from "./application/sign-ins";

const ErrorBody = z.object({ error: z.string() }).openapi("Error");
const json = <T extends z.ZodType>(schema: T, description: string) => ({
  description,
  content: { "application/json": { schema } },
});
const body = <T extends z.ZodType>(schema: T) => ({ body: { content: { "application/json": { schema } } } });
const errors = {
  400: json(ErrorBody, "Invalid request"),
  401: json(ErrorBody, "Not signed in"),
  403: json(ErrorBody, "Not allowed, or step-up required"),
  404: json(ErrorBody, "Not found"),
  409: json(ErrorBody, "Refused by a rule"),
};
// A window for each step-up check (ADR 0037 rule 004): short for keys and sign-ins, long for settings and choices.
const guard = (p: Permission, stepUp?: StepUpWindow) => (stepUp ? [requirePermission(p), requireStepUp(stepUp)] : [requirePermission(p)]);

const Provider = z.enum(PROVIDERS).openapi("ModelProvider");
const ws = z.object({ workspaceId: z.uuid() });
const one = ws.extend({ provider: Provider });
const Micros = z.string().regex(/^\d+$/);

const ProviderRow = z
  .object({ provider: Provider, connected: z.boolean(), credentialId: z.uuid().nullable(), credentialName: z.string().nullable() })
  .openapi("ModelProviderRow");
const Settings = z.object({ monthlyBudgetMicros: Micros, allowUnpriced: z.boolean() }).openapi("ModelSettings");
const Usage = z
  .object({
    month: z.string(),
    settledMicros: Micros,
    heldMicros: Micros,
    budgetMicros: Micros,
    incidents: z.array(z.object({ threshold: z.number(), openedAt: z.iso.datetime() })),
    rows: z.array(z.object({ purpose: z.string(), model: z.string().nullable(), calls: z.number(), costMicros: Micros })),
  })
  .openapi("ModelUsage");
const Call = z
  .object({
    id: z.uuid(),
    purpose: z.string(),
    model: z.string().nullable(),
    status: z.string(),
    refusal: z.string().nullable(),
    errorFamily: z.string().nullable(),
    trust: z.string(),
    inputTokens: z.number().nullable(),
    outputTokens: z.number().nullable(),
    costMicros: Micros.nullable(),
    costStatus: z.string().nullable(),
    createdAt: z.iso.datetime(),
  })
  .openapi("ModelCall");
const TestResult = z.object({ ok: z.boolean(), reason: z.string().nullable(), callId: z.uuid().nullable() }).openapi("ModelConnectionTest");
const Ok = z.object({ ok: z.literal(true) }).openapi("Ok");

const listRoute = createRoute({
  method: "get",
  path: "/api/w/{workspaceId}/models/connections",
  request: { params: ws },
  middleware: guard("workspace.read"),
  responses: { 200: json(z.object({ deployment: z.enum(["cloud", "self_host"]), providers: z.array(ProviderRow) }), "Providers and their keys, never a key"), ...errors },
});
const putRoute = createRoute({
  method: "put",
  path: "/api/w/{workspaceId}/models/connections/{provider}",
  request: { params: one, ...body(z.object({ credentialId: z.uuid() })) },
  middleware: guard("workspace.settings", "short"),
  responses: { 200: json(Ok, "Connected"), ...errors },
});
const deleteRoute = createRoute({
  method: "delete",
  path: "/api/w/{workspaceId}/models/connections/{provider}",
  request: { params: one },
  middleware: guard("workspace.settings", "short"),
  responses: { 200: json(Ok, "Disconnected"), ...errors },
});
const testRoute = createRoute({
  method: "post",
  path: "/api/w/{workspaceId}/models/connections/{provider}/test",
  request: { params: one },
  middleware: guard("workspace.settings"),
  responses: { 200: json(TestResult, "One small real call, recorded like any other"), ...errors },
});
const getSettingsRoute = createRoute({
  method: "get",
  path: "/api/w/{workspaceId}/models/settings",
  request: { params: ws },
  middleware: guard("workspace.read"),
  responses: { 200: json(Settings, "The current settings"), ...errors },
});
const putSettingsRoute = createRoute({
  method: "put",
  path: "/api/w/{workspaceId}/models/settings",
  request: { params: ws, ...body(Settings) },
  middleware: guard("workspace.settings", "long"),
  responses: { 200: json(Settings, "Saved as a new revision"), ...errors },
});
const usageRoute = createRoute({
  method: "get",
  path: "/api/w/{workspaceId}/models/usage",
  request: { params: ws, query: z.object({ month: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/).optional() }) },
  middleware: guard("workspace.read"),
  responses: { 200: json(Usage, "A UTC month's model cost, for information"), ...errors },
});
const callsRoute = createRoute({
  method: "get",
  path: "/api/w/{workspaceId}/models/calls",
  request: { params: ws, query: z.object({ before: z.iso.datetime().optional() }) },
  middleware: guard("workspace.read"),
  responses: { 200: json(z.object({ calls: z.array(Call) }), "The newest calls"), ...errors },
});

const Adapter = z.enum(CLI_PROVIDERS).openapi("ModelAdapterId");
const forAdapter = ws.extend({ adapter: Adapter });
const Choice = z.strictObject({ adapter: z.enum(CLI_PROVIDERS).nullable(), model: z.string().min(1).max(100).nullable() });
/** Self-host takes a Claude Code or Codex adapter; cloud takes a provider from the agent's route. */
const AgentChoice = z.strictObject({ adapter: z.enum([...CLI_PROVIDERS, ...PROVIDERS]).nullable(), model: z.string().min(1).max(100).nullable() });
const Saved = z.object({ ok: z.literal(true), suspendedRules: z.number() }).openapi("ModelChoiceSaved");
const AdapterRow = z
  .object({
    id: Adapter,
    label: z.string(),
    signIn: z.enum(["device", "setup_token"]),
    models: z.array(z.string()),
    blocked: z.string().nullable(),
    shared: z.boolean(),
    mine: z.boolean(),
    signedOut: z.boolean(),
    evaluated: z.boolean(),
    writing: z.array(z.string()).openapi({ description: "Models the plan, Campaign and email drafters all have a passing eval for" }),
  })
  .openapi("ModelAdapter");
const SignInStart = z.object({ id: z.uuid(), link: z.string(), userCode: z.string().nullable() }).openapi("ModelSignInStart");
const scopes = ["shared", "personal"] as const;
const signInStart = (scope: (typeof scopes)[number]) =>
  createRoute({
    method: "post",
    path: `/api/w/{workspaceId}/models/adapters/{adapter}/sign-in/${scope}`,
    request: { params: forAdapter },
    middleware: scope === "shared" ? guard("workspace.settings", "short") : guard("workspace.read", "short"),
    responses: { 200: json(SignInStart, "The link to open, shown once"), ...errors },
  });
const signInEnd = (scope: (typeof scopes)[number]) =>
  createRoute({
    method: "delete",
    path: `/api/w/{workspaceId}/models/adapters/{adapter}/sign-in/${scope}`,
    request: { params: forAdapter },
    middleware: scope === "shared" ? guard("workspace.settings", "short") : guard("workspace.read", "short"),
    responses: { 200: json(Ok, "Signed out"), ...errors },
  });
const adaptersRoute = createRoute({
  method: "get",
  path: "/api/w/{workspaceId}/models/adapters",
  request: { params: ws },
  middleware: guard("workspace.read"),
  responses: {
    200: json(
      z.object({
        choice: z.object({ adapter: z.string(), model: z.string().nullable(), evaluated: z.boolean() }).nullable(),
        agents: z.array(z.object({ agent: z.string(), adapter: z.string(), model: z.string().nullable(), evaluated: z.boolean() })),
        adapters: z.array(AdapterRow),
      }),
      "Which AI runs, and what's available. Self-host only",
    ),
    ...errors,
  },
});
const chooseRoute = createRoute({
  method: "put",
  path: "/api/w/{workspaceId}/models/adapter",
  request: { params: ws, ...body(Choice) },
  middleware: guard("workspace.settings", "long"),
  responses: { 200: json(Saved, "Saved, with how many standing rules were paused until a person re-confirms them"), ...errors },
});
const chooseAgentRoute = createRoute({
  method: "put",
  path: "/api/w/{workspaceId}/models/agents/{agent}/adapter",
  request: { params: ws.extend({ agent: z.string().min(1).max(100) }), ...body(AgentChoice) },
  middleware: guard("workspace.settings", "long"),
  responses: { 200: json(Saved, "Saved; a null adapter goes back to the default and resumes nothing"), ...errors },
});
const finishRoute = createRoute({
  method: "post",
  path: "/api/w/{workspaceId}/models/sign-ins/{id}/finish",
  request: { params: ws.extend({ id: z.uuid() }), ...body(z.strictObject({ code: z.string().min(1).max(2048).nullable() })) },
  middleware: guard("workspace.read", "short"),
  responses: { 200: json(Ok, "Stored in the vault"), ...errors },
});
const testAdapterRoute = createRoute({
  method: "post",
  path: "/api/w/{workspaceId}/models/adapters/{adapter}/test",
  request: { params: forAdapter },
  middleware: guard("workspace.read"),
  responses: { 200: json(z.object({ ok: z.boolean(), reason: z.string().nullable() }), "Real calls, recorded like any other"), ...errors },
});

const PAGE = 50;

export type ModelRouteDeps = { models: () => Models; vault: () => Vault; deployment: () => Deployment; needs: SignInNeeds; onUnevaluated?: OnUnevaluated; evaluated?: Evaluated; overrideAllowed?: OverrideAllowed; now?: () => Date };

export function modelRoutes({ models, vault, deployment, needs, onUnevaluated, evaluated, overrideAllowed, now = () => new Date() }: ModelRouteDeps) {
  const app = new OpenAPIHono<MemberEnv>({
    defaultHook: (result, c) => {
      if (!result.success) {
        return c.json({ error: result.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ") }, 400);
      }
    },
  });
  const refused = (r: SettingsRefusal | AdapterRefusal) => ({ error: r });

  const start = (shared: boolean) => async (c: { get(k: "member"): { workspaceId: string; userId: string } }, adapter: (typeof CLI_PROVIDERS)[number]) => {
    const m = c.get("member");
    return beginSignIn({ deployment: deployment(), workspaceId: m.workspaceId, userId: m.userId, provider: adapter, shared });
  };
  const end = (c: { get(k: "member"): { workspaceId: string; userId: string } }, provider: (typeof CLI_PROVIDERS)[number], ownerUserId: string | null) => {
    const m = c.get("member");
    return removeSignIn({ deployment: deployment(), vault, workspaceId: m.workspaceId, provider, ownerUserId, actorUserId: m.userId });
  };

  return app
    .openapi(adaptersRoute, async (c) => {
      const m = c.get("member");
      const r = await listAdapters(deployment(), m.workspaceId, m.userId, evaluated);
      return r === "cloud_managed" ? c.json(refused(r), 409) : c.json(r, 200);
    })
    .openapi(chooseRoute, async (c) => {
      const m = c.get("member");
      const r = await chooseAdapter({ onUnevaluated, evaluated, deployment: deployment(), workspaceId: m.workspaceId, actorUserId: m.userId, ...c.req.valid("json"), now: now() });
      return typeof r === "string" ? c.json(refused(r), 409) : c.json({ ok: true as const, ...r }, 200);
    })
    .openapi(chooseAgentRoute, async (c) => {
      const m = c.get("member");
      const r = await chooseForAgent({ onUnevaluated, evaluated, overrideAllowed, deployment: deployment(), workspaceId: m.workspaceId, actorUserId: m.userId, agent: c.req.valid("param").agent, ...c.req.valid("json"), now: now() });
      return typeof r === "string" ? c.json(refused(r), 409) : c.json({ ok: true as const, ...r }, 200);
    })
    .openapi(signInStart("shared"), async (c) => {
      const r = await start(true)(c, c.req.valid("param").adapter);
      return r.ok ? c.json({ id: r.id, link: r.link, userCode: r.userCode }, 200) : c.json(refused(r.reason), 409);
    })
    .openapi(signInStart("personal"), async (c) => {
      const r = await start(false)(c, c.req.valid("param").adapter);
      return r.ok ? c.json({ id: r.id, link: r.link, userCode: r.userCode }, 200) : c.json(refused(r.reason), 409);
    })
    .openapi(signInEnd("shared"), async (c) => {
      const r = await end(c, c.req.valid("param").adapter, null);
      return r ? c.json(refused(r), 409) : c.json({ ok: true as const }, 200);
    })
    .openapi(signInEnd("personal"), async (c) => {
      const r = await end(c, c.req.valid("param").adapter, c.get("member").userId);
      return r ? c.json(refused(r), 409) : c.json({ ok: true as const }, 200);
    })
    .openapi(finishRoute, async (c) => {
      const m = c.get("member");
      const r = await finishSignIn({ vault, workspaceId: m.workspaceId, userId: m.userId, id: c.req.valid("param").id, code: c.req.valid("json").code, now: now(), clearNeeds: needs.clear });
      return r ? c.json(refused(r), 409) : c.json({ ok: true as const }, 200);
    })
    .openapi(testAdapterRoute, async (c) => {
      const m = c.get("member");
      return c.json(await testAdapter({ deployment: deployment(), models: models(), workspaceId: m.workspaceId, userId: m.userId, provider: c.req.valid("param").adapter }), 200);
    })
    .openapi(listRoute, async (c) => {
      const d = deployment();
      const providers = await listProviders(d, vault, c.get("member").workspaceId, () => models().availableProviders(c.get("member").workspaceId));
      return c.json({ deployment: d, providers }, 200);
    })
    .openapi(putRoute, async (c) => {
      const m = c.get("member");
      const r = await connect({
        deployment: deployment(),
        vault,
        workspaceId: m.workspaceId,
        provider: c.req.valid("param").provider,
        credentialId: c.req.valid("json").credentialId,
        actorUserId: m.userId,
        now: now(),
      });
      return r ? c.json(refused(r), 409) : c.json({ ok: true as const }, 200);
    })
    .openapi(deleteRoute, async (c) => {
      const r = await disconnect(deployment(), c.get("member").workspaceId, c.req.valid("param").provider);
      return r ? c.json(refused(r), 409) : c.json({ ok: true as const }, 200);
    })
    .openapi(testRoute, async (c) => {
      const m = c.get("member");
      const r = await models().testConnection(m.workspaceId, c.req.valid("param").provider, m.userId);
      const reason = r.ok ? null : "refusal" in r ? r.refusal : (r.reason ?? r.errorFamily);
      return c.json({ ok: r.ok, reason, callId: r.callId }, 200);
    })
    .openapi(getSettingsRoute, async (c) => {
      const s = await readSettings(deployment(), c.get("member").workspaceId);
      return c.json({ monthlyBudgetMicros: s.monthlyBudgetMicros.toString(), allowUnpriced: s.allowUnpriced }, 200);
    })
    .openapi(putSettingsRoute, async (c) => {
      const m = c.get("member");
      const b = c.req.valid("json");
      const r = await changeSettings({
        deployment: deployment(),
        workspaceId: m.workspaceId,
        actorUserId: m.userId,
        monthlyBudgetMicros: BigInt(b.monthlyBudgetMicros),
        allowUnpriced: b.allowUnpriced,
        now: now(),
      });
      return r ? c.json(refused(r), 409) : c.json(b, 200);
    })
    .openapi(usageRoute, async (c) => {
      const { month } = c.req.valid("query");
      const u = await usage(deployment(), c.get("member").workspaceId, month ? new Date(`${month}-01T00:00:00Z`) : now());
      return c.json(
        {
          month: u.month,
          settledMicros: u.settledMicros.toString(),
          heldMicros: u.heldMicros.toString(),
          budgetMicros: u.budgetMicros.toString(),
          incidents: u.incidents.map((i) => ({ threshold: i.threshold, openedAt: i.openedAt.toISOString() })),
          rows: u.rows,
        },
        200,
      );
    })
    .openapi(callsRoute, async (c) => {
      const { before } = c.req.valid("query");
      const rows = await recentCalls(c.get("member").workspaceId, PAGE, before ? new Date(before) : undefined);
      return c.json({ calls: rows.map((r) => ({ ...r, costMicros: r.costMicros?.toString() ?? null, createdAt: r.createdAt.toISOString() })) }, 200);
    });
}
