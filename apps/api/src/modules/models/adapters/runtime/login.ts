// SPDX-License-Identifier: AGPL-3.0-only
// A sign-in a person started. The CLI runs in a throwaway home with nothing else from Direx in its
// environment. What it prints goes only to the two parsers here: no link, code or token reaches a
// log or an error.
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CliProvider } from "../../domain/routes-check";
import { codexBinary } from "./codex";
import { parseSignInLink, parseSignInRejected, parseSignInToken, plain } from "./setup-token-parse";

const LINK_TIMEOUT_MS = 30_000;
const TOKEN_TIMEOUT_MS = 60_000;
const DEVICE_TIMEOUT_MS = 15 * 60_000;
const POLL_MS = 100;
const PASTE_SETTLE_MS = 300;
const TERMINAL_COLUMNS = 400;
const TERMINAL_ROWS = 50;
const DEVICE_LINK = /https:\/\/(?:auth\.openai\.com|chatgpt\.com)\/[A-Za-z0-9\-._~/?=&%]+/;
const DEVICE_CODE = /\b[A-Z0-9]{3,8}(?:-[A-Z0-9]{3,8})+\b/;
const BROWSER_CODE = /^[A-Za-z0-9_#.~-]{1,2048}$/;

export type LoginFailure = "not_installed" | "no_link" | "bad_code" | "no_token";
export type LoginStart = { ok: true; link: string; userCode: string | null; finish: (code: string | null) => Promise<LoginFinish>; cancel: () => Promise<void> } | { ok: false; reason: LoginFailure };
export type LoginFinish = { ok: true; value: string } | { ok: false; reason: LoginFailure };

async function until<T>(read: () => T | null, ms: number, stop?: () => boolean): Promise<T | null> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const value = read();
    if (value !== null) return value;
    if (stop?.()) return read();
    await Bun.sleep(POLL_MS);
  }
  return null;
}

async function claudeLogin(binary: string): Promise<LoginStart> {
  const home = await mkdtemp(join(tmpdir(), "direx-login-"));
  let screen = "";
  const decoder = new TextDecoder();
  const child = Bun.spawn([binary, "setup-token"], {
    cwd: home,
    env: { PATH: process.env.PATH ?? "", HOME: home, TERM: "xterm-256color" },
    terminal: { cols: TERMINAL_COLUMNS, rows: TERMINAL_ROWS, data: (_t, data) => void (screen += decoder.decode(data, { stream: true })) },
  });
  let exited = false;
  void child.exited.then(() => (exited = true));
  const cancel = async () => {
    child.kill();
    await rm(home, { recursive: true, force: true });
  };
  const link = await until(() => parseSignInLink(screen), LINK_TIMEOUT_MS, () => exited);
  if (!link) {
    await cancel();
    return { ok: false, reason: "no_link" };
  }
  return {
    ok: true,
    link,
    userCode: null,
    cancel,
    finish: async (code) => {
      if (!code || !BROWSER_CODE.test(code)) return { ok: false, reason: "bad_code" };
      // Enter comes apart from the code, or a terminal UI can take it as part of the paste.
      const before = screen.length;
      child.terminal!.write(code);
      await Bun.sleep(PASTE_SETTLE_MS);
      child.terminal!.write("\r");
      const value = await until(() => parseSignInToken(screen), TOKEN_TIMEOUT_MS, () => exited || parseSignInRejected(screen.slice(before)));
      await cancel();
      return value ? { ok: true, value } : { ok: false, reason: "no_token" };
    },
  };
}

async function codexLogin(binary: string): Promise<LoginStart> {
  const home = await mkdtemp(join(tmpdir(), "direx-login-"));
  const child = Bun.spawn([binary, "login", "--device-auth"], {
    cwd: home,
    env: { PATH: process.env.PATH ?? "", HOME: home, CODEX_HOME: home },
    stdout: "pipe",
    stderr: "pipe",
  });
  let output = "";
  const collect = async (stream: ReadableStream<Uint8Array>) => {
    for await (const chunk of stream) output += new TextDecoder().decode(chunk);
  };
  void collect(child.stdout);
  void collect(child.stderr);
  let exited = false;
  const done = child.exited.then((code) => {
    exited = true;
    return code;
  });
  const cancel = async () => {
    child.kill();
    await rm(home, { recursive: true, force: true });
  };
  const shown = await until(() => {
    // Codex colours the code, and a colour sequence ending in a letter hides its word boundary.
    const text = plain(output);
    const link = DEVICE_LINK.exec(text)?.[0];
    const userCode = DEVICE_CODE.exec(text)?.[0];
    return link && userCode ? { link, userCode } : null;
  }, LINK_TIMEOUT_MS, () => exited);
  if (!shown) {
    await cancel();
    return { ok: false, reason: "no_link" };
  }
  return {
    ok: true,
    ...shown,
    cancel,
    finish: async () => {
      const code = await Promise.race([done, Bun.sleep(DEVICE_TIMEOUT_MS).then(() => null)]);
      const value = code === 0 ? await readFile(join(home, "auth.json"), "utf8").catch(() => null) : null;
      await cancel();
      return value ? { ok: true, value } : { ok: false, reason: "no_token" };
    },
  };
}

export function startLogin(provider: CliProvider): Promise<LoginStart> {
  const binary = provider === "claude_code" ? Bun.which("claude", { PATH: process.env.PATH ?? "" }) : codexBinary();
  if (!binary) return Promise.resolve({ ok: false, reason: "not_installed" });
  return provider === "claude_code" ? claudeLogin(binary) : codexLogin(binary);
}
