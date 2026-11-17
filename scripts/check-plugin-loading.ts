// SPDX-License-Identifier: AGPL-3.0-only
import { readdirSync, readFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import ts from "typescript";

// Third-party plugin code runs only as its own process, started with an environment
// built from nothing. Fails on the two ways around that in app source: a dynamic
// import() of anything but a fixed relative path, and handing process.env to a child.
// Test files are exempt: they start the host's own worker, which needs the host's env.
// It also fails when app code names a provider plugin's id: core code never branches on
// a provider, so provider differences stay behind the plugin contract.
// And it fails on `confinement: "external"` written as a literal: the host may say third-party
// plugins are confined only where it was handed the sandbox spawner (ADR 0026 rule 009).

const SKIP = new Set(["node_modules", "dist", "fixtures", "generated", ".git"]);
const SPAWN = new Set(["spawn", "spawnSync", "fork", "exec", "execFile", "execSync"]);

function* walk(dir: string): Generator<string> {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    if (e.isDirectory()) {
      if (!SKIP.has(e.name)) yield* walk(join(dir, e.name));
    } else if (/\.(ts|tsx|js|mjs)$/.test(e.name) && !/\.(d|test|spec)\.ts$/.test(e.name)) yield join(dir, e.name);
  }
}

const isProcessEnv = (n: ts.Node) =>
  ts.isPropertyAccessExpression(n) && ts.isIdentifier(n.expression) && n.expression.text === "process" && n.name.text === "env";

function calleeName(e: ts.Expression): string | undefined {
  if (ts.isIdentifier(e)) return e.text;
  if (ts.isPropertyAccessExpression(e)) return e.name.text;
  return undefined;
}

function check(file: string, rel: string, out: string[], pluginIds: Set<string>) {
  const src = ts.createSourceFile(file, readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true);
  const report = (n: ts.Node, msg: string) =>
    out.push(`plugin-boundary ${rel}:${src.getLineAndCharacterOfPosition(n.getStart()).line + 1}: ${msg}`);

  const visit = (n: ts.Node): void => {
    // Also catches a capability id, "<plugin id>/<capability>".
    const named = ts.isStringLiteralLike(n) ? n.text.split("/")[0] : undefined;
    if (named && pluginIds.has(named)) {
      report(n, `app code names the plugin ${named}; reach provider behaviour only through the plugin contract`);
    }
    if (ts.isPropertyAssignment(n) && n.name.getText(src) === "confinement" && ts.isStringLiteralLike(n.initializer) && n.initializer.text === "external") {
      report(n, 'confinement is "external" only where the sandbox spawner is in use; derive it from confinedSpawn, never write it');
    }
    if (ts.isCallExpression(n) && n.expression.kind === ts.SyntaxKind.ImportKeyword) {
      const arg = n.arguments[0];
      if (!arg || !ts.isStringLiteralLike(arg) || !arg.text.startsWith(".")) {
        report(n, "load plugin code only as a separate process; app code may import() only a fixed relative path");
      }
    }
    if (ts.isCallExpression(n) && SPAWN.has(calleeName(n.expression) ?? "")) {
      const inner = (m: ts.Node): void => {
        if ((ts.isSpreadAssignment(m) || ts.isSpreadElement(m)) && isProcessEnv(m.expression)) {
          report(m, "a child process gets an environment built from nothing, never the host's process.env");
        } else if (ts.isPropertyAssignment(m) && m.name.getText(src) === "env" && isProcessEnv(m.initializer)) {
          report(m, "a child process gets an environment built from nothing, never the host's process.env");
        }
        ts.forEachChild(m, inner);
      };
      n.arguments.forEach(inner);
    }
    ts.forEachChild(n, visit);
  };
  visit(src);
}

const i = process.argv.indexOf("--root");
const root = resolve(i > 0 ? process.argv[i + 1]! : join(import.meta.dir, ".."));
const violations: string[] = [];
let apps: string[] = [];
try {
  apps = readdirSync(join(root, "apps"));
} catch {
  // no apps folder: nothing to check
}
// Provider plugin ids, from each manifest.ts under packages/extensions.
const pluginIds = new Set<string>();
for (const f of walk(join(root, "packages", "extensions", "src"))) {
  if (!f.endsWith("manifest.ts")) continue;
  for (const m of readFileSync(f, "utf8").matchAll(/\bid:\s*"([a-z0-9]+(?:\.[a-z0-9-]+)+)"/g)) pluginIds.add(m[1]!);
}
for (const app of apps) for (const f of walk(join(root, "apps", app, "src"))) check(f, relative(root, f), violations, pluginIds);

for (const v of violations) console.log(v);
process.exit(violations.length ? 1 : 0);
