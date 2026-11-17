// SPDX-License-Identifier: MIT
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { fixEmitted, rewriteDist } from "../build";

const MIT = "// SPDX-License-Identifier: MIT\n";

test("relative imports and exports get .js; packages, node: and .js imports stay as they are", () => {
  const code = [
    'export { a } from "./effect";',
    "import type { B } from '../rpc';",
    'export * from "./media";',
    'type C = import("./manifest").Manifest;',
    'import { z } from "zod";',
    'import { Readable } from "node:stream";',
    'export { d } from "./done.js";',
  ].join("\n");
  expect(fixEmitted(code)).toBe(
    MIT +
      [
        'export { a } from "./effect.js";',
        "import type { B } from '../rpc.js';",
        'export * from "./media.js";',
        'type C = import("./manifest.js").Manifest;',
        'import { z } from "zod";',
        'import { Readable } from "node:stream";',
        'export { d } from "./done.js";',
      ].join("\n"),
  );
});

test("the MIT header is added once, where tsc dropped it", () => {
  expect(fixEmitted(`${MIT}export const x = 1;\n`)).toBe(`${MIT}export const x = 1;\n`);
  expect(fixEmitted("export const x = 1;\n")).toBe(`${MIT}export const x = 1;\n`);
});

test("rewriteDist fixes the .js and .d.ts files, in folders too, and leaves anything else alone", () => {
  const dir = mkdtempSync(join(tmpdir(), "direx-sdk-build-"));
  try {
    mkdirSync(join(dir, "catalogue"));
    writeFileSync(join(dir, "catalogue", "index.js"), 'export * from "../a";\n');
    writeFileSync(join(dir, "index.js"), 'export * from "./a";\n');
    writeFileSync(join(dir, "index.d.ts"), 'export * from "./a";\n');
    writeFileSync(join(dir, "notes.txt"), 'from "./a"\n');
    rewriteDist(dir);
    expect(readFileSync(join(dir, "index.js"), "utf8")).toBe(`${MIT}export * from "./a.js";\n`);
    expect(readFileSync(join(dir, "index.d.ts"), "utf8")).toBe(`${MIT}export * from "./a.js";\n`);
    expect(readFileSync(join(dir, "notes.txt"), "utf8")).toBe('from "./a"\n');
    expect(readFileSync(join(dir, "catalogue", "index.js"), "utf8")).toBe(`${MIT}export * from "../a.js";\n`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
