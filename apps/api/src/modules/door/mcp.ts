// SPDX-License-Identifier: AGPL-3.0-only
// The door as MCP tools (door-mcp spec): a fresh, sessionless server per request, holding one tool
// per registration the token chose, each running the same call path as its HTTP route. A refusal is
// a tool error whose text is the route's code; a value comes back structured and as JSON text, for
// clients that read only text. The SDK checks a tool's input against its schema before the tool
// runs, so a malformed input is refused by the SDK and leaves no request row; it still counts
// against the caps, which the route's gate applied. The only file that may import the SDK.
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { invoke } from "./application/invoke";
import type { Registration } from "./application/registry";
import type { Requests } from "./application/requests";
import type { TokenCaller } from "./domain/tokens";

export async function answerMcp(request: Request, caller: TokenCaller, registrations: readonly Registration[], requests: Pick<Requests, "record">): Promise<Response> {
  const server = new McpServer({ name: "direx-door", version: "1" });
  for (const reg of registrations.filter((r) => caller.readers.includes(r.name))) {
    server.registerTool(reg.name, { description: reg.description, inputSchema: reg.input, outputSchema: reg.output, annotations: { readOnlyHint: true } }, async (args: unknown) => {
      const r = await invoke(requests, caller, reg, args);
      if (!r.ok) return { isError: true, content: [{ type: "text" as const, text: r.refusal }] };
      return { content: [{ type: "text" as const, text: JSON.stringify(r.value) }], structuredContent: r.value };
    });
  }
  const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
  await server.connect(transport);
  return transport.handleRequest(request);
}
