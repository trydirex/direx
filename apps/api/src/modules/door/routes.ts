// SPDX-License-Identifier: AGPL-3.0-only
// The door (ADR 0032 rule 002): its own app and its own OpenAPI document, mounting one POST route per
// registered reader and nothing else, so no route written for the web app can end up here. Each
// request needs an External token for the Workspace in its URL. In order: the token, the caps, the
// reader the token chose, the body's size, then the read; every step after the token leaves one
// request row, except a token's repeat refusals at the caps within one minute. Any failed token check gets the same 401, so the answer says nothing about why.
import { createRoute, OpenAPIHono } from "@hono/zod-openapi";
import { bodyLimit } from "hono/body-limit";
import { createMiddleware } from "hono/factory";
import { z } from "zod";
import { requirePermission, requireStepUp, type MemberEnv } from "../identity/index";
import { invoke, proposeVia } from "./application/invoke";
import { DOOR_KINDS, DOOR_READERS } from "./domain/catalogue";
import type { ProposalRegistration, Registration } from "./application/registry";
import { answerMcp } from "./mcp";
import type { DoorOutcome, Requests } from "./application/requests";
import type { Tokens } from "./application/tokens";
import type { TokenCaller } from "./domain/tokens";

export const DOOR_BASE = "/api/door/v1";
const MAX_BODY_BYTES = 16 * 1024;

type DoorEnv = { Variables: { caller: TokenCaller; record: (outcome: DoorOutcome) => Promise<unknown> } };

const refusal = z.object({ error: z.string() });
const refusals = {
  400: { description: "invalid_input or bad_cursor", content: { "application/json": { schema: refusal } } },
  401: { description: "token_required or invalid_token", content: { "application/json": { schema: refusal } } },
  403: { description: "reader_not_allowed", content: { "application/json": { schema: refusal } } },
  413: { description: "too_large", content: { "application/json": { schema: refusal } } },
  429: { description: "rate_limited; Retry-After says how many seconds", content: { "application/json": { schema: refusal } } },
};

