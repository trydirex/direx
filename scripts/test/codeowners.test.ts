// SPDX-License-Identifier: AGPL-3.0-only
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "vitest";

const root = join(import.meta.dirname, "../..");

// A renamed folder would silently drop its required review, so every owned path must exist.
test("every CODEOWNERS path exists", () => {
  const paths = readFileSync(join(root, ".github/CODEOWNERS"), "utf8")
    .split("\n")
    .filter((line) => line.trim() !== "" && !line.startsWith("#"))
    .map((line) => line.split(/\s+/)[0] ?? "");
  expect(paths.length).toBeGreaterThan(0);
  expect(paths.filter((p) => !existsSync(join(root, p)))).toEqual([]);
});
