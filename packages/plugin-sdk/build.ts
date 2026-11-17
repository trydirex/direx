// SPDX-License-Identifier: MIT

// Builds dist/ for npm: tsc emits ESM and declarations, then every relative import gets the
// explicit .js extension Node needs, and every file the MIT header tsc drops from some of them.
// The monorepo itself imports src/ through the "bun" condition.
import { readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const HEADER = "// SPDX-License-Identifier: MIT\n";
const RELATIVE = /((?:from|import)\s*\(?\s*)(["'])(\.\.?\/[^"']+?)(?<!\.js)\2/g;

/** One emitted file with .js on each extensionless relative import or export, and the MIT header. */
export function fixEmitted(code: string): string {
  const out = code.replace(RELATIVE, "$1$2$3.js$2");
  return out.startsWith(HEADER) ? out : HEADER + out;
}

/** Rewrites every .js and .d.ts file in dir and the folders under it. */
export function rewriteDist(dir: string): void {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const file = join(dir, e.name);
    if (e.isDirectory()) rewriteDist(file);
    else if (e.name.endsWith(".js") || e.name.endsWith(".d.ts")) writeFileSync(file, fixEmitted(readFileSync(file, "utf8")));
  }
}

if (import.meta.main) {
  const dist = join(import.meta.dir, "dist");
  rmSync(dist, { recursive: true, force: true });
  const tsc = Bun.spawnSync([process.execPath, "x", "tsc", "-p", join(import.meta.dir, "tsconfig.build.json")], { stdout: "inherit", stderr: "inherit" });
  if (tsc.exitCode !== 0) process.exit(tsc.exitCode ?? 1);
  rewriteDist(dist);
}
