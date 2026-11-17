// SPDX-License-Identifier: AGPL-3.0-only
// The CLI adapters against fake CLIs on PATH and the real sandbox, and through generate as the app role.
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, expect, test } from "vitest";
import { z } from "zod";
import { appClient, insertAuthUser } from "../../../../../test/db";
import { withBudget } from "../ledger/index";
import type { Keys } from "./adapters/keys";
import { claudeArgs, claudeCode } from "./adapters/runtime/claude-code";
import { codex, codexArgs } from "./adapters/runtime/codex";
import { ENVELOPE_SCHEMA, envelopeSchema, instructions } from "./adapters/runtime/envelope";
import { ADAPTERS, oneAtATime, withCliAdapters } from "./adapters/runtime/registry";
import { runSandboxed, sandboxStatus } from "./adapters/runtime/sandbox";
import type { Dispatch, DispatchRequest } from "./adapters/sdk";
import { checkRoutes, type Candidate, type Provider } from "./domain/routes-check";
import { fakeCli, pathWithoutRealClis, scriptCli, type FakeMode } from "./fake-cli";
import { createModels } from "./index";

const PATH = pathWithoutRealClis(process.env.PATH);
process.env.PATH = PATH;
afterEach(() => {
  process.env.PATH = PATH;
});
const onPath = (dir: string) => {
  process.env.PATH = `${dir}:${PATH}`;
};

const TOKEN = "marker-token-7421";
const signal = () => AbortSignal.timeout(30_000);
const typed = z.object({ token: z.string() });
const request = (provider: Provider, over: Partial<DispatchRequest> = {}): DispatchRequest => ({
  provider,
  model: "pinned-model",
  apiKey: TOKEN,
  messages: [{ role: "user", content: "hello" }],
  tools: [],
  maxOutputTokens: 100,
  abortSignal: signal(),
  ...over,
});
const fetchPage = { name: "fetch_page", description: "Reads a page.", class: "read" as const, inputSchema: z.object({ url: z.string() }) };

const status = await sandboxStatus();

test("the list has both CLIs, and a call for a CLI never reaches the SDK", async () => {
  expect(ADAPTERS.map((a) => a.id)).toEqual(["claude_code", "codex"]);
  const base: Dispatch = async () => {
    throw new Error("reached the SDK");
  };
  onPath(fakeCli("claude", "garbage"));
  const r = await withCliAdapters(base)(request("claude_code"));
  expect(r.ok).toBe(false);
  expect(await withCliAdapters(base, [])(request("codex"))).toEqual({ ok: false, family: "configuration", definite: true });
});

test("each CLI gets exactly the flags that turn its tools off", () => {
  const claude = claudeArgs({ model: "m", tools: [] });
  expect(claude.slice(0, 7)).toEqual(["-p", "--tools", "", "--strict-mcp-config", "--setting-sources", "", "--disable-slash-commands"]);
  expect(claude).toContain("--no-session-persistence");
  expect(claude[claude.indexOf("--model") + 1]).toBe("m");

  const args = codexArgs({ model: "m" });
  expect(args.slice(0, 7)).toEqual(["exec", "--json", "--skip-git-repo-check", "--ignore-user-config", "--ignore-rules", "--sandbox", "read-only"]);
  for (const f of ["shell_tool", "unified_exec", "apps", "browser_use", "computer_use", "plugins", "multi_agent", "in_app_browser", "code_mode_host"]) {
    expect(args[args.indexOf(f) - 1]).toBe("--disable");
  }
  expect(args.at(-1)).toBe("-");
});

test("with tools and no typed output, the CLI isn't offered a plain text answer", () => {
  const lookup = { name: "lookup", description: "Look up a fact.", class: "read" as const, inputSchema: z.object({ q: z.string() }) };
  const base: Omit<DispatchRequest, "tools"> = { provider: "claude_code", model: "m", apiKey: "k", messages: [], maxOutputTokens: 10, abortSignal: AbortSignal.timeout(1000) };
  const agent = instructions({ ...base, tools: [lookup] });
  expect(agent).toContain("You must call a tool");
  expect(agent).not.toContain("as plain text");
  expect(instructions({ ...base, tools: [] })).toContain("as plain text");
  expect(instructions({ ...base, tools: [lookup], output: z.object({ a: z.number() }) })).toContain("To call a tool instead");

  const shape = envelopeSchema({ tools: [lookup] });
  expect(shape.properties.tool).toMatchObject({ type: "string", enum: ["lookup"] });
  expect(shape.properties.tool_input.type).toBe("string");
  expect(envelopeSchema({ tools: [] })).toBe(ENVELOPE_SCHEMA);
  expect(envelopeSchema({ tools: [lookup], output: z.object({ a: z.number() }) })).toBe(ENVELOPE_SCHEMA);
  const args = claudeArgs({ model: "m", tools: [lookup] });
  expect(JSON.parse(args[args.indexOf("--json-schema") + 1]!)).toEqual(shape);
});

