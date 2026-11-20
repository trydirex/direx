// SPDX-License-Identifier: AGPL-3.0-only
// Test only: scripts on PATH that behave like each CLI, so CI needs no subscription.
import { chmodSync, existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { useCodexBinaryForTests } from "./adapters/runtime/codex";

export type FakeMode = "success" | "tool" | "bad_answer" | "signed_out" | "limit" | "crash" | "garbage";

const quoted = (s: string) => `'${s.replaceAll("'", `'\\''`)}'`;

const claudeUsage = `"usage":{"input_tokens":10,"cache_read_input_tokens":2,"cache_creation_input_tokens":3,"output_tokens":4,"output_tokens_details":{"thinking_tokens":1}},"modelUsage":{"claude-served":{}},"total_cost_usd":9.99`;
const envelope = (fields: string) => `{"answer":null,"tool":null,"tool_input":null,${fields}}`;

const CLAUDE: Record<FakeMode, string> = {
  // The answer proves the token reached the CLI, and only through its own variable.
  success: `printf '{"is_error":false,"structured_output":{"answer":"{\\\\"token\\\\":\\\\"%s\\\\"}","tool":null,"tool_input":null},${claudeUsage}}' "$CLAUDE_CODE_OAUTH_TOKEN"`,
  tool: `echo ${quoted(`{"structured_output":{"answer":null,"tool":"fetch_page","tool_input":"{\\"url\\":\\"https://a.example\\"}"},${claudeUsage}}`)}`,
  bad_answer: `echo ${quoted(`{"structured_output":{"answer":"{\\"wrong\\":1}","tool":null,"tool_input":null},${claudeUsage}}`)}`,
  signed_out: `echo 'Not logged in. Please run /login' >&2; exit 1`,
  limit: `echo ${quoted(`{"is_error":true,"result":"You've hit your limit","usage":{}}`)}; exit 1`,
  crash: `echo 'segfault' >&2; exit 139`,
  garbage: `echo 'this is not json'`,
};

const codexDone = `{"type":"turn.completed","usage":{"input_tokens":10,"cached_input_tokens":2,"cache_write_input_tokens":3,"output_tokens":4,"reasoning_output_tokens":1}}`;
const codexMessage = (text: string) => `${JSON.stringify({ type: "item.completed", item: { type: "agent_message", text } })}\n${codexDone}`;

const CODEX: Record<FakeMode, string> = {
  // Refreshes its sign-in as the real CLI does, and answers with the one it was given.
  success: `old=$(cat "$CODEX_HOME/auth.json"); echo "$old-refreshed" > "$CODEX_HOME/auth.json"; printf '{"type":"item.completed","item":{"type":"agent_message","text":"{\\\\"answer\\\\":\\\\"{\\\\\\\\\\\\"token\\\\\\\\\\\\":\\\\\\\\\\\\"%s\\\\\\\\\\\\"}\\\\",\\\\"tool\\\\":null,\\\\"tool_input\\\\":null}"}}\\n%s\\n' "$old" ${quoted(codexDone)}`,
  tool: `echo ${quoted(codexMessage(JSON.stringify({ answer: null, tool: "fetch_page", tool_input: '{"url":"https://a.example"}' })))}`,
  bad_answer: `echo ${quoted(codexMessage(envelope(`"x":1`).replace(`"answer":null`, `"answer":"{}"`)))}`,
  signed_out: `echo '{"type":"error","message":"401 Unauthorized"}'; exit 1`,
  limit: `echo '{"type":"error","message":"You have reached your usage limit"}'; exit 1`,
  crash: `echo 'segfault' >&2; exit 139`,
  garbage: `echo 'this is not json'`,
};

/** PATH with every directory holding a real CLI removed, so a test can't reach one by mistake. */
export const pathWithoutRealClis = (path = ""): string =>
  path.split(":").filter((dir) => !existsSync(join(dir, "claude")) && !existsSync(join(dir, "codex"))).join(":");

/**
 * Puts stubs that always fail first on PATH, and points Codex at its stub, since Direx ships a real one
 * (ADR 0036). Dropping the real ones isn't enough, since one can sit in /usr/bin beside git.
 */
export function blockRealClis(): string {
  const dir = mkdtempSync(join(tmpdir(), "direx-no-real-cli-"));
  for (const name of ["claude", "codex"]) {
    writeFileSync(join(dir, name), "#!/bin/sh\nexit 127\n");
    chmodSync(join(dir, name), 0o755);
  }
  process.env.PATH = `${dir}:${process.env.PATH ?? ""}`;
  useCodexBinaryForTests(join(dir, "codex"));
  return dir;
}

/** A directory to put first on PATH, holding one fake CLI in the given mode. */
export function fakeCli(name: "claude" | "codex", mode: FakeMode): string {
  const dir = mkdtempSync(join(tmpdir(), "direx-fake-cli-"));
  const file = join(dir, name);
  writeFileSync(file, `#!/bin/bash\ncat > /dev/null\n${(name === "claude" ? CLAUDE : CODEX)[mode]}\n`);
  chmodSync(file, 0o755);
  return dir;
}

/** A fake CLI that runs the given script, for trying to break out of the sandbox. */
export function scriptCli(script: string): string {
  const dir = mkdtempSync(join(tmpdir(), "direx-fake-cli-"));
  const file = join(dir, "tool");
  writeFileSync(file, `#!/bin/bash\n${script}\n`);
  chmodSync(file, 0o755);
  return file;
}
