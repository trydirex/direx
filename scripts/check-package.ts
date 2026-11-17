// SPDX-License-Identifier: AGPL-3.0-only
import { readdirSync, readFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";

// Fails on install hooks, and on a second datastore beside Postgres, in any package.json.

const SKIP = new Set(["node_modules", "dist", "fixtures", ".git"]);
const BANNED = new Set(["redis", "ioredis", "bullmq", "bull", "graphile-worker"]);
const DEP_FIELDS = ["dependencies", "devDependencies", "optionalDependencies", "peerDependencies"];

function* walk(dir: string): Generator<string> {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.isDirectory()) {
      if (!SKIP.has(e.name)) yield* walk(join(dir, e.name));
    } else if (e.name === "package.json") yield join(dir, e.name);
  }
}

const banned = (name: string) => BANNED.has(name) || name.startsWith("@redis/");

const i = process.argv.indexOf("--root");
const root = resolve(i > 0 ? process.argv[i + 1]! : join(import.meta.dir, ".."));
const violations: string[] = [];

for (const file of walk(root)) {
  const rel = relative(root, file);
  const pkg = JSON.parse(readFileSync(file, "utf8"));
  for (const hook of ["preinstall", "install", "postinstall"]) {
    if (pkg.scripts?.[hook] !== undefined) violations.push(`install-time-code ${rel}: "${hook}" script`);
  }
  if (pkg.patchedDependencies !== undefined) violations.push(`install-time-code ${rel}: "patchedDependencies"`);
  if (pkg.trustedDependencies?.length) violations.push(`install-time-code ${rel}: non-empty "trustedDependencies"`);
  for (const field of DEP_FIELDS) {
    for (const [name, spec] of Object.entries<string>(pkg[field] ?? {})) {
      const alias = spec.startsWith("npm:") ? spec.slice(4).replace(/(.)@.*$/, "$1") : "";
      if (banned(name) || banned(alias)) violations.push(`second-datastore ${rel}: ${field} "${name}" (jobs run on pg-boss)`);
    }
  }
}

for (const v of violations) console.log(v);
process.exit(violations.length ? 1 : 0);
