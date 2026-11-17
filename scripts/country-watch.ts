// SPDX-License-Identifier: AGPL-3.0-only
// The weekly watch on the cold-email skill's country table. For each row's `watch` entry it reads
// the source, takes the value its pattern names (or a hash of the page's text), and compares it
// with the value seen last week. A change opens one issue per row, and rows not re-read for 180
// days are listed in one review issue. It never edits the table: a person re-reads the law, edits
// the row and resets `checked`.
//   bun scripts/country-watch.ts             prints what it would do
//   GITHUB_TOKEN=... GITHUB_REPOSITORY=owner/repo bun scripts/country-watch.ts
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

export type Row = { code: string; name: string; checked: string; source: string | null; watch: { url: string; match: string | null } | null };
/** The value last seen for each row, by country code. */
export type Seen = Record<string, string>;
export type Reading = { value: string } | { error: string };

const TABLE = join(import.meta.dirname, "../skills/cold-email-compliance/references/countries.json");
const MAX_BYTES = 8_000_000;
const REVIEW_DAYS = 180;
export const NO_MATCH = "the pattern no longer matches the page";

/** What a reader sees: no scripts, styles, tags or spacing, so a changed nonce or layout isn't a change. */
const visibleText = (html: string) => html.replace(/<(script|style)[\s\S]*?<\/\1>/gi, " ").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();

/** Reads one source. With a pattern it stops as soon as the pattern matches, so a large file costs little. */
export async function read(watch: NonNullable<Row["watch"]>, get: typeof fetch = fetch, retryAfterMs = 30_000): Promise<Reading> {
  const fetchOnce = () => get(watch.url, { headers: { "user-agent": "direx-country-watch (+https://github.com/trydirex/direx)" }, signal: AbortSignal.timeout(60_000) });
  let res: Response;
  try {
    // A timeout or dropped connection is usually the server having a bad minute, so it gets one more try.
    res = await fetchOnce().catch(async () => { await sleep(retryAfterMs); return fetchOnce(); });
  } catch (e) {
    return { error: e instanceof Error ? e.message : String(e) };
  }
  if (!res.ok || !res.body) return { error: `HTTP ${res.status}` };
  const pattern = watch.match === null ? null : new RegExp(watch.match);
  const decoder = new TextDecoder();
  let text = "";
  for await (const chunk of res.body) {
    text += decoder.decode(chunk, { stream: true });
    const m = pattern?.exec(text);
    if (m) {
      await res.body.cancel().catch(() => undefined);
      return { value: m[1] ?? m[0] };
    }
    if (text.length > MAX_BYTES) return { error: `more than ${MAX_BYTES} bytes` };
  }
  if (pattern) return { value: NO_MATCH };
  return { value: `sha256:${createHash("sha256").update(visibleText(text)).digest("hex").slice(0, 16)}` };
}

const daysBetween = (from: string, to: string) => Math.floor((Date.parse(to) - Date.parse(from)) / 86_400_000);

/** What this week's readings mean. Pure: the caller does the reading and the writing. */
export function decide(rows: Row[], seen: Seen, readings: Record<string, Reading>, today: string) {
  const next: Seen = { ...seen };
  const changed: { row: Row; was: string; now: string }[] = [];
  const failed: { row: Row; error: string }[] = [];
  for (const row of rows) {
    const r = readings[row.code];
    if (!row.watch || !r) continue;
    // A source that can't be read keeps its last value, so next week compares against the real one.
    if ("error" in r) { failed.push({ row, error: r.error }); continue; }
    const was = seen[row.code];
    // The first reading is the baseline, not a change.
    if (was !== undefined && was !== r.value) changed.push({ row, was, now: r.value });
    next[row.code] = r.value;
  }
  const due = rows.filter((row) => daysBetween(row.checked, today) > REVIEW_DAYS);
  return { seen: next, changed, failed, due };
}

export const STATE_TITLE = "Country watch: last values seen";
export const REVIEW_TITLE = "Country review due";
export const changeTitle = (row: Row) => `Country watch: ${row.code} (${row.name}) source changed`;
const LABEL = "country-watch";