test("a CLI that isn't on PATH is a configuration failure, and says it isn't installed", async () => {
  process.env.PATH = mkdtempSync(join(tmpdir(), "direx-empty-"));
  expect(await claudeCode.installed()).toBe(false);
  expect(await codex.installed()).toBe(false);
  expect(await claudeCode.call(request("claude_code"))).toMatchObject({ ok: false, family: "configuration" });
  expect(await codex.call(request("codex"))).toMatchObject({ ok: false, family: "configuration" });
});

if (status.ok) {
  const cases = [
    ["claude", claudeCode, "claude_code"],
    ["codex", codex, "codex"],
  ] as const;

  for (const [bin, adapter, provider] of cases) {
    test(`${bin}: failures map to the same families as an API`, async () => {
      const outcomes: [FakeMode, Record<string, unknown>][] = [
        ["signed_out", { family: "configuration", definite: true }],
        ["limit", { family: "provider_quota", definite: true }],
        ["crash", { family: "transient_upstream", definite: true }],
        ["garbage", { family: "model_refusal", usage: null }],
        ["bad_answer", { family: "model_refusal" }],
      ];
      for (const [mode, expected] of outcomes) {
        onPath(fakeCli(bin, mode));
        expect(await adapter.call(request(provider, { output: typed, abortSignal: signal() })), mode).toMatchObject({ ok: false, ...expected });
      }
    });

    test(`${bin}: a tool request comes back as a validated call, and an unoffered tool as a refusal`, async () => {
      onPath(fakeCli(bin, "tool"));
      expect(await adapter.call(request(provider, { tools: [fetchPage] }))).toMatchObject({
        ok: true,
        toolCalls: [{ toolName: "fetch_page", input: { url: "https://a.example" } }],
      });
      expect(await adapter.call(request(provider, { abortSignal: signal() }))).toMatchObject({ ok: false, family: "model_refusal" });
    });

    test(`${bin}: an aborted call has no receipt`, async () => {
      onPath(fakeCli(bin, "success"));
      expect(await adapter.call(request(provider, { abortSignal: AbortSignal.abort() }))).toMatchObject({ ok: false, family: "no_receipt", definite: false });
    });
  }

  test("claude: the typed answer and usage come back, with the model it served", async () => {
    onPath(fakeCli("claude", "success"));
    expect(await claudeCode.call(request("claude_code", { output: typed }))).toMatchObject({
      ok: true,
      output: { token: TOKEN },
      resolvedModel: "claude-served",
      usage: { noCacheTokens: 10, cacheReadTokens: 2, cacheWriteTokens: 3, outputTokens: 4, reasoningTokens: 1 },
    });
  });

  test("codex: the typed answer comes back and a refreshed sign-in is kept", async () => {
    onPath(fakeCli("codex", "success"));
    const saved: string[] = [];
    const r = await codex.call(request("codex", { output: typed, replaceKey: async (v) => void saved.push(v) }));
    expect(r).toMatchObject({ ok: true, output: { token: TOKEN }, usage: { noCacheTokens: 5, cacheReadTokens: 2, cacheWriteTokens: 3, outputTokens: 4, reasoningTokens: 1 } });
    expect(saved).toEqual([`${TOKEN}-refreshed\n`]);
  });

  test("the sandbox stops reading a host file, reading a secret from the environment, and reaching a blocked host", async () => {
    const hostFile = join(mkdtempSync(join(tmpdir(), "direx-host-")), "secret.txt");
    writeFileSync(hostFile, "HOST-FILE-MARKER");
    process.env.DIREX_TEST_SECRET = "ENV-MARKER";
    const server = Bun.serve({ port: 0, fetch: () => new Response("REACHED") });
    const url = `http://127.0.0.1:${server.port}/`;
    try {
      const r = await runSandboxed({
        binary: scriptCli(`
          echo "file:$(cat ${hostFile} 2>&1)"
          echo "home:$(cat ${process.env.HOME}/.bashrc 2>&1 | head -1)"
          echo "env:$(env)"
          echo "blocked:$(curl -s -m 5 -p -x "$HTTPS_PROXY" ${url} 2>&1; echo " code=$?")"
          echo "direct:$(curl -s -m 5 --noproxy '*' ${url} 2>&1; echo " code=$?")"
          echo "external:$(curl -s -m 5 -p -x "$HTTPS_PROXY" https://example.com/ 2>&1; echo " code=$?")"
        `),
        args: [],
        env: {},
        stdin: "",
        egress: ["api.anthropic.com:443"],
        signal: signal(),
      });
      if (!r.ran) throw new Error(r.reason);
      expect(r.stdout).toMatch(/file:.*No such file/);
      expect(r.stdout).toMatch(/home:.*No such file/);
      expect(r.stdout).not.toContain("HOST-FILE-MARKER");
      expect(r.stdout).not.toContain("ENV-MARKER");
      expect(r.stdout).not.toContain("REACHED");
      expect(r.stdout).toMatch(/blocked:.*code=(56|22)/);
      expect(r.stdout).toMatch(/direct:.*code=7/);
      expect(r.stdout).toMatch(/external:.*code=(56|22)/);
    } finally {
      delete process.env.DIREX_TEST_SECRET;
      await server.stop(true);
    }
  });

  test("the sandbox does reach an allowed host, so the blocks above mean something", async () => {
    const server = Bun.serve({ port: 0, fetch: () => new Response("REACHED") });
    try {
      const r = await runSandboxed({
        binary: scriptCli(`curl -s -m 5 -p -x "$HTTPS_PROXY" http://127.0.0.1:${server.port}/`),
        args: [],
        env: {},
        stdin: "",
        egress: [`127.0.0.1:${server.port}`],
        signal: signal(),
        // The test server is on loopback, which the proxy refuses unless told otherwise.
        allowAddress: (a) => a === "127.0.0.1",
      });
      expect(r).toMatchObject({ ran: true, stdout: "REACHED" });
    } finally {
      await server.stop(true);
    }
  });

  test("a listed host on this machine is still refused, because the proxy checks the address it would reach", async () => {
    const server = Bun.serve({ port: 0, fetch: () => new Response("REACHED") });
    try {
      const r = await runSandboxed({
        binary: scriptCli(`echo "listed:$(curl -s -m 5 -p -x "$HTTPS_PROXY" http://127.0.0.1:${server.port}/ 2>&1; echo " code=$?")"`),
        args: [],
        env: {},
        stdin: "",
        egress: [`127.0.0.1:${server.port}`],
        signal: signal(),
      });
      if (!r.ran) throw new Error(r.reason);
      expect(r.stdout).not.toContain("REACHED");
      expect(r.stdout).toMatch(/listed:.*code=(56|52|35)/);
    } finally {
      await server.stop(true);
    }
  });
} else {
  test("where the sandbox can't hold, nothing runs and the reason is stated", async () => {
    const r = await runSandboxed({ binary: "/usr/bin/true", args: [], env: {}, stdin: "", egress: [], signal: signal() });
    expect(r).toEqual({ ran: false, reason: status.reason });
    onPath(fakeCli("claude", "success"));
    expect(await claudeCode.call(request("claude_code"))).toMatchObject({ ok: false, family: "configuration" });
  });
}

