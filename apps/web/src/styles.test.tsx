// SPDX-License-Identifier: AGPL-3.0-only
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { expect, test } from "vitest";
import { render, screen } from "@testing-library/react";
import { compile } from "tailwindcss";
import { Tokens } from "./dev/Tokens";
import { STATE_LABEL } from "./items/actions";
import { STATE_STYLE, WarningCount } from "./items/StateChip";

// Read from disk: Vitest stubs CSS imports, `?raw` included. Paths start at the Vitest root, because
// import.meta.url is not a file URL under happy-dom.
const css = readFileSync(resolve("apps/web/src/styles.css"), "utf8");
const require = createRequire(resolve("apps/web/package.json"));
const build = async (classes: string[]) => {
  const compiler = await compile(css, {
    base: resolve("apps/web/src"),
    loadStylesheet: async (id, base) => {
      const path = id.startsWith(".") ? resolve(base, id) : require.resolve(id === "tailwindcss" ? "tailwindcss/index.css" : id);
      return { path, base: dirname(path), content: readFileSync(path, "utf8") };
    },
  });
  return compiler.build(classes);
};

test("only the Direx tokens exist: Tailwind's palette and shadows produce no CSS", async () => {
  const out = await build(["bg-blue-500", "text-red-600", "shadow-md", "rounded-lg", "bg-primary", "rounded-card", "text-base", "max-w-content", "rounded-control", "bg-warning", "bg-primary-tint", "font-display"]);
  for (const gone of ["bg-blue-500", "text-red-600", "shadow-md", "rounded-lg"]) expect(out).not.toContain(`.${gone}`);
  for (const kept of ["bg-primary", "rounded-card", "text-base", "max-w-content", "rounded-control", "bg-warning", "bg-primary-tint", "font-display"]) expect(out).toContain(`.${kept}`);
  const focus = await build(["focus-visible:outline-2", "focus-visible:outline-ring", "focus-visible:outline-offset-2"]);
  expect(focus).toContain("outline-width: 2px");
  expect(focus).toContain("outline-color: var(--ring)");
});

// WCAG relative luminance and contrast ratio.
const hex = Object.fromEntries([...css.matchAll(/--([\w-]+):\s*(#[0-9a-f]{6});/gi)].map((m) => [m[1], m[2]]));
const channel = (h: string, k: number) => {
  const c = parseInt(h.slice(1 + 2 * k, 3 + 2 * k), 16) / 255;
  return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
};
const lum = (name: string) => {
  const h = hex[name];
  if (!h) throw new Error(`no hex value for --${name} in styles.css`);
  return [0.2126, 0.7152, 0.0722].reduce((sum, w, k) => sum + w * channel(h, k), 0);
};
const ratio = (a: string, b: string) => (Math.max(lum(a), lum(b)) + 0.05) / (Math.min(lum(a), lum(b)) + 0.05);

test.each([
  // Text pairs need 4.5:1.
  ["foreground", "background", 4.5],
  ["foreground", "muted", 4.5],
  ["foreground", "card", 4.5],
  ["muted-foreground", "card", 4.5],
  ["primary", "primary-tint", 4.5],
  ["primary", "background", 4.5],
  ["primary", "card", 4.5],
  ["warning", "warning-tint", 4.5],
  ["warning", "card", 4.5],
  ["muted-foreground", "background", 4.5],
  ["muted-foreground", "muted", 4.5],
  ["primary-foreground", "primary", 4.5],
  ["primary-foreground", "muted-foreground", 4.5],
  ["success", "success-tint", 4.5],
  ["scheduled", "scheduled-tint", 4.5],
  ["scheduled", "card", 4.5],
  ["peach-foreground", "peach", 4.5],
  ["success", "background", 4.5],
  ["destructive", "background", 4.5],
  ["destructive", "destructive-tint", 4.5],
  ["destructive-foreground", "destructive", 4.5],
  // Control outlines and the focus ring need 3:1.
  ["input", "background", 3],
  ["input", "card", 3],
  ["ring", "background", 3],
  ["ring", "card", 3],
])("%s on %s meets %s:1", (fg, bg, min) => {
  expect(ratio(fg, bg)).toBeGreaterThanOrEqual(min);
});

test("the token page shows every Item state by name", () => {
  render(<Tokens />);
  for (const label of Object.values(STATE_LABEL)) expect(screen.getAllByText(label).length).toBeGreaterThan(0);
  expect(screen.getByText("Held: not sure it sent")).toBeTruthy();
});

test("state chips use tokens only, never a raw colour", () => {
  for (const cls of Object.values(STATE_STYLE)) expect(cls).not.toMatch(/#|\[|rgb/);
});

test("Astryx draws only with our tokens, and DESIGN.md lists the same pairs as astryx.css", () => {
  const pairs = (text: string, re: RegExp) => [...text.matchAll(re)].map((m) => `${m[1]} ${m[2] ?? m[3]}`).sort();
  const astryx = readFileSync(resolve("apps/web/src/astryx.css"), "utf8");
  const file = pairs(astryx, /(--[\w-]+):\s*(?:var\((--[\w-]+)\)|(none));/g);
  const doc = pairs(readFileSync(resolve("apps/web/DESIGN.md"), "utf8"), /^\| `(--[\w-]+)` \| `(--[\w-]+|none)` \|$/gm);
  expect(file.length).toBeGreaterThan(30);
  expect(doc).toEqual(file);
  // Every token on the right is declared in styles.css, so a renamed token can't leave Astryx blank.
  for (const token of new Set(file.map((p) => p.split(" ")[1]!).filter((t) => t !== "none"))) {
    expect(css, token).toMatch(new RegExp(`${token}:`));
  }
  // The bridge would bring Tailwind's own names back, and the neutral fonts.css loads Figtree from Google.
  expect(astryx).not.toMatch(/tailwind-theme\.css|theme-neutral\/fonts\.css/);
});

test("a warning count says how many in words, and nothing when there are none", () => {
  const { container, rerender } = render(<WarningCount count={0} />);
  expect(container.textContent).toBe("");
  rerender(<WarningCount count={1} />);
  expect(screen.getByText("1 warning")).toBeTruthy();
  rerender(<WarningCount count={3} />);
  expect(screen.getByText("3 warnings")).toBeTruthy();
});
