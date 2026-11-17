// SPDX-License-Identifier: AGPL-3.0-only
// Runs a CLI where a hostile page can reach nothing: a temporary home, no host files, only the
// environment given here, and no network except a proxy that allows named hosts. Where this
// can't hold, nothing runs.
import { closeSync, existsSync, openSync, realpathSync } from "node:fs";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import type { Server } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { readLines } from "@direx/plugin-sdk/host";
import { exactTargets, manifestHosts, startEgressProxy } from "./egress";
import { seccompFilter } from "./seccomp";

const HOME = "/home/direx";
const RUN_DIR = "/run/direx";
const WORK_DIR = "/work";
const IN_DIR = "/in";
const INPUT_NAME = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const PROXY_PORT = 31337;
// /etc/alternatives holds only symlinks; Debian reaches some libraries ffmpeg loads (BLAS) through it.
const SYSTEM_PATHS = ["/usr", "/etc/ssl", "/etc/ca-certificates", "/etc/pki", "/etc/ld.so.cache", "/etc/localtime", "/etc/alternatives"];
const BASE_ARGS = [
  "--die-with-parent", "--new-session", "--unshare-all",
  "--tmpfs", "/", "--proc", "/proc", "--dev", "/dev", "--tmpfs", "/tmp",
  "--symlink", "usr/bin", "/bin", "--symlink", "usr/sbin", "/sbin", "--symlink", "usr/lib", "/lib", "--symlink", "usr/lib64", "/lib64",
];

export type SandboxStatus = { ok: true } | { ok: false; reason: string };

const NO_LINUX = "This needs a Linux sandbox. Run Direx with deploy/docker/compose.yml or use an API key.";
const NO_BWRAP = "This needs bubblewrap (bwrap), which isn't installed. Install it, run Direx with deploy/docker/compose.yml or use an API key.";
const BWRAP_BLOCKED = "bubblewrap (bwrap) can't create a sandbox on this host, often because user namespaces are blocked. Allow them or use an API key.";
// Default Docker settings block the sandbox; the shipped compose file carries the ones that allow it.
const BWRAP_BLOCKED_IN_DOCKER = "bubblewrap (bwrap) can't create a sandbox in this container. Start it with deploy/docker/compose.yml, whose seccomp profile and security settings allow it, or use an API key.";

const systemBinds = () => SYSTEM_PATHS.filter((p) => existsSync(p)).flatMap((p) => ["--ro-bind", p, p]);

export async function sandboxStatus(): Promise<SandboxStatus> {
  if (process.platform !== "linux") return { ok: false, reason: NO_LINUX };
  if (!Bun.which("bwrap")) return { ok: false, reason: NO_BWRAP };
  const probe = Bun.spawn(["bwrap", ...BASE_ARGS, ...systemBinds(), "--", "/usr/bin/true"], { env: {}, stdout: "ignore", stderr: "ignore" });
  if ((await probe.exited) === 0) return { ok: true };
  return { ok: false, reason: existsSync("/.dockerenv") ? BWRAP_BLOCKED_IN_DOCKER : BWRAP_BLOCKED };
}

/** Inside the sandbox: loopback to the proxy's socket, then the CLI. Secrets never pass through it. */
const BRIDGE = `
const net = require("node:net");
const { spawn } = require("node:child_process");
const [socketPath, binary, ...args] = process.argv.slice(2);
const server = net.createServer((client) => {
  const upstream = net.connect(socketPath);
  client.pipe(upstream);
  upstream.pipe(client);
  const close = () => { client.destroy(); upstream.destroy(); };
  client.on("error", close);
  upstream.on("error", close);
});
server.listen(${PROXY_PORT}, "127.0.0.1", () => {
  const child = spawn(binary, args, { stdio: "inherit", env: process.env });
  child.on("exit", (code) => process.exit(code ?? 1));
});
`;

export type SandboxRun = {
  binary: string;
  args: readonly string[];
  env: Readonly<Record<string, string>>;
  stdin: string;
  /** Exact `host:port` entries the CLI may reach. */
  egress: readonly string[];
  /** Written under the temporary home before the run, by path relative to it. */
  files?: Readonly<Record<string, string>>;
  /** Read back from the temporary home after the run. */
  readBack?: readonly string[];
  /**
   * A host directory the run reads and writes at /work, and starts in, for binary files such as a
   * video, which `files` and `readBack` can't carry. The caller owns it and removes it. `inputs` are
   * host files the run may only read, each at /in/<name>, so a large file isn't copied.
   */
  work?: { dir: string; inputs?: Readonly<Record<string, string>> };
  signal: AbortSignal;
  /** Which resolved addresses the proxy may reach. Defaults to public ones that aren't this server's. */
  allowAddress?: (address: string) => boolean;
};

