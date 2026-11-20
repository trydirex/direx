// SPDX-License-Identifier: AGPL-3.0-only
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { resolveShippedCodex } from "./adapters/runtime/codex";

test("a missing Codex wrapper is reported as not installed", async () => {
  const dir = await mkdtemp(join(tmpdir(), "direx-codex-resolution-"));
  try {
    // An empty local install keeps Bun from resolving packages from its global cache.
    await writeFile(join(dir, "package.json"), "{}");
    await mkdir(join(dir, "node_modules"));
    expect(resolveShippedCodex(join(dir, "entry.js"))).toBeNull();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("unexpected wrapper lookup failures propagate", () => {
  expect(() => resolveShippedCodex("relative-entry.js")).toThrow("relative-entry.js");
});
