// SPDX-License-Identifier: AGPL-3.0-only
// Ask's "read the website again": the address comes from the newest Brand read of a website, never
// from the model, and the start is Brand's own run with the accepted Item's key and taint.
import { expect, test } from "vitest";
import { brandAskStarts } from "./index";
import type { Agents } from "./application/create";

type Fake = Pick<Agents, "list" | "start" | "report">;
const summary = (id: string, input: unknown) => ({ run: { id, input } }) as unknown as Awaited<ReturnType<Agents["list"]>>[number];

function world(runs: ReturnType<typeof summary>[], reply: Awaited<ReturnType<Agents["start"]>> = { ok: true, run: { id: "new-run" } } as never) {
  const calls: unknown[] = [];
  const agents: Fake = {
    list: async (_w, agent) => (calls.push(["list", agent]), runs),
    start: async (_w, a) => (calls.push(a), reply),
    report: async (_w, runId) => ({ state: "running", itemIds: [runId] }),
  };
  return { start: brandAskStarts(() => agents)[0]!, calls };
}

test("the address is the newest Brand read of a website, skipping pasted text, and none means no_website", async () => {
  const { start, calls } = world([summary("r3", {}), summary("r2", { url: "https://shop.test/" }), summary("r1", { url: "https://old.test/" })]);
  expect(start).toMatchObject({ id: "read_website", definition: "brand_reader", permission: "item.edit", area: null });
  expect(await start.check("w", {})).toEqual({ ok: true, title: "Read https://shop.test/ again", basis: "brand_read:r2" });
  expect(calls[0]).toEqual(["list", "brand_reader"]);
  expect(start.args.safeParse({ url: "https://evil.test/" }).success).toBe(false);
  const none = world([summary("r1", { text: "" })]).start;
  expect(await none.check("w", {})).toEqual({ ok: false, why: "no_website" });
  expect(await none.start("w", {}, { userId: "u", key: "k", tainted: false })).toEqual({ ok: false, why: "no_website" });
});

test("starting runs Brand's own reader as the accepter, with the Item's key and taint, and passes a refusal on", async () => {
  const { start, calls } = world([summary("r2", { url: "https://shop.test/" })]);
  expect(await start.start("w", {}, { userId: "u1", key: "item-1", tainted: true })).toEqual({ ok: true, work: { kind: "agent_run", id: "new-run" } });
  expect(calls.at(-1)).toEqual({ agent: "brand_reader", input: { url: "https://shop.test/" }, key: "item-1", tainted: true, startedBy: "u1" });
  expect(await start.report("w", { kind: "agent_run", id: "new-run" })).toEqual({ state: "running", itemIds: ["new-run"] });
  expect(await start.report("w", { kind: "clip_run", id: "x" })).toBeNull();
  const off = world([summary("r2", { url: "https://shop.test/" })], { ok: false, reason: "disabled" } as never).start;
  expect(await off.start("w", {}, { userId: "u1", key: "item-2", tainted: false })).toEqual({ ok: false, why: "disabled" });
});
