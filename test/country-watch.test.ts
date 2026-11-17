// SPDX-License-Identifier: AGPL-3.0-only
// The country watch on saved answers from each source: no network, no GitHub. The saved files are
// the first 16 KB of each answer (the US one is whole), which is where every watched value sits.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { changeBody, decide, NO_MATCH, parseState, read, type Reading, type Row, stateBody } from "../scripts/country-watch";

const ROOT = join(import.meta.dirname, "..");
const TABLE = join(ROOT, "skills/cold-email-compliance/references/countries.json");
const rows: Row[] = JSON.parse(readFileSync(TABLE, "utf8")).countries;
const row = (code: string) => rows.find((r) => r.code === code)!;
const saved = (file: string) => readFileSync(join(import.meta.dirname, "country-watch", file), "utf8");
const answer = (body: string, status = 200): typeof fetch => (async () => new Response(body, { status })) as unknown as typeof fetch;

describe("country watch", () => {
  test("the UK, US, Canada, Australia and Finland probes read their value from a saved answer", async () => {
    const got = Object.fromEntries(await Promise.all(
      (["GB:gb.xml", "US:us.json", "CA:ca.html", "AU:au.json", "FI:fi.xml"] as const).map(async (p) => {
        const [code, file] = p.split(":") as [string, string];
        return [code, await read(row(code).watch!, answer(saved(file)))];
      }),
    ));
    expect(got).toEqual({
      GB: { value: "146" },
      US: { value: "2019-04-04" },
      CA: { value: "2026-01-01" },
      AU: { value: "C2016C00614" },
      FI: { value: "2026-06-16" },
    });
  });

  test("a page without a pattern is hashed on its visible text, so a script change isn't a change", async () => {
    const de = row("DE").watch!;
    const a = await read(de, answer("<p>§ 7 Unzumutbare Belästigungen</p><script>var n=1</script>"));
    const b = await read(de, answer("<p>§ 7  Unzumutbare Belästigungen</p><script>var n=2</script>"));
    const c = await read(de, answer("<p>§ 7 Unzumutbare Belästigungen, neu gefasst</p>"));
    expect(a).toEqual(b);
    expect(c).not.toEqual(a);
    expect(await read(row("GB").watch!, answer("<feed>moved</feed>"))).toEqual({ value: NO_MATCH });
    expect(await read(de, answer("gone", 404))).toEqual({ error: "HTTP 404" });
  });

  test("the Dutch probe reads the latest version from the open-data manifest", async () => {
    const manifest = `<?xml version="1.0"?><work label="BWBR0009950" gegenereerd="2026-11-09T09:05:16" _latestItem="2026-08-15_0/xml/BWBR0009950_2026-08-15_0.xml">`;
    expect(await read(row("NL").watch!, answer(manifest))).toEqual({ value: "2026-08-15_0" });
  });

  test("a dropped connection gets one more try, and a second failure is reported", async () => {
    let calls = 0;
    const flaky = (async () => { if (calls++ === 0) throw new Error("socket closed"); return new Response("<p>ok</p>"); }) as unknown as typeof fetch;
    expect(await read(row("DE").watch!, flaky, 0)).toHaveProperty("value");
    const down = (async () => { throw new Error("timed out"); }) as unknown as typeof fetch;
    expect(await read(row("DE").watch!, down, 0)).toEqual({ error: "timed out" });
  });

  test("the first reading is a baseline, unchanged opens nothing, changed opens one, and a failed read keeps the old value", () => {
    const now: Record<string, Reading> = { GB: { value: "146" }, US: { value: "2019-04-04" }, CA: { value: "2026-01-01" } };
    const first = decide(rows, {}, now, "2026-11-04");
    expect(first.changed).toEqual([]);
    expect(first.seen).toEqual({ GB: "146", US: "2019-04-04", CA: "2026-01-01" });
    expect(decide(rows, first.seen, now, "2026-11-11").changed).toEqual([]);

    const later = decide(rows, first.seen, { ...now, GB: { value: "147" }, CA: { error: "HTTP 503" } }, "2026-11-11");
    expect(later.changed.map((c) => [c.row.code, c.was, c.now])).toEqual([["GB", "146", "147"]]);
    expect(later.failed.map((f) => f.row.code)).toEqual(["CA"]);
    expect(later.seen.CA).toBe("2026-01-01");
    expect(changeBody(later.changed[0]!)).toContain("It read `146` and now reads `147`.");
  });

  test("rows not re-read for 180 days are due for review", () => {
    expect(decide(rows, {}, {}, "2027-04-28").due).toEqual([]);
    expect(decide(rows, {}, {}, "2027-04-29").due).toHaveLength(rows.length);
  });

  test("the last values survive a round trip through the state issue", () => {
    const seen = { GB: "146", DE: "sha256:0123456789abcdef" };
    expect(parseState(stateBody(seen, [{ row: row("CA"), error: "HTTP 503" }], "2026-11-04"))).toEqual(seen);
  });

  test("nothing in the watch writes to the country table", () => {
    const before = readFileSync(TABLE, "utf8");
    decide(rows, {}, { GB: { value: "1" } }, "2027-12-01");
    expect(readFileSync(TABLE, "utf8")).toBe(before);
    // It reads the table and writes only issues: no file write appears anywhere in it.
    expect(readFileSync(join(ROOT, "scripts/country-watch.ts"), "utf8")).not.toMatch(/writeFile|Bun\.write|createWriteStream|appendFile/);
  });
});
