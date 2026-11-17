// SPDX-License-Identifier: AGPL-3.0-only
// Starts one plugin process. The environment is built from nothing: the child gets PATH
// and its own directory, never the host's variables, so no host secret can leak in.
import { readLines } from "@direx/plugin-sdk/host";

export type PluginProcess = {
  pid: number;
  /** Writes one line and flushes it. Throws when the pipe is closed. */
  write(line: string): void;
  stdout: ReadableStream<Uint8Array>;
  exited: Promise<number | null>;
  kill(signal: "SIGTERM" | "SIGKILL"): void;
};

export function spawnPlugin(entry: string, dir: string, onStderr: (line: string) => void): PluginProcess {
  const child = Bun.spawn([process.execPath, entry], {
    cwd: dir,
    env: { PATH: process.env.PATH ?? "", DIREX_PLUGIN_DIR: dir },
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
  });
  // Drained from the start: a full stderr pipe would block the child.
  void (async () => {
    for await (const line of readLines(child.stderr)) onStderr(line);
  })().catch(() => {});
  return {
    pid: child.pid,
    write(line) {
      child.stdin.write(line);
      child.stdin.flush();
    },
    stdout: child.stdout,
    exited: child.exited,
    kill: (signal) => child.kill(signal),
  };
}