export function doorApp(d: { tokens: Pick<Tokens, "verify">; requests: Requests; registrations: readonly Registration[]; proposals?: readonly ProposalRegistration[] }) {
  const proposals = d.proposals ?? [];
  const app = new OpenAPIHono<DoorEnv>();
  app.openAPIRegistry.registerComponent("securitySchemes", "externalToken", { type: "http", scheme: "bearer", description: "An External token, dxt_..." });

  /** The token, then the caps. `name` is what a refusal's request row records. */
  const admit = (name: string) =>
    createMiddleware<DoorEnv>(async (c, next) => {
      const workspaceId = c.req.param("workspaceId")!;
      const header = c.req.header("authorization");
      if (!header?.startsWith("Bearer ")) return c.json({ error: "token_required" }, 401);
      const caller = await d.tokens.verify(workspaceId, header.slice("Bearer ".length));
      if (!caller) return c.json({ error: "invalid_token" }, 401);
      const record = (outcome: DoorOutcome) => d.requests.record(workspaceId, caller.tokenId, name, outcome);
      c.set("caller", caller);
      c.set("record", record);
      const admitted = await d.requests.admit(workspaceId, caller.tokenId, name);
      if (!admitted.ok) {
        c.header("Retry-After", String(admitted.retryAfter));
        return c.json({ error: "rate_limited" }, 429);
      }
      await next();
    });
  /** Before the body is read, so a refused reader costs no more than its counted request. */
  const readerChosen = (name: Registration["name"]) =>
    createMiddleware<DoorEnv>(async (c, next) => {
      if (!c.get("caller").readers.includes(name)) {
        await c.get("record")("reader_not_allowed");
        return c.json({ error: "reader_not_allowed" }, 403);
      }
      await next();
    });
  const limit = bodyLimit({
    maxSize: MAX_BODY_BYTES,
    onError: async (c) => {
      await c.get("record")("too_large");
      return c.json({ error: "too_large" }, 413);
    },
  });

  for (const reg of d.registrations) {
    app.post(`${DOOR_BASE}/w/:workspaceId/${reg.name}`, admit(reg.name), readerChosen(reg.name), limit, async (c) => {
      const record = c.get("record");
      const text = await c.req.text();
      let input: unknown;
      try {
        input = text ? JSON.parse(text) : {};
      } catch {
        await record("invalid_input");
        return c.json({ error: "invalid_input" }, 400);
      }
      // The rest is the same call path the MCP face takes.
      const r = await invoke(d.requests, c.get("caller"), reg, input);
      if (r.ok) return c.json(r.value, 200);
      return c.json({ error: r.refusal }, r.refusal === "reader_not_allowed" ? 403 : 400);
    });

    app.openAPIRegistry.registerPath({
      method: "post",
      path: `${DOOR_BASE}/w/{workspaceId}/${reg.name}`,
      operationId: reg.name,
      description: reg.description,
      security: [{ externalToken: [] }],
      request: { params: z.object({ workspaceId: z.uuid() }), body: { content: { "application/json": { schema: reg.input } } } },
      responses: { 200: { description: `${reg.name}, as its output schema says`, content: { "application/json": { schema: reg.output } } }, ...refusals },
    });
  }

  // Proposals (ADR 0032 rule 004): the kind check, idempotency and proposal caps are the intake's.
  const STATUS = { kind_not_allowed: 403, invalid_input: 400, idempotency_conflict: 409, already_waiting: 409, proposal_cap: 429, refused: 422 } as const;
  for (const p of proposals) {
    app.post(`${DOOR_BASE}/w/:workspaceId/${p.name}`, admit(p.name), limit, async (c) => {
      const text = await c.req.text();
      let input: unknown;
      try {
        input = text ? JSON.parse(text) : {};
      } catch {
        await c.get("record")("invalid_input");
        return c.json({ error: "invalid_input" }, 400);
      }
      const r = await proposeVia(d.requests, c.get("caller"), p, input);
      if (r.ok) return c.json(r.value, 200);
      return c.json({ error: r.refusal, ...(r.itemId && { itemId: r.itemId }), ...(r.code && { code: r.code }) }, STATUS[r.refusal]);
    });
    const answer = (description: string) => ({ description, content: { "application/json": { schema: z.object({ error: z.string(), itemId: z.uuid().optional(), code: z.string().optional() }) } } });
    app.openAPIRegistry.registerPath({
      method: "post",
      path: `${DOOR_BASE}/w/{workspaceId}/${p.name}`,
      operationId: p.name,
      description: p.description,
      security: [{ externalToken: [] }],
      request: { params: z.object({ workspaceId: z.uuid() }), body: { content: { "application/json": { schema: p.input } } } },
      responses: {
        200: { description: "The Item, waiting for a person; the same one for a retry", content: { "application/json": { schema: p.output } } },
        400: answer("invalid_input"),
        401: refusals[401],
        403: answer("kind_not_allowed"),
        409: answer("idempotency_conflict, or already_waiting with that Item's id"),
        413: refusals[413],
        422: answer("refused, with the owning module's code"),
        429: answer("rate_limited or proposal_cap"),
      },
    });
  }

  // The MCP face: the token and caps here, the reader check per tool call inside `invoke`.
  const mcpPath = `${DOOR_BASE}/w/:workspaceId/mcp`;
  app.post(mcpPath, admit("mcp"), limit, (c) => answerMcp(c.req.raw, c.get("caller"), d.registrations, d.requests, proposals));
  app.on(["GET", "DELETE"], mcpPath, (c) => c.json({ error: "method_not_allowed" }, 405));
  app.openAPIRegistry.registerPath({
    method: "post",
    path: `${DOOR_BASE}/w/{workspaceId}/mcp`,
    operationId: "mcp",
    description: "The same readers as MCP tools, over MCP's Streamable HTTP transport without sessions: one tool for each reader the token chose.",
    security: [{ externalToken: [] }],
    request: { params: z.object({ workspaceId: z.uuid() }), body: { content: { "application/json": { schema: z.object({ jsonrpc: z.literal("2.0") }).loose() } } } },
    responses: { 200: { description: "An MCP JSON-RPC answer", content: { "application/json": { schema: z.object({ jsonrpc: z.literal("2.0") }).loose() } } }, 401: refusals[401], 413: refusals[413], 429: refusals[429] },
  });

  app.doc31(`${DOOR_BASE}/openapi.json`, { openapi: "3.1.0", info: { title: "Direx door", version: "1" } });
  return app;
}

// The web app's routes for a Workspace's External tokens (ADR 0032 rule 005), behind the session
// check identity mounts on every /api/w/ path. Only an Owner or Admin who signed in within 10 minutes
// creates; any Member lists and revokes, so stopping a token is never harder than starting one.
const ws = z.object({ workspaceId: z.uuid() });
const json = <T extends z.ZodType>(schema: T, description: string) => ({ description, content: { "application/json": { schema } } });
const tokenErrors = {
  400: json(refusal, "bad_name, bad_lifetime, unknown_reader or unknown_kind"),
  401: json(refusal, "Not signed in, or an Authorization header"),
  403: json(refusal, "forbidden or step_up_required"),
  404: json(refusal, "No such Workspace or token"),
};
const ExternalToken = z
  .object({
    id: z.uuid(),
    name: z.string(),
    hint: z.string(),
    readers: z.array(z.string()),
    kinds: z.array(z.string()),
    createdBy: z.string(),
    createdAt: z.iso.datetime(),
    expiresAt: z.iso.datetime(),
    revokedBy: z.string().nullable(),
    revokedAt: z.iso.datetime().nullable(),
    lastUsedAt: z.iso.datetime().nullable(),
    state: z.enum(["live", "expired", "revoked", "stopped"]),
  })
  .openapi("ExternalToken");