export type SandboxResult =
  | { ran: false; reason: string }
  | { ran: true; exitCode: number; stdout: string; stderr: string; files: Record<string, string> };

/** A name is never a path, so an input can't land outside /in. */
function inputBinds(inputs: Readonly<Record<string, string>>): string[] {
  return Object.entries(inputs).flatMap(([name, host]) => {
    if (!INPUT_NAME.test(name)) throw new Error(`sandbox: input name ${JSON.stringify(name)} is not a plain file name`);
    return ["--ro-bind", realpathSync(host), `${IN_DIR}/${name}`];
  });
}

export async function runSandboxed(r: SandboxRun): Promise<SandboxResult> {
  if (r.signal.aborted) return { ran: false, reason: "The call was cancelled." };
  const status = await sandboxStatus();
  if (!status.ok) return { ran: false, reason: status.reason };

  const root = await mkdtemp(join(tmpdir(), "direx-cli-"));
  let proxy: Server | undefined;
  try {
    const home = join(root, "home");
    const run = join(root, "run");
    await mkdir(home, { mode: 0o700 });
    await mkdir(run, { mode: 0o700 });
    for (const [path, content] of Object.entries(r.files ?? {})) {
      const file = join(home, path);
      await mkdir(dirname(file), { recursive: true });
      await writeFile(file, content, { mode: 0o600 });
    }
    await writeFile(join(run, "bridge.cjs"), BRIDGE);
    await chmod(join(run, "bridge.cjs"), 0o400);
    proxy = await startEgressProxy(join(run, "proxy.sock"), { allow: exactTargets(r.egress), ...(r.allowAddress && { allowAddress: r.allowAddress }) });

    const binary = realpathSync(r.binary);
    const bun = realpathSync(process.execPath);
    const proxyUrl = `http://127.0.0.1:${PROXY_PORT}`;
    const child = Bun.spawn(
      [
        "bwrap",
        ...BASE_ARGS,
        ...systemBinds(),
        "--ro-bind", bun, bun,
        "--ro-bind", dirname(binary), dirname(binary),
        "--bind", home, HOME,
        "--bind", run, RUN_DIR,
        ...(r.work ? ["--bind", realpathSync(r.work.dir), WORK_DIR, ...inputBinds(r.work.inputs ?? {}), "--chdir", WORK_DIR] : ["--chdir", HOME]),
        "--",
        bun, `${RUN_DIR}/bridge.cjs`, `${RUN_DIR}/proxy.sock`, binary, ...r.args,
      ],
      {
        env: { PATH: "/usr/bin:/bin", HOME, TMPDIR: "/tmp", HTTPS_PROXY: proxyUrl, https_proxy: proxyUrl, HTTP_PROXY: proxyUrl, http_proxy: proxyUrl, NO_PROXY: "", no_proxy: "", ...r.env },
        stdin: new TextEncoder().encode(r.stdin),
        stdout: "pipe",
        stderr: "pipe",
        signal: r.signal,
      },
    );
    const [stdout, stderr, exitCode] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    const files: Record<string, string> = {};
    for (const path of r.readBack ?? []) {
      const file = join(home, path);
      if (existsSync(file)) files[path] = await readFile(file, "utf8");
    }
    return { ran: true, exitCode, stdout, stderr, files };
  } finally {
    proxy?.close();
    await rm(root, { recursive: true, force: true });
  }
}

const PLUGIN_FILE = "/plugin/plugin.js";
const PLUGIN_TMP_BYTES = 64 * 1024 * 1024;
const NO_SECCOMP = "libseccomp, which comes with bubblewrap, isn't installed, so a plugin can't be confined. Install it or run Direx with deploy/docker/compose.yml.";

