// SPDX-License-Identifier: AGPL-3.0-only
// The door (ADR 0032 rule 002): its own app and its own OpenAPI document, mounting one POST route per
// registered reader and nothing else, so no route written for the web app can end up here. Each
// request needs an External token for the Workspace in its URL. In order: the token, the caps, the
// reader the token chose, the body's size, then the read; every step after the token leaves one
// request row. Any failed token check gets the same 401, so the answer says nothing about why.
import { OpenAPIHono } from "@hono/zod-openapi";
import { bodyLimit } from "hono/body-limit";
import { createMiddleware } from "hono/factory";
import { z } from "zod";
import { invoke } from "./application/invoke";
import type { Registration } from "./application/registry";
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

export function doorApp(d: { tokens: Pick<Tokens, "verify">; requests: Requests; registrations: readonly Registration[] }) {
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
      const admitted = await d.requests.admit(workspaceId, caller.tokenId);
      if (!admitted.ok) {
        await record("rate_limited");
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

  // The MCP face: the token and caps here, the reader check per tool call inside `invoke`.
  const mcpPath = `${DOOR_BASE}/w/:workspaceId/mcp`;
  app.post(mcpPath, admit("mcp"), limit, (c) => answerMcp(c.req.raw, c.get("caller"), d.registrations, d.requests));
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
