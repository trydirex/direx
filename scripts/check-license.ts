// SPDX-License-Identifier: AGPL-3.0-only
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";

// SPDX headers on source files; no enterprise licence and no cloud package name anywhere, since
// core reaches cloud code only through its extension interfaces; the license files present; and
// every installed dependency under a license on the list below, since Direx can't relicense
// GPL or AGPL code it doesn't own (CONTRIBUTING.md).

const SKIP = new Set(["node_modules", "dist", "fixtures", ".git"]);
const SOURCE = /\.(ts|tsx|js|mjs|cjs)$/;
// Built by concatenation so this file does not trip its own check.
const ENTERPRISE = "LicenseRef-" + "Direx-Enterprise";
const CLOUD = ["direx" + "-cloud", "@direx" + "/cloud"];

function* walk(dir: string): Generator<string> {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.isDirectory()) {
      if (!SKIP.has(e.name)) yield* walk(join(dir, e.name));
    } else if (e.isFile()) yield join(dir, e.name);
  }
}

/** Every package.json under a node_modules folder. Symlinks are not followed, so Bun's store is read once. */
function* installed(dir: string, inside = false): Generator<string> {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.isDirectory()) {
      if (inside || e.name === "node_modules") yield* installed(join(dir, e.name), true);
      else if (!SKIP.has(e.name)) yield* installed(join(dir, e.name));
    } else if (inside && e.name === "package.json") yield join(dir, e.name);
  }
}

// What an installed dependency may be licensed under: the licenses in the tree on 2026-11-16, none of
// which stops Direx licensing its own code on other terms. Anything else is refused, GPL, AGPL and
// a package that states no license included, so a person reads a new license before adding it here.
// A choice ("MIT OR GPL-3.0-only") passes on an allowed side; AND and WITH are refused, not parsed.
const ALLOWED = new Set(["MIT", "MIT-0", "ISC", "Apache-2.0", "BSD-2-Clause", "BSD-3-Clause", "BSD", "0BSD", "BlueOak-1.0.0", "CC0-1.0", "Unlicense", "Python-2.0", "CC-BY-4.0", "OFL-1.1", "MPL-2.0"]);
const allowed = (licence: string) => !/\b(AND|WITH)\b/i.test(licence) && licence.replace(/[()]/g, "").split(/\s+OR\s+/i).some((l) => ALLOWED.has(l.trim()));
// A package's own package.json, not one it ships as a fixture: node_modules/<name> or node_modules/@scope/<name>.
const isPackageRoot = (file: string) => {
  const dirs = file.split(/[\\/]/).slice(0, -1);
  return dirs.at(-2) === "node_modules" || (dirs.at(-2)?.startsWith("@") === true && dirs.at(-3) === "node_modules");
};

function needsHeader(rel: string): boolean {
  if (!SOURCE.test(rel)) return false;
  if (!/^(apps|packages|scripts|test)\//.test(rel) && rel.includes("/")) return false;
  if (rel.endsWith(".d.ts") && !rel.startsWith("test/")) return false;
  return !rel.split("/").includes("generated");
}

const i = process.argv.indexOf("--root");
const root = resolve(i > 0 ? process.argv[i + 1]! : join(import.meta.dir, ".."));
const violations: string[] = [];

for (const file of walk(root)) {
  const rel = relative(root, file).split("\\").join("/");
  const bytes = readFileSync(file);
  if (bytes.includes(ENTERPRISE)) violations.push(`enterprise-licence ${rel}: contains ${ENTERPRISE}`);
  for (const name of CLOUD) if (bytes.includes(name)) violations.push(`cloud-package ${rel}: names ${name}`);
  if (!needsHeader(rel)) continue;
  const lines = bytes.toString("utf8").split("\n", 2);
  const first = (lines[0]!.startsWith("#!") ? lines[1] : lines[0])?.trimEnd();
  // The plugin SDK is MIT; everything else, the whole web app included, is AGPL.
  const id = rel.startsWith("packages/plugin-sdk/") ? "MIT" : "AGPL-3.0-only";
  const want = `// SPDX-License-Identifier: ${id}`;
  if (first !== want) violations.push(`spdx-header ${rel}: first line must be "${want}"`);
}

// The licenses the README names have to be there: a public repository without them grants nothing.
for (const rel of ["LICENSE", "packages/plugin-sdk/LICENSE", "skills/LICENSE"]) {
  if (!existsSync(join(root, rel))) violations.push(`license-file ${rel}: missing`);
}

const seen = new Set<string>();
for (const file of installed(root)) {
  if (!isPackageRoot(file)) continue;
  let pkg: { name?: string; version?: string; license?: unknown; licenses?: unknown };
  try {
    pkg = JSON.parse(readFileSync(file, "utf8"));
  } catch {
    // Not a package Bun installed: those all parse.
    continue;
  }
  if (!pkg.name) continue;
  // A string, an object with a type, or the old `licenses` list of either, which states a choice.
  const stated = [pkg.license, ...(Array.isArray(pkg.licenses) ? pkg.licenses : [])].map((l) => (typeof l === "string" ? l : ((l as { type?: string } | undefined)?.type ?? ""))).filter(Boolean);
  const licence = stated.join(" OR ");
  const id = `${pkg.name}@${pkg.version}`;
  if (seen.has(id) || allowed(licence)) continue;
  seen.add(id);
  violations.push(`dependency-license ${id}: ${licence || "none stated"}`);
}

for (const v of violations) console.log(v);
process.exit(violations.length ? 1 : 0);
