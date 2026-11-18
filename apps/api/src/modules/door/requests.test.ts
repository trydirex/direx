// SPDX-License-Identifier: AGPL-3.0-only
// The door's caps and request log against the database (ADR 0032 rules 006 and 011): a token's cap
// first, then its Workspace's, shared by every process; one row per request with no content.
import { beforeAll, expect, test, vi } from "vitest";
import * as repo from "./adapters/repo";
import { seedWorkspace } from "./fixtures/members";
import { createRequests, createTokens, DEFAULT_CAPS } from "./index";

const W = crypto.randomUUID();
const OTHER = crypto.randomUUID();
const owner = crypto.randomUUID();
let clock = new Date("2026-11-16T09:30:30.500Z");
const now = () => clock;
const caps = { perToken: 2, perWorkspace: 3 };
// Two processes on one database.
const one = createRequests({ caps, now });
const two = createRequests({ caps, now });
const tokens = createTokens({ maxDays: null, now });

beforeAll(async () => {
  await seedWorkspace(W, owner);
  await seedWorkspace(OTHER, crypto.randomUUID());
});
const token = async () => {
  const r = await tokens.create(W, { name: "Script", days: 7, readers: ["read_changes"], kinds: [] }, owner);
  if (!r.ok) throw new Error(r.reason);
  return r.id;
};

test("the caps start at 60 a minute per token and 300 per Workspace", () => {
  expect(DEFAULT_CAPS).toEqual({ perToken: 60, perWorkspace: 300 });
});

test("a token's cap comes first and doesn't spend the Workspace's; the Workspace's holds across tokens and processes", async () => {
  const [a, b, c] = await Promise.all([token(), token(), token()]);
  expect(await one.admit(W, a, "read_changes")).toEqual({ ok: true });
  expect(await two.admit(W, a, "read_changes")).toEqual({ ok: true });
  // Refused by its own cap at :30.5, so 30 seconds to the next minute; the Workspace's count stays at 2.
  expect(await one.admit(W, a, "read_changes")).toEqual({ ok: false, retryAfter: 30, first: true });
  expect(await two.admit(W, b, "read_changes")).toEqual({ ok: true });
  expect(await one.admit(W, b, "read_changes")).toEqual({ ok: false, retryAfter: 30, first: true });
  expect(await two.admit(W, c, "read_changes")).toEqual({ ok: false, retryAfter: 30, first: true });
  // A token's second refusal in the minute records no second row.
  expect(await two.admit(W, a, "read_changes")).toEqual({ ok: false, retryAfter: 30, first: false });
  // Another Workspace counts on its own.
  expect(await one.admit(OTHER, a, "read_changes")).toEqual({ ok: true });
  // A new minute starts every count again.
  clock = new Date("2026-11-16T09:31:00.000Z");
  expect(await two.admit(W, c, "read_changes")).toEqual({ ok: true });
});

test("concurrent requests never overshoot a cap", async () => {
  clock = new Date("2026-11-16T09:40:00.000Z");
  const t = await token();
  const results = await Promise.all(Array.from({ length: 10 }, (_, i) => (i % 2 ? one : two).admit(W, t, "read_changes")));
  expect(results.filter((r) => r.ok)).toHaveLength(caps.perToken);
  expect(await one.recent(W, t)).toEqual([{ reader: "read_changes", outcome: "rate_limited", at: clock }]);
});

test("each request leaves one row of reader, outcome and time, newest first, at most 20", async () => {
  const id = await token();
  for (let i = 0; i < 22; i++) await one.record(W, id, "read_changes", i === 21 ? "rate_limited" : "ok");
  const recent = await one.recent(W, id);
  expect(recent).toHaveLength(20);
  expect(recent[0]).toEqual({ reader: "read_changes", outcome: "rate_limited", at: clock });
  expect(Object.keys(recent[0]!).sort()).toEqual(["at", "outcome", "reader"]);
  expect(await one.recent(OTHER, id)).toEqual([]);
});

test("a failed refusal insert rolls back suppression so the next refusal retries", async () => {
  const id = await token();
  const requests = createRequests({ caps: { perToken: 0, perWorkspace: 0 }, now });
  const insert = vi.spyOn(repo, "insertRequest").mockImplementationOnce(() => {
    throw new Error("refusal insert failed");
  });
  try {
    await expect(requests.admit(W, id, "mcp")).rejects.toThrow("refusal insert failed");
  } finally {
    insert.mockRestore();
  }
  expect(await requests.recent(W, id)).toEqual([]);
  expect(await requests.admit(W, id, "mcp")).toEqual({ ok: false, retryAfter: 60, first: true });
  expect(await requests.admit(W, id, "read_changes")).toEqual({ ok: false, retryAfter: 60, first: false });
  expect(await requests.recent(W, id)).toEqual([{ reader: "mcp", outcome: "rate_limited", at: clock }]);
});
