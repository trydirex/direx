// SPDX-License-Identifier: AGPL-3.0-only
// The real server process with no key configured: it generates one, reuses it, and refuses
// to start once that key is lost. The server, not the worker, since the worker no longer starts
// on its own (ADR 0027).
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";

const ENTRY = join(import.meta.dirname, "../../main.ts");
const DIR = join(mkdtempSync(join(tmpdir(), "direx-start-")), "data");
const file = join(DIR, "master.key");

function start() {
  const env: Record<string, string | undefined> = { ...process.env, DIREX_DATA_DIR: DIR, PORT: "0" };
  delete env.DIREX_APPROVAL_KEY;
  delete env.DIREX_MASTER_KEY;
  delete env.DIREX_MASTER_KEY_FILE;
  return Bun.spawn([process.execPath, ENTRY], { env, stdout: "pipe", stderr: "pipe" });
}

test("a fresh start generates a key, a restart reuses it, and a lost key refuses to start", { timeout: 60_000 }, async () => {
  const first = start();
  await expect.poll(() => existsSync(file), { timeout: 20_000, interval: 100 }).toBe(true);
  const key = readFileSync(file, "utf8");
  first.kill();
  await first.exited;

  const second = start();
  // Still running after a moment means it passed the key check, which happens first.
  const stillUp = await Promise.race([second.exited.then(() => false), Bun.sleep(3_000).then(() => true)]);
  second.kill();
  await second.exited;
  expect(stillUp).toBe(true);
  expect(readFileSync(file, "utf8")).toBe(key);

  rmSync(file);
  const third = start();
  expect(await third.exited).not.toBe(0);
  expect(await new Response(third.stderr).text()).toContain("no root key found");
  expect(existsSync(file)).toBe(false);
});
