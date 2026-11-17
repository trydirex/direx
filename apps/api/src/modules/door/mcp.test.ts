// SPDX-License-Identifier: AGPL-3.0-only
// The door's MCP face with the SDK's own client, over the door app in a test app: the same tokens,
// caps and request rows as the HTTP routes, tools only for what the token chose, values structured
// and as text, refusals as tool errors carrying the route's code.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { beforeAll, expect, test } from "vitest";
import { z } from "zod";
import type { DoorRead } from "../core-reads/index";
import { seedWorkspace } from "./fixtures/members";
import { createRequests, createTokens, DOOR_BASE, doorApp, registerReaders } from "./index";

const W = crypto.randomUUID();
const owner = crypto.randomUUID();
const tokens = createTokens({ maxDays: null });
const requests = createRequests({ caps: { perToken: 50, perWorkspace: 1000 } });

const Input = z.strictObject({ cursor: z.string().nullish() });
const fake = (disclosure: DoorRead["disclosure"]): DoorRead => ({
  description: "A fake read.",
  input: Input,
  output: z.object({ n: z.number() }),
  disclosure,
  read: async (_w, raw) => (Input.parse(raw).cursor === "bad" ? { ok: false, reason: "bad_cursor" } : { ok: true, value: { n: 1 }, trust: "trusted" }),
});
const registrations = registerReaders({ read_changes: fake("operational"), read_needs_you: fake("personal"), read_schedule: fake("personal"), read_campaign: fake("operational") });
const app = doorApp({ tokens, requests, registrations });
const url = (w = W) => new URL(`http://door.test${DOOR_BASE}/w/${w}/mcp`);

beforeAll(() => seedWorkspace(W, owner));
async function token(readers = ["read_changes", "read_campaign"]) {
  const r = await tokens.create(W, { name: "Agent", days: 7, readers, kinds: [] }, owner);
  if (!r.ok) throw new Error(r.reason);
  return r;
}
async function connect(raw: string, on = app) {
  const client = new Client({ name: "test-agent", version: "1" });
  await client.connect(new StreamableHTTPClientTransport(url(), { requestInit: { headers: { authorization: `Bearer ${raw}` } }, fetch: async (input, init) => on.request(String(input), init) }));
  return client;
}
const post = (headers: Record<string, string>, on = app) =>
  on.request(url().toString(), {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream", ...headers },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "raw", version: "1" } } }),
  });
const outcomes = async (tokenId: string) => (await requests.recent(W, tokenId)).map((r) => r.outcome);

test("no token or a bad one gets the routes' 401s; GET and DELETE are 405", async () => {
  expect([(await post({})).status, await (await post({})).json()]).toEqual([401, { error: "token_required" }]);
  const bad = await post({ authorization: "Bearer dxt_notatoken" });
  expect([bad.status, await bad.json()]).toEqual([401, { error: "invalid_token" }]);
  for (const method of ["GET", "DELETE"]) expect((await app.request(url().toString(), { method })).status).toBe(405);
});

test("the tools are the readers the token chose, read-only, each with an object output schema", async () => {
  const t = await token();
  const client = await connect(t.token);
  const { tools } = await client.listTools();
  expect(tools.map((x) => x.name).sort()).toEqual(["read_campaign", "read_changes"]);
  for (const x of tools) {
    expect(x.annotations?.readOnlyHint).toBe(true);
    expect(x.outputSchema?.type).toBe("object");
  }
  await client.close();
});

test("a call returns the value structured and as text, and leaves one row; setup and listing leave none", async () => {
  const t = await token();
  const client = await connect(t.token);
  await client.listTools();
  const r = await client.callTool({ name: "read_changes", arguments: {} });
  expect(r.structuredContent).toEqual({ n: 1 });
  expect(r.content).toEqual([{ type: "text", text: JSON.stringify({ n: 1 }) }]);
  expect(await outcomes(t.id)).toEqual(["ok"]);
  await client.close();
});

test("a refusal is a tool error with the route's code, and recorded", async () => {
  const t = await token();
  const client = await connect(t.token);
  const r = await client.callTool({ name: "read_changes", arguments: { cursor: "bad" } });
  expect(r.isError).toBe(true);
  expect(r.content).toEqual([{ type: "text", text: "bad_cursor" }]);
  expect(await outcomes(t.id)).toEqual(["bad_cursor"]);
  await client.close();
});

test("a malformed input is refused by the SDK and leaves no row", async () => {
  const t = await token();
  const client = await connect(t.token);
  const r = await client.callTool({ name: "read_changes", arguments: { everything: true } }).catch((e: unknown) => ({ isError: true, thrown: String(e) }));
  expect(r.isError).toBe(true);
  expect(await outcomes(t.id)).toEqual([]);
  await client.close();
});

test("every POST counts against the caps, and over them is the routes' 429", async () => {
  const capped = doorApp({ tokens, requests: createRequests({ caps: { perToken: 3, perWorkspace: 1000 } }), registrations });
  const t = await token();
  for (let i = 0; i < 3; i++) expect((await post({ authorization: `Bearer ${t.token}` }, capped)).status).toBe(200);
  const over = await post({ authorization: `Bearer ${t.token}` }, capped);
  expect([over.status, await over.json()]).toEqual([429, { error: "rate_limited" }]);
  expect(Number(over.headers.get("retry-after"))).toBeGreaterThan(0);
});
