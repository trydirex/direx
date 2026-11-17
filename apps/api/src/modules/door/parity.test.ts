// SPDX-License-Identifier: AGPL-3.0-only
// The door's two faces offer the same things (ADR 0032 rule 002): for a token that chose every
// reader, the MCP tools are the document's operations other than the MCP endpoint, and each tool
// answers as its route does for the same input. A registration that reaches one face only fails here.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { beforeAll, expect, test } from "vitest";
import { z } from "zod";
import type { DoorRead } from "../core-reads/index";
import { seedWorkspace } from "./fixtures/members";
import { createRequests, createTokens, DOOR_BASE, DOOR_READERS, doorApp, registerReaders } from "./index";

const W = crypto.randomUUID();
const owner = crypto.randomUUID();
const tokens = createTokens({ maxDays: null });
const Input = z.strictObject({ say: z.string().nullish() });
// Each read answers with its own name and what it was given, so a mix-up between faces shows.
const fake = (name: string, disclosure: DoorRead["disclosure"]): DoorRead => ({
  description: `The ${name} read.`,
  input: Input,
  output: z.object({ name: z.string(), said: z.string().nullable() }),
  disclosure,
  read: async (_w, raw) => ({ ok: true, value: { name, said: Input.parse(raw).say ?? null }, trust: "trusted" }),
});
const reads = Object.fromEntries(Object.entries(DOOR_READERS).map(([name, r]) => [name, fake(name, r.personal ? "personal" : "operational")]));
const app = doorApp({ tokens, requests: createRequests({ caps: { perToken: 100, perWorkspace: 1000 } }), registrations: registerReaders(reads) });
let raw = "";

beforeAll(async () => {
  await seedWorkspace(W, owner);
  const r = await tokens.create(W, { name: "Everything", days: 7, readers: Object.keys(DOOR_READERS), kinds: [] }, owner);
  if (!r.ok) throw new Error(r.reason);
  raw = r.token;
});

test("the MCP tools are exactly the document's operations, and each answers as its route does", async () => {
  const doc = (await (await app.request(`${DOOR_BASE}/openapi.json`)).json()) as { paths: Record<string, unknown> };
  const prefix = `${DOOR_BASE}/w/{workspaceId}/`;
  const routes = Object.keys(doc.paths).map((p) => p.slice(prefix.length)).filter((n) => n !== "mcp").sort();

  const client = new Client({ name: "parity", version: "1" });
  await client.connect(new StreamableHTTPClientTransport(new URL(`http://door.test${DOOR_BASE}/w/${W}/mcp`), { requestInit: { headers: { authorization: `Bearer ${raw}` } }, fetch: async (input, init) => app.request(String(input), init) }));
  const tools = (await client.listTools()).tools.map((t) => t.name).sort();
  expect(tools).toEqual(routes);
  expect(tools).toEqual(Object.keys(DOOR_READERS).sort());

  for (const name of tools) {
    const input = { say: `hello ${name}` };
    const viaRoute = await app.request(`${DOOR_BASE}/w/${W}/${name}`, { method: "POST", headers: { authorization: `Bearer ${raw}`, "content-type": "application/json" }, body: JSON.stringify(input) });
    const viaTool = await client.callTool({ name, arguments: input });
    expect(viaTool.structuredContent, name).toEqual(await viaRoute.json());
  }
  await client.close();
});