test("calls with one key run one after another, and a failure doesn't stop the next", async () => {
  const log: string[] = [];
  const job = (name: string, fail = false) => async () => {
    log.push(`${name} start`);
    await Bun.sleep(5);
    log.push(`${name} end`);
    if (fail) throw new Error(name);
    return name;
  };
  const [a, b] = await Promise.allSettled([oneAtATime("k", job("a", true)), oneAtATime("k", job("b"))]);
  expect(a.status).toBe("rejected");
  expect(b).toEqual({ status: "fulfilled", value: "b" });
  expect(log).toEqual(["a start", "a end", "b start", "b end"]);
});

test("a cloud route can't name a CLI", () => {
  const candidate: Candidate = { provider: "claude_code", model: "m-20260101", maxOutputTokens: 10, price: null, evalRef: "e" };
  expect(checkRoutes("cloud", { plain: { candidates: [candidate] } }).map((i) => i.reason)).toContain("uncontracted_provider");
});

let c: Awaited<ReturnType<typeof appClient>>;
beforeAll(async () => {
  c = await appClient();
});
afterAll(async () => {
  await c.end();
});

async function q(ws: string, text: string, params: unknown[] = []) {
  await c.query("begin");
  try {
    await c.query("select set_config('app.workspace_id', $1, true)", [ws]);
    const r = await c.query(text, params);
    await c.query("commit");
    return r.rows;
  } catch (e) {
    await c.query("rollback");
    throw e;
  }
}

