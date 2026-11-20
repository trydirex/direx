// SPDX-License-Identifier: AGPL-3.0-only
// The door's reads over fakes of items and campaigns: fields named by each output schema and no
// others, so a draft's body or a Person's address on a row never gets out; inputs checked strictly.
import { expect, test } from "vitest";
import { doorReads } from "./index";

const W = "00000000-0000-4000-8000-0000000000aa";
const CAMPAIGN = "00000000-0000-4000-8000-0000000000cc";
const SECRET_BODY = "Hi Ada, here is the secret body";
const ADDRESS = "ada@example.com";

const item = (n: number) => ({
  id: `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`,
  kind: "action",
  state: "needs_approval",
  reason: n === 1 ? "Ada may be talking to you already" : null,
  reasonCode: n === 1 ? "may_be_talking" : null,
  title: `Subject ${n}`,
  workArea: "outreach",
  channel: "email",
  groupLabel: "Q4",
  at: new Date("2026-11-19T17:00:00Z"),
  warnings: n === 2 ? [{ code: "unspecified", text: "x".repeat(300) }] : [],
  // Fields a view carries that the door must never pass on.
  content: { text: SECRET_BODY, to: ADDRESS },
  revision: 1,
});
const rows = Array.from({ length: 25 }, (_, i) => item(i + 1));
const changesAsked: unknown[] = [];
const campaign = {
  id: CAMPAIGN,
  title: "Q4",
  paused: false,
  advance: "run",
  goal: "4 meetings",
  startsOn: "2026-11-01",
  endsOn: "2026-11-30",
  planned: 2,
  done: 1,
  skipped: 0,
  sent: 3,
  replied: 1,
  steps: [
    { key: "first", title: "First email", on: "2026-11-03", inPlan: true, type: "email", template: { subject: "S", text: SECRET_BODY } },
    { key: "old", title: "Gone", on: null, inPlan: false, type: "email", template: null },
  ],
};
const reads = doorReads({
  items: () => ({
    list: async () => ({ items: rows as never, needsYouCount: rows.length, nextCursor: null }),
    changes: async (...a: unknown[]) => {
      changesAsked.push(a);
      if (a[1] === "bad") return { ok: false as const, reason: "bad_cursor" as const };
      return { ok: true as const, events: [{ itemId: rows[0]!.id, kind: "action", from: null, to: "needs_approval", at: new Date("2026-11-16T09:00:00Z") }], cursor: "next", more: false };
    },
  }),
  campaigns: () => ({
    list: async () => [{ id: CAMPAIGN, title: "Q4", paused: true, extra: SECRET_BODY }] as never,
    campaign: async (_w: string, id: string) => (id === CAMPAIGN ? (campaign as never) : undefined),
    stepsWithoutDrafts: async () => [{ stepKey: "second", campaignId: CAMPAIGN, campaign: "Q4", on: "2026-11-20", title: "Second email", template: SECRET_BODY }] as never,
  }),
});
const value = async (name: keyof typeof reads, input: unknown) => {
  const r = await reads[name].read(W, input);
  if (!r.ok) throw new Error(r.reason);
  return r;
};
const leaks = (v: unknown) => [SECRET_BODY, ADDRESS].filter((s) => JSON.stringify(v).includes(s));

test("each read declares its disclosure: the two that show titles are personal", () => {
  expect(Object.fromEntries(Object.entries(reads).map(([n, r]) => [n, r.disclosure]))).toEqual({ read_changes: "operational", read_needs_you: "personal", read_schedule: "personal", read_campaign: "operational" });
});

test("needs-you gives the named fields, cut warnings and how many more, and nothing from the row's content", async () => {
  const r = await value("read_needs_you", { limit: 20 });
  const v = r.value as { items: Record<string, unknown>[]; more: number };
  expect(r.trust).toBe("untrusted");
  expect(v.more).toBe(5);
  expect(v.items).toHaveLength(20);
  expect(v.items[0]).toEqual({ id: rows[0]!.id, kind: "action", state: "needs_approval", reasonCode: "may_be_talking", reason: "Ada may be talking to you already", campaign: "Q4", at: "2026-11-19T17:00:00.000Z", warnings: [], title: "Subject 1" });
  expect((v.items[1]!.warnings as string[])[0]).toHaveLength(200);
  expect(leaks(v)).toEqual([]);
});

test("schedule gives planned Items and empty steps, without a step's template", async () => {
  const v = (await value("read_schedule", { from: "2026-11-16", to: "2026-11-30", limit: 30 })).value as { items: unknown[]; emptySteps: unknown[]; more: number };
  expect(v.items).toHaveLength(25);
  expect(v.emptySteps).toEqual([{ stepKey: "second", campaignId: CAMPAIGN, campaign: "Q4", on: "2026-11-20", title: "Second email" }]);
  expect(v.more).toBe(0);
  expect(leaks(v)).toEqual([]);
});

test("campaigns are listed or shown, steps in the plan only, and a step's text never", async () => {
  expect((await value("read_campaign", {})).value).toEqual({ campaigns: [{ id: CAMPAIGN, title: "Q4", paused: true }] });
  const one = (await value("read_campaign", { campaignId: CAMPAIGN })).value as { campaign: { steps: unknown[]; nextStepsStartOnTheirOwn: boolean } };
  expect(one.campaign.steps).toEqual([{ key: "first", title: "First email", on: "2026-11-03", type: "email", textWritten: true }]);
  expect(one.campaign.nextStepsStartOnTheirOwn).toBe(true);
  expect(leaks(one)).toEqual([]);
  expect((await value("read_campaign", { campaignId: "00000000-0000-4000-8000-0000000000dd" })).value).toEqual({ campaign: null });
});

test("changes passes the cursor and limit on, gives times as ISO, and passes a bad cursor back", async () => {
  expect((await value("read_changes", { cursor: "c1", limit: 10 })).value).toEqual({ events: [{ itemId: rows[0]!.id, kind: "action", from: null, to: "needs_approval", at: "2026-11-16T09:00:00.000Z" }], cursor: "next", more: false });
  await value("read_changes", {});
  expect(changesAsked.slice(-2)).toEqual([[W, "c1", 10], [W, null, 100]]);
  expect(await reads.read_changes.read(W, { cursor: "bad" })).toEqual({ ok: false, reason: "bad_cursor" });
});

test("inputs are strict: an unknown field or a page over the limit is refused", async () => {
  await expect(reads.read_changes.read(W, { cursor: null, limit: 101 })).rejects.toThrow();
  await expect(reads.read_needs_you.read(W, { everything: true })).rejects.toThrow();
  await expect(reads.read_schedule.read(W, { from: "2026-11-01", to: "2026-12-31" })).rejects.toThrow();
});
