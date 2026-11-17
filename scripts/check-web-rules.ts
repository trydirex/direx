// SPDX-License-Identifier: AGPL-3.0-only
// The web app's two consistency rules, checked on every source file:
// 1. Components never call the API: no `api.GET`-style call and no `fetch(` in a .tsx file. API calls
//    live in each folder's actions.ts, and raw `fetch` only where the OpenAPI client can't go (Better
//    Auth's endpoints, and file uploads sent as a raw body).
// 2. Style comes from the tokens: no hex colour, no Tailwind arbitrary value for colour, size, spacing,
//    radius, shadow or type, and no inline style setting any of them.
// 3. Interactive parts come from Astryx (ADR 0020): no import of another primitive library, Astryx only
//    by its public per-component paths, and Astryx and StyleX pinned to exact versions.
// Exit 0 clean, 1 with findings.
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";

const i = process.argv.indexOf("--root");
const root = resolve(i > 0 ? process.argv[i + 1]! : join(import.meta.dir, ".."));
const web = join(root, "apps/web/src");

const RAW_FETCH_ALLOWED = new Set(["apps/web/src/identity/auth.ts", "apps/web/src/social/actions.ts"]);
const API_CALL = /\bapi\.(GET|POST|PUT|PATCH|DELETE)\b/;
const RAW_FETCH = /(?<![.\w])fetch\(/;
const HEX = /#[0-9a-fA-F]{3}(?:[0-9a-fA-F]{3})?(?![\w-])/;
const ARBITRARY =
  /(?<![\w-])(?:[a-z-]+:)*-?(?:bg|text|border(?:-[trblxy])?|ring|outline|fill|stroke|shadow|rounded(?:-[a-z]+)?|p[trblxyse]?|m[trblxyse]?|gap(?:-[xy])?|w|h|size|min-w|min-h|max-w|max-h|leading|tracking|font)-\[[^\]]+\]/;
const OTHER_KIT = /from "(@base-ui\/react|@radix-ui\/|react-aria|@react-aria\/|@headlessui\/)/;
const ASTRYX_PRIVATE = /from "@astryxdesign\/[^/"]+\/(src|dist|internal)\b/;
const PINNED = ["@astryxdesign/core", "@astryxdesign/theme-neutral", "@stylexjs/stylex"];
const INLINE_STYLE = /style=\{\{[^}]*\b(color|background|border|font|padding|margin|radius|shadow)/i;

function* sources(dir: string): Generator<string> {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, e.name);
    if (e.isDirectory()) yield* sources(path);
    else if (/\.(ts|tsx)$/.test(e.name) && !/\.test\.tsx?$|\.d\.ts$/.test(e.name)) yield path;
  }
}

const findings: string[] = [];
for (const file of sources(web)) {
  const rel = relative(root, file).split("\\").join("/");
  readFileSync(file, "utf8")
    .split("\n")
    .forEach((line, n) => {
      const at = `${rel}:${n + 1}`;
      if (rel.endsWith(".tsx") && API_CALL.test(line)) findings.push(`api-in-component ${at}: move the call into the folder's actions.ts`);
      if (RAW_FETCH.test(line) && !RAW_FETCH_ALLOWED.has(rel)) findings.push(`raw-fetch ${at}: use the typed api client in actions.ts`);
      if (OTHER_KIT.test(line)) findings.push(`other-primitives ${at}: interactive parts come from @astryxdesign/core`);
      if (ASTRYX_PRIVATE.test(line)) findings.push(`astryx-internal ${at}: import Astryx by its public path, such as @astryxdesign/core/Button`);
      if (HEX.test(line)) findings.push(`hex-colour ${at}: use a colour token from styles.css`);
      if (ARBITRARY.test(line)) findings.push(`arbitrary-value ${at}: use a token class, not [${line.match(ARBITRARY)![0].split("[")[1]}`);
      if (INLINE_STYLE.test(line)) findings.push(`inline-style ${at}: use token classes; inline style is for computed layout only`);
    });
}

const manifest = join(root, "apps/web/package.json");
if (existsSync(manifest)) {
  const deps: Record<string, string> = JSON.parse(readFileSync(manifest, "utf8")).dependencies ?? {};
  for (const name of PINNED) if (deps[name] && !/^\d+\.\d+\.\d+$/.test(deps[name])) findings.push(`unpinned ${name}: pin an exact version, not ${deps[name]}`);
}

for (const f of findings) console.log(f);
process.exit(findings.length ? 1 : 0);
