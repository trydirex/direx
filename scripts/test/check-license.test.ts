// SPDX-License-Identifier: AGPL-3.0-only
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { expect, test } from "vitest";

const script = join(import.meta.dirname, "../check-license.ts");
const AGPL = "// SPDX-License-Identifier: AGPL-3.0-only\n";
const MIT = "// SPDX-License-Identifier: MIT\n";

const LICENSES: Record<string, string> = { LICENSE: "AGPL", "packages/plugin-sdk/LICENSE": "MIT", "skills/LICENSE": "MIT" };

/** A temp root holding the given files and, unless told otherwise, the three license files, checked by the script. */
function check(files: Record<string, string>, licenses = LICENSES) {
  const root = mkdtempSync(join(tmpdir(), "direx-license-"));
  for (const [rel, body] of Object.entries({ ...licenses, ...files })) {
    mkdirSync(dirname(join(root, rel)), { recursive: true });
    writeFileSync(join(root, rel), body);
  }
  const r = Bun.spawnSync([process.execPath, script, "--root", root]);
  return { code: r.exitCode, out: r.stdout.toString() };
}

test("the whole web app is AGPL, the old copied-components folder included", () => {
  expect(check({ "apps/web/src/components/Button.tsx": AGPL, "apps/web/src/App.tsx": AGPL }).code).toBe(0);
  const r = check({ "apps/web/src/components/ui/button.tsx": MIT });
  expect(r.code).toBe(1);
  expect(r.out).toContain('spdx-header apps/web/src/components/ui/button.tsx: first line must be "// SPDX-License-Identifier: AGPL-3.0-only"');
});

test("an MIT header anywhere in the web app is refused", () => {
  const r = check({ "apps/web/src/components/Shell.tsx": MIT });
  expect(r.code).toBe(1);
  expect(r.out).toContain('spdx-header apps/web/src/components/Shell.tsx: first line must be "// SPDX-License-Identifier: AGPL-3.0-only"');
});

const dep = (name: string, fields: Record<string, unknown>, at = `node_modules/.bun/${name}@1.0.0/node_modules/${name}`) => ({ [`${at}/package.json`]: JSON.stringify({ name, version: "1.0.0", ...fields }) });

test("a repository missing one of its three license files is refused", () => {
  expect(check({})).toEqual({ code: 0, out: "" });
  expect(check({}, { "packages/plugin-sdk/LICENSE": "MIT", "skills/LICENSE": "MIT" })).toEqual({ code: 1, out: "license-file LICENSE: missing\n" });
});

test("a dependency passes on an allowed license, stated any of the ways npm allows, and a fixture inside it isn't read as a package", () => {
  const fine = {
    ...dep("plain", { license: "MIT" }),
    ...dep("choice", { license: "(MIT OR GPL-3.0-only)" }),
    ...dep("typed", { license: { type: "Apache-2.0" } }),
    ...dep("listed", { licenses: [{ type: "GPL-2.0" }, "ISC"] }),
    ...dep("scoped", { license: "BSD-3-Clause" }, "node_modules/@scope/scoped"),
    "node_modules/plain/test/fixtures/inner/package.json": JSON.stringify({ name: "inner", version: "0.0.1" }),
    "node_modules/plain/test/broken/package.json": "{",
    "node_modules/.cache/package.json": JSON.stringify({ type: "module" }),
  };
  expect(check(fine)).toEqual({ code: 0, out: "" });
});

test("a dependency under the GPL, the AGPL, the LGPL, an unknown license, a joined expression or no stated license is refused, once each", () => {
  const r = check({
    ...dep("strong", { license: "GPL-3.0-only" }),
    ...dep("strong", { license: "GPL-3.0-only" }, "apps/api/node_modules/strong"),
    ...dep("network", { license: { type: "AGPL-3.0-only" } }),
    ...dep("weak", { license: "LGPL-3.0-or-later" }),
    ...dep("both", { license: "GPL-3.0-only AND (MIT OR Apache-2.0)" }),
    ...dep("either-way", { license: "(GPL-3.0-only OR LicenseRef-Proprietary)" }),
    ...dep("old-list", { licenses: [{ type: "GPL-2.0" }] }),
    ...dep("words", { license: "SEE LICENSE IN LICENSE.txt" }),
    ...dep("unstated", {}),
  });
  expect(r.code).toBe(1);
  expect(r.out.split("\n").filter(Boolean).sort()).toEqual([
    "dependency-license both@1.0.0: GPL-3.0-only AND (MIT OR Apache-2.0)",
    "dependency-license either-way@1.0.0: (GPL-3.0-only OR LicenseRef-Proprietary)",
    "dependency-license network@1.0.0: AGPL-3.0-only",
    "dependency-license old-list@1.0.0: GPL-2.0",
    "dependency-license strong@1.0.0: GPL-3.0-only",
    "dependency-license unstated@1.0.0: none stated",
    "dependency-license weak@1.0.0: LGPL-3.0-or-later",
    "dependency-license words@1.0.0: SEE LICENSE IN LICENSE.txt",
  ]);
});
