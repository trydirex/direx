// SPDX-License-Identifier: AGPL-3.0-only
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { expect, test } from "vitest";

const script = join(import.meta.dirname, "../check-web-rules.ts");

/** A temp root holding the given web app files, checked by the script. */
function check(files: Record<string, string>) {
  const root = mkdtempSync(join(tmpdir(), "direx-web-rules-"));
  for (const [rel, body] of Object.entries(files)) {
    mkdirSync(dirname(join(root, "apps/web/src", rel)), { recursive: true });
    writeFileSync(join(root, "apps/web/src", rel), body);
  }
  const r = Bun.spawnSync([process.execPath, script, "--root", root]);
  return { code: r.exitCode, out: r.stdout.toString() };
}

test("clean code passes: token classes, API calls in actions.ts, raw fetch in the two allowed files", () => {
  const r = check({
    "items/Home.tsx": `export const Home = () => <a href="#hold-hook" className="rounded-card bg-primary p-4 min-h-11">Needs you</a>;`,
    "items/actions.ts": `export const load = () => api.GET("/api/me");`,
    "identity/auth.ts": `export const post = () => fetch("/api/auth/sign-out");`,
    "social/actions.ts": `export const upload = () => fetch("/api/w/x/media");`,
    "items/Home.test.tsx": `api.GET("/x"); const c = "#ffffff";`,
  });
  expect(r).toEqual({ code: 0, out: "" });
});

test("each rule catches its case", () => {
  const r = check({
    "a/Call.tsx": `export const C = () => { void api.POST("/api/orgs"); return null; };`,
    "a/actions.ts": `export const f = () => fetch("/api/x");`,
    "a/Hex.tsx": `export const H = () => <p className="text-[#f00]">x</p>;`,
    "a/Pad.tsx": `export const P = () => <p className="p-[13px] hover:rounded-[7px]">x</p>;`,
    "a/Style.tsx": `export const S = () => <p style={{ color: "red" }}>x</p>;`,
    "a/Kit.tsx": `import { Menu } from "@base-ui/react/menu";`,
    "a/Deep.tsx": `import { Button } from "@astryxdesign/core/dist/Button/Button.js";`,
    "../package.json": JSON.stringify({ dependencies: { "@astryxdesign/core": "^0.7.11", "@stylexjs/stylex": "0.19.1" } }),
  });
  expect(r.code).toBe(1);
  for (const want of ["api-in-component apps/web/src/a/Call.tsx:1", "raw-fetch apps/web/src/a/actions.ts:1", "hex-colour apps/web/src/a/Hex.tsx:1", "arbitrary-value apps/web/src/a/Pad.tsx:1", "inline-style apps/web/src/a/Style.tsx:1", "other-primitives apps/web/src/a/Kit.tsx:1", "astryx-internal apps/web/src/a/Deep.tsx:1", "unpinned @astryxdesign/core"]) {
    expect(r.out).toContain(want);
  }
});

test("the real web app passes", () => {
  const r = Bun.spawnSync([process.execPath, script]);
  expect(r.stdout.toString()).toBe("");
  expect(r.exitCode).toBe(0);
});