async function newWorkspace() {
  const org = crypto.randomUUID();
  const ws = crypto.randomUUID();
  await q(ws, "insert into organizations (id, name, created_at) values ($1, 'O', now())", [org]);
  await q(ws, "insert into workspaces (id, org_id, name, created_at) values ($1, $2, 'W', now())", [ws, org]);
  return ws;
}

const cliKeys = (replaced: string[] = []): Keys => ({
  available: async () => new Set<Provider>(["claude_code", "codex", "anthropic"]),
  withKey: async (_ws, _p, fn) =>
    fn(TOKEN, async (v) => {
      replaced.push(v);
    }),
  kindOf: () => "cli_subscription",
});
const usage = { noCacheTokens: 10, cacheReadTokens: 2, cacheWriteTokens: 3, outputTokens: 4, reasoningTokens: 1 };
const models = (provider: Provider, dispatch: Dispatch, keys = cliKeys(), price: Candidate["price"] = null) =>
  createModels({
    deployment: "self_host",
    routes: { plain: { candidates: [{ provider, model: "pinned-model", maxOutputTokens: 100, price, evalRef: null }] } },
    keys,
    dispatch,
    runGate: async () => ({ live: true, tainted: false }),
  });

test("through generate: one row at 0 cents, status subscription, and no token in it", async () => {
  const ws = await newWorkspace();
  const received: string[] = [];
  const dispatch: Dispatch = async (r) => {
    received.push(r.apiKey);
    return { ok: true, text: "fine", output: undefined, toolCalls: [], usage, resolvedModel: "served" };
  };
  const r = await models("claude_code", dispatch).generate({
    workspaceId: ws,
    purpose: "plain",
    idempotencyKey: "one",
    parts: [{ role: "user", kind: "definition", text: "hi" }],
  });
  expect(r).toMatchObject({ ok: true, output: "fine" });
  expect(received).toEqual([TOKEN]);
  const rows = await q(ws, "select * from model_calls where workspace_id = $1", [ws]);
  expect(rows).toHaveLength(1);
  expect(rows[0]).toMatchObject({ status: "completed", credential_kind: "cli_subscription", cost_status: "subscription", cost_micros: "0", provider: "claude_code", input_tokens: 15 });
  expect(JSON.stringify(rows[0])).not.toContain(TOKEN);
});

test("through generate: a monthly budget already spent doesn't stop a subscription call", async () => {
  const ws = await newWorkspace();
  const admin = crypto.randomUUID();
  await insertAuthUser(admin);
  await q(
    ws,
    "insert into model_settings_revisions (workspace_id, monthly_budget_micros, allow_unpriced, changed_by, created_at) values ($1, 1, false, $2, now())",
    [ws, admin],
  );
  const now = new Date();
  await withBudget(ws, async (b) => {
    const id = await b.hold("model", 10n, now);
    await b.settle(id, 10n, now);
  });
  const dispatch: Dispatch = async () => ({ ok: true, text: "fine", output: undefined, toolCalls: [], usage, resolvedModel: "served" });
  const request = (idempotencyKey: string) => ({ workspaceId: ws, purpose: "plain", idempotencyKey, parts: [{ role: "user" as const, kind: "definition", text: "hi" }] });
  expect(await models("codex", dispatch).generate(request("two"))).toMatchObject({ ok: true });
  const price = { input: 1_000_000n, output: 1_000_000n, cacheRead: 0n, cacheWrite: 0n };
  expect(await models("anthropic", dispatch, cliKeys(), price).generate(request("three"))).toMatchObject({ ok: false, refusal: "budget_stop" });
});