// What the create form offers: the lifetimes this server allows and the closed lists a token picks from.
const TokenChoices = z.object({ lifetimes: z.array(z.number()), readers: z.array(z.object({ name: z.string(), personal: z.boolean() })), kinds: z.array(z.string()) }).openapi("ExternalTokenChoices");
const CreateBody = z.strictObject({ name: z.string().max(200), days: z.number().int(), readers: z.array(z.string()).max(20), kinds: z.array(z.string()).max(20) });

const listTokensRoute = createRoute({ method: "get", path: "/api/w/{workspaceId}/external-tokens", request: { params: ws }, responses: { 200: json(z.object({ tokens: z.array(ExternalToken), choices: TokenChoices }), "Every token in this Workspace, never the token itself"), ...tokenErrors } });
const createTokenRoute = createRoute({
  method: "post",
  path: "/api/w/{workspaceId}/external-tokens",
  middleware: [requirePermission("workspace.settings"), requireStepUp("short")],
  request: { params: ws, body: { required: true, content: { "application/json": { schema: CreateBody } } } },
  responses: { 200: json(z.object({ id: z.uuid(), token: z.string(), expiresAt: z.iso.datetime() }), "The new token, shown this once"), ...tokenErrors },
});
const revokeTokenRoute = createRoute({ method: "delete", path: "/api/w/{workspaceId}/external-tokens/{tokenId}", request: { params: ws.extend({ tokenId: z.uuid() }) }, responses: { 200: json(z.object({ ok: z.literal(true) }), "Revoked, or already revoked"), ...tokenErrors } });

// A token's last 20 door requests, for any member: which reader, how it ended and when, never content.
const DoorRequest = z.object({ reader: z.string(), outcome: z.string(), at: z.iso.datetime() }).openapi("DoorRequest");
const tokenRequestsRoute = createRoute({
  method: "get",
  path: "/api/w/{workspaceId}/external-tokens/{tokenId}/requests",
  request: { params: ws.extend({ tokenId: z.uuid() }) },
  responses: { 200: json(z.object({ requests: z.array(DoorRequest) }), "Newest first; none for a token this Workspace never made"), ...tokenErrors },
});

const iso = (d: Date | null) => d && d.toISOString();

export function tokenRoutes({ tokens, requests }: { tokens: () => Tokens; requests: () => Pick<Requests, "recent"> }) {
  const app = new OpenAPIHono<MemberEnv>();
  return app
    .openapi(listTokensRoute, async (c) => {
      const list = await tokens().list(c.get("member").workspaceId);
      const choices = { lifetimes: tokens().lifetimes(), readers: Object.entries(DOOR_READERS).map(([name, r]) => ({ name, personal: r.personal })), kinds: [...DOOR_KINDS] };
      return c.json({ tokens: list.map((t) => ({ ...t, createdAt: t.createdAt.toISOString(), expiresAt: t.expiresAt.toISOString(), revokedAt: iso(t.revokedAt), lastUsedAt: iso(t.lastUsedAt) })), choices }, 200);
    })
    .openapi(createTokenRoute, async (c) => {
      const m = c.get("member");
      const r = await tokens().create(m.workspaceId, c.req.valid("json"), m.userId);
      if (!r.ok) return c.json({ error: r.reason }, 400);
      return c.json({ id: r.id, token: r.token, expiresAt: r.expiresAt.toISOString() }, 200);
    })
    .openapi(revokeTokenRoute, async (c) => {
      const m = c.get("member");
      if (!(await tokens().revoke(m.workspaceId, c.req.valid("param").tokenId, m.userId))) return c.json({ error: "not_found" }, 404);
      return c.json({ ok: true as const }, 200);
    })
    .openapi(tokenRequestsRoute, async (c) => {
      const rows = await requests().recent(c.get("member").workspaceId, c.req.valid("param").tokenId);
      return c.json({ requests: rows.map((r) => ({ reader: r.reader, outcome: r.outcome, at: r.at.toISOString() })) }, 200);
    });
}
