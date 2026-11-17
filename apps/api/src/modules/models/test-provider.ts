// SPDX-License-Identifier: AGPL-3.0-only
// Test only: a provider over real HTTP that speaks Anthropic's Messages API and OpenRouter's
// chat completions, and records what it received.
import type { Keys } from "./adapters/keys";
import type { Provider } from "./domain/routes-check";
export type Received = { path: string; headers: Headers; body: Record<string, unknown> };

export function fakeProvider() {
  const received: Received[] = [];
  let respond: (r: Received) => Response | Promise<Response> = () => anthropicText("OK");
  const server = Bun.serve({
    port: 0,
    idleTimeout: 30,
    async fetch(req) {
      const r = { path: new URL(req.url).pathname, headers: req.headers, body: (await req.json()) as Record<string, unknown> };
      received.push(r);
      return respond(r);
    },
  });
  return {
    url: `http://localhost:${server.port}/v1`,
    received,
    respondWith: (f: typeof respond) => {
      respond = f;
    },
    stop: () => server.stop(true),
  };
}

export function anthropicText(text: string, usage = { input_tokens: 1000, output_tokens: 100 }, model = "served-model") {
  return Response.json({ id: "msg_1", type: "message", role: "assistant", model, content: [{ type: "text", text }], stop_reason: "end_turn", usage });
}

export const anthropicTool = (name: string, input: unknown) =>
  Response.json({
    id: "msg_2",
    type: "message",
    role: "assistant",
    model: "served-model",
    content: [{ type: "tool_use", id: "tu_1", name, input }],
    stop_reason: "tool_use",
    usage: { input_tokens: 10, output_tokens: 5 },
  });

export const openRouterText = (text: string, cost: number) =>
  Response.json({
    id: "or_1",
    object: "chat.completion",
    created: 1,
    model: "vendor/model",
    choices: [{ index: 0, finish_reason: "stop", message: { role: "assistant", content: text } }],
    usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15, cost },
  });

/** Keys without the vault, for suites about the call rather than where its key comes from. */
export const testKeys = (key: string | null, provider: Provider = "anthropic"): Keys => ({
  available: async () => new Set(key ? [provider] : []),
  withKey: async (_ws, _p, fn) => (key ? fn(key) : null),
  kindOf: () => "cloud_contract",
});