export function changeBody(c: { row: Row; was: string; now: string }) {
  const what = c.was.startsWith("sha256:") ? "The page's text changed." : c.now === NO_MATCH ? `The pattern no longer matches, so the page's layout changed. It last read \`${c.was}\`.` : `It read \`${c.was}\` and now reads \`${c.now}\`.`;
  return [
    `The watched source for ${c.row.name} changed: ${c.row.watch!.url}`,
    "",
    what,
    "",
    "This job doesn't edit the table. To close this:",
    `1. Re-read the primary text${c.row.source ? ` (${c.row.source})` : ""} and decide whether the row's status, verdict or basis changes.`,
    "2. Edit the row in `skills/cold-email-compliance/references/countries.json`, set `checked` to the day you read it with `warnAfter` three months and `expiresAfter` twelve months later, and copy the file to `apps/api/src/modules/outreach/domain/countries.json`.",
    "3. If only the layout changed, fix the row's `watch` entry instead.",
  ].join("\n");
}

export const reviewBody = (due: Row[], today: string) =>
  [
    `Every row is re-read at least every ${REVIEW_DAYS} days, change or not. These were last checked more than ${REVIEW_DAYS} days before ${today}:`,
    "",
    ...due.map((r) => `- ${r.code} (${r.name}), checked ${r.checked}: ${r.source ?? "no primary text could be read; see the row's sourceNote"}`),
    "",
    "Re-read each one, update its row and `checked` date, copy the file to the product's domain, then close this issue.",
  ].join("\n");

export const stateBody = (seen: Seen, failed: { row: Row; error: string }[], today: string) =>
  [
    "The country watch keeps the last value it read for each source here. Don't edit the JSON by hand.",
    "",
    failed.length ? `Couldn't read on ${today}: ${failed.map((f) => `${f.row.code} (${f.error})`).join(", ")}.` : `Every source read on ${today}.`,
    "",
    "```json",
    JSON.stringify(seen, null, 2),
    "```",
  ].join("\n");

export const parseState = (body: string): Seen => JSON.parse(/```json\n([\s\S]*?)\n```/.exec(body)?.[1] ?? "{}");

async function main() {
  const rows: Row[] = JSON.parse(readFileSync(TABLE, "utf8")).countries;
  const today = new Date().toISOString().slice(0, 10);
  const token = process.env.GITHUB_TOKEN;
  const repo = process.env.GITHUB_REPOSITORY;
  const live = Boolean(token && repo);
  const gh = async (path: string, init: { method?: string; body?: unknown } = {}) => {
    const res = await fetch(`https://api.github.com/repos/${repo}${path}`, {
      method: init.method ?? "GET",
      headers: { authorization: `Bearer ${token}`, accept: "application/vnd.github+json", "content-type": "application/json" },
      ...(init.body !== undefined && { body: JSON.stringify(init.body) }),
    });
    if (!res.ok) throw new Error(`GitHub ${init.method ?? "GET"} ${path}: ${res.status} ${await res.text()}`);
    return res.json();
  };
  const open: { number: number; title: string; body: string | null }[] = live ? await gh(`/issues?labels=${LABEL}&state=open&per_page=100`) : [];
  const state = open.find((i) => i.title === STATE_TITLE);
  const seen = state?.body ? parseState(state.body) : {};

  const readings: Record<string, Reading> = {};
  for (const row of rows) if (row.watch) readings[row.code] = await read(row.watch);
  const d = decide(rows, seen, readings, today);

  // One issue per title: a second change to the same row is a comment on its open issue.
  const file = async (title: string, body: string, comment: boolean) => {
    const existing = open.find((i) => i.title === title);
    if (existing && !comment) return;
    if (!live) return console.log(`would ${existing ? "comment on" : "open"}: ${title}\n${body}\n`);
    if (existing) await gh(`/issues/${existing.number}/comments`, { method: "POST", body: { body } });
    else await gh("/issues", { method: "POST", body: { title, body, labels: [LABEL] } });
  };
  for (const c of d.changed) await file(changeTitle(c.row), changeBody(c), true);
  // The review list opens once and stays open until a person closes it.
  if (d.due.length) await file(REVIEW_TITLE, reviewBody(d.due, today), false);
  for (const f of d.failed) console.log(`couldn't read ${f.row.code}: ${f.error}`);
  console.log(`${Object.keys(readings).length} sources read, ${d.changed.length} changed, ${d.failed.length} failed, ${d.due.length} due for review`);

  if (!live) return;
  const body = stateBody(d.seen, d.failed, today);
  if (state) await gh(`/issues/${state.number}`, { method: "PATCH", body: { body } });
  else await gh("/issues", { method: "POST", body: { title: STATE_TITLE, body, labels: [LABEL] } });
}

if (import.meta.main) await main();
