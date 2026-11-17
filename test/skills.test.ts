// SPDX-License-Identifier: AGPL-3.0-only
// Static checks on the published skills: no model, no network.
import { existsSync, mkdtempSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";

const ROOT = join(import.meta.dirname, "..");
const SKILLS = join(ROOT, "skills");
const NAME = /^[a-z0-9]+(-[a-z0-9]+)*$/;

function frontmatter(text: string): Record<string, string> | null {
  const m = /^---\n([\s\S]*?)\n---\n/.exec(text);
  if (!m) return null;
  return Object.fromEntries(m[1]!.split("\n").map((l) => /^(\w+):\s*(.*)$/.exec(l)).filter((x) => x !== null).map((x) => [x[1]!, x[2]!.trim()]));
}

function* markdown(dir: string): Generator<string> {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) yield* markdown(p);
    else if (e.name.endsWith(".md")) yield p;
  }
}

/** Every problem in a skills folder, as `<where>: <what>`. */
function problems(root: string): string[] {
  const out: string[] = [];
  for (const e of readdirSync(root, { withFileTypes: true })) {
    if (!e.isDirectory()) continue;
    const dir = join(root, e.name);
    const file = join(dir, "SKILL.md");
    if (!existsSync(file)) { out.push(`${e.name}: no SKILL.md`); continue; }
    const text = readFileSync(file, "utf8");
    const fm = frontmatter(text);
    if (!fm) { out.push(`${e.name}: no frontmatter`); continue; }
    if (fm.name !== e.name) out.push(`${e.name}: name "${fm.name}" is not the directory name`);
    if (!NAME.test(e.name) || e.name.length > 64) out.push(`${e.name}: name must be kebab-case, at most 64 characters`);
    if (!fm.description || fm.description.length > 1024) out.push(`${e.name}: description must be 1 to 1024 characters`);
    for (const [, path] of text.matchAll(/`((?:references|evals)\/[^`\s]+)`/g)) {
      if (!existsSync(join(dir, path!))) out.push(`${e.name}: names ${path}, which doesn't exist`);
    }
  }
  for (const f of markdown(root)) {
    if (/[–—]/.test(readFileSync(f, "utf8"))) out.push(`${f.slice(root.length + 1)}: em or en dash`);
  }
  return out;
}

const skillNames = () => readdirSync(SKILLS, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name);

describe("published skills", () => {
  test("every skill is well formed", () => {
    expect(problems(SKILLS)).toEqual([]);
  });

  test("the checker catches a bad skill", () => {
    const root = mkdtempSync(join(tmpdir(), "skills-"));
    mkdirSync(join(root, "bad-skill"));
    writeFileSync(join(root, "bad-skill", "SKILL.md"), "---\nname: other\ndescription: x\n---\n\nSee `references/missing.md` — here.\n");
    expect(problems(root)).toEqual([
      'bad-skill: name "other" is not the directory name',
      "bad-skill: names references/missing.md, which doesn't exist",
      "bad-skill/SKILL.md: em or en dash",
    ]);
  });

  test("the folder is MIT and the README names every skill", () => {
    expect(readFileSync(join(SKILLS, "LICENSE"), "utf8")).toMatch(/^MIT License\n\nCopyright \(c\) \d{4} \S/);
    const readme = readFileSync(join(SKILLS, "README.md"), "utf8");
    for (const name of skillNames()) expect(readme).toContain(`\`${name}\``);
  });

  test("the country table follows its rules, and the product's copy is identical", () => {
    const file = join(SKILLS, "cold-email-compliance", "references", "countries.json");
    const text = readFileSync(file, "utf8");
    // The product's domain can't import outside itself, so it holds a copy. Edit the skill's file, then copy it.
    expect(readFileSync(join(ROOT, "apps/api/src/modules/outreach/domain/countries.json"), "utf8")).toBe(text);
    const rows: { code: string; status: string; source: string | null; sourceNote?: string; checked: string; warnAfter: string; expiresAfter: string; confidence: string; watch: unknown; watchNote?: string }[] = JSON.parse(text).countries;
    // The skill compares today with these two dates, so a model never adds months in its head.
    const plus = (d: string, months: number) => { const x = new Date(`${d}T00:00:00Z`); x.setUTCMonth(x.getUTCMonth() + months); return x.toISOString().slice(0, 10); };
    const today = new Date().toISOString().slice(0, 10);
    expect(new Set(rows.map((r) => r.code)).size).toBe(rows.length);
    expect(rows.filter((r) => r.status === "open").map((r) => r.code).sort()).toEqual(["AU", "CA", "FI", "FR", "GB", "IE", "NZ", "US"]);
    for (const r of rows) {
      expect(["open", "held", "unverified"], r.code).toContain(r.status);
      expect(r.checked <= today && /^\d{4}-\d{2}-\d{2}$/.test(r.checked), r.code).toBe(true);
      expect(r.confidence, r.code).toMatch(/^[HML]/);
      expect([r.warnAfter, r.expiresAfter], `${r.code}: set both from checked`).toEqual([plus(r.checked, 3), plus(r.checked, 12)]);
      // Only a country whose primary text couldn't be read may lack a source, and it says why. A source
      // that refuses automated reads has no watch and says so; the 180-day re-read covers it.
      if (r.status !== "unverified") expect(r.source && (r.watch ?? r.watchNote), r.code).toBeTruthy();
      else expect(r.source ?? r.sourceNote, r.code).toBeTruthy();
    }
  });

  test("the agents table follows its rules", () => {
    const rows: { token: string; operator: string; purpose: string; robots: string; says: string; source: string; checked: string; warnAfter: string; expiresAfter: string; confidence: string }[] =
      JSON.parse(readFileSync(join(SKILLS, "agent-readiness", "references", "agents.json"), "utf8")).agents;
    const plus = (d: string, months: number) => { const x = new Date(`${d}T00:00:00Z`); x.setUTCMonth(x.getUTCMonth() + months); return x.toISOString().slice(0, 10); };
    const today = new Date().toISOString().slice(0, 10);
    expect(new Set(rows.map((r) => r.token.toLowerCase())).size).toBe(rows.length);
    for (const r of rows) {
      expect(["training", "search", "user-request", "dataset"], r.token).toContain(r.purpose);
      expect(["follows", "may ignore", "token only", "not stated"], r.token).toContain(r.robots);
      expect(r.operator && r.says, r.token).toBeTruthy();
      expect(r.source, r.token).toMatch(/^https:\/\//);
      expect(r.checked <= today && /^\d{4}-\d{2}-\d{2}$/.test(r.checked), r.token).toBe(true);
      expect([r.warnAfter, r.expiresAfter], `${r.token}: set both from checked`).toEqual([plus(r.checked, 3), plus(r.checked, 12)]);
      expect(r.confidence, r.token).toMatch(/^[HML]$/);
    }
  });

  test("the marketplace serves the skills folder as one MIT plugin with no pinned version", () => {
    const m = JSON.parse(readFileSync(join(ROOT, ".claude-plugin", "marketplace.json"), "utf8"));
    expect(m.plugins).toHaveLength(1);
    // No `version`: a git marketplace then versions by commit, so every change reaches users who update.
    expect(m.plugins[0]).toMatchObject({ name: "direx", source: "./skills", skills: ["./"], license: "MIT" });
    expect(m.plugins[0].version).toBeUndefined();
    expect(m.version).toBeUndefined();
  });
});