/** A long-lived process in the sandbox, speaking over its stdio. Only `spawnSandboxed` makes one. */
export type SandboxedProcess = {
  pid: number;
  /** Writes one line and flushes it. Throws when the pipe is closed. */
  write(line: string): void;
  stdout: ReadableStream<Uint8Array>;
  exited: Promise<number | null>;
  /** SIGTERM reaches bwrap, which then kills the process at once; a clean stop goes through stdin. */
  kill(signal: "SIGTERM" | "SIGKILL"): void;
  confined: true;
};

export type SandboxSpawn = {
  /** The plugin's one bundled file, bound read-only at /plugin/plugin.js and nothing else of the host's. */
  file: string;
  /** Manifest egress hosts, reachable on 443 only. */
  egressHosts: readonly string[];
  onStderr: (line: string) => void;
  onRefused?: (target: string, why: string) => void;
  /** Which resolved addresses the proxy may reach. Defaults to public ones that aren't this server's. */
  allowAddress?: (address: string) => boolean;
};

/**
 * Starts a third-party plugin (ADR 0026 rules 006 and 007): every namespace unshared and no nested
 * user namespaces, a seccomp filter of its own, a 64 MB /tmp, system paths and its one file read-only,
 * a fixed environment, and a proxy of its own as its only network. Where any of that can't hold,
 * nothing starts and the reason says why.
 */
export async function spawnSandboxed(s: SandboxSpawn): Promise<{ ok: true; process: SandboxedProcess } | { ok: false; reason: string }> {
  const status = await sandboxStatus();
  if (!status.ok) return status;
  const filter = await seccompFilter();
  if (!filter) return { ok: false, reason: NO_SECCOMP };

  const root = await mkdtemp(join(tmpdir(), "direx-plugin-"));
  const run = join(root, "run");
  await mkdir(run, { mode: 0o700 });
  await writeFile(join(run, "bridge.cjs"), BRIDGE);
  await chmod(join(run, "bridge.cjs"), 0o400);
  const proxy = await startEgressProxy(join(run, "proxy.sock"), {
    allow: manifestHosts(s.egressHosts),
    ...(s.onRefused && { onRefused: s.onRefused }),
    ...(s.allowAddress && { allowAddress: s.allowAddress }),
  });

  const bun = realpathSync(process.execPath);
  const proxyUrl = `http://127.0.0.1:${PROXY_PORT}`;
  const seccomp = openSync(filter, "r");
  let child;
  try {
    child = Bun.spawn(
      [
        "bwrap",
        "--die-with-parent", "--new-session", "--unshare-all", "--unshare-user", "--disable-userns",
        "--tmpfs", "/", "--proc", "/proc", "--dev", "/dev", "--size", String(PLUGIN_TMP_BYTES), "--tmpfs", "/tmp",
        "--symlink", "usr/bin", "/bin", "--symlink", "usr/sbin", "/sbin", "--symlink", "usr/lib", "/lib", "--symlink", "usr/lib64", "/lib64",
        ...systemBinds(),
        "--ro-bind", bun, bun,
        "--ro-bind", realpathSync(s.file), PLUGIN_FILE,
        // Read-only: connecting to the proxy's socket works through it, and nothing can be written there.
        "--ro-bind", run, RUN_DIR,
        "--seccomp", "3",
        "--chdir", "/tmp",
        "--",
        bun, `${RUN_DIR}/bridge.cjs`, `${RUN_DIR}/proxy.sock`, bun, PLUGIN_FILE,
      ],
      {
        env: { PATH: "/usr/bin:/bin", HOME: "/tmp", DIREX_PLUGIN_DIR: "/plugin", HTTPS_PROXY: proxyUrl, https_proxy: proxyUrl, HTTP_PROXY: proxyUrl, http_proxy: proxyUrl },
        stdio: ["pipe", "pipe", "pipe", seccomp],
      },
    );
  } catch (e) {
    proxy.close();
    await rm(root, { recursive: true, force: true });
    throw e;
  } finally {
    closeSync(seccomp);
  }
  const spawned = child;
  void (async () => {
    for await (const line of readLines(spawned.stderr)) s.onStderr(line);
  })().catch(() => {});
  void spawned.exited.finally(async () => {
    proxy.close();
    await rm(root, { recursive: true, force: true });
  });
  return {
    ok: true,
    process: {
      pid: spawned.pid,
      write(line) {
        spawned.stdin.write(line);
        spawned.stdin.flush();
      },
      stdout: spawned.stdout,
      exited: spawned.exited,
      kill: (signal) => spawned.kill(signal),
      confined: true,
    },
  };
}
