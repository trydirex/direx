// SPDX-License-Identifier: AGPL-3.0-only
// The newsletter jobs through a pg-boss that records what it is given. Connected lists, the plugin
// query and the sync are fakes; what is checked is which list is read, how, and what follows.
import { afterEach, expect, test, vi } from "vitest";
import { recordedBoss } from "./fixtures/boss";
import { NEWSLETTER_AFTER_SEND, NEWSLETTER_SYNC_ONE, NEWSLETTER_SYNC_SWEEP, NEWSLETTER_WEEKLY, newsletterJobs, type ListKey } from "./newsletter";

type Deps = Parameters<typeof newsletterJobs>[0];
const lists = [
  // An account with several lists, read through its lists query.
  { connection: "kit", subscribers: "kit/newsletter.subscribers", lists: "kit/newsletter.lists" },
  // An account with one list.
  { connection: "buttondown", subscribers: "buttondown/newsletter.subscribers", lists: null },
] as unknown as Deps["lists"];
const key = (connection: string, workspaceId = "w1"): ListKey => ({ workspaceId, credentialId: `cred-${connection}`, connection });

function setup(over: Partial<Deps> = {}) {
  const r = recordedBoss();
  const synced: string[] = [];
  const askedAgain: string[] = [];
  const runs: string[] = [];
  newsletterJobs({
    boss: r.boss,
    later: r.later,
    lists,
    connected: async () => [key("kit"), key("buttondown", "w2"), key("unknown")],
    query: (async () => [
      { id: "list-a", name: "A", subscriberCount: 1 },
      { id: "list-b", name: "B", subscriberCount: 2 },
    ]) as unknown as Deps["query"],
    syncOne: (async (_ws: string, credentialId: string, capability: string, listId?: string) => {
      synced.push(`${credentialId} ${capability} ${listId ?? "-"}`);
      return { kind: "done", pages: 1, addresses: 1 };
    }) as Deps["syncOne"],
    outreach: () => ({
      askAgainForSubscribers: async (workspaceId: string) => {
        askedAgain.push(workspaceId);
        return 1;
      },
    }),
    weekly: { run: async () => void runs.push("weekly") },
    afterSend: { run: async () => void runs.push("after send") },
    ...over,
  });
  return { r, synced, askedAgain, runs };
}

afterEach(() => vi.restoreAllMocks());

test("the four newsletter queues register on their crons", async () => {
  const { r } = setup();
  await r.start();
  expect(Object.fromEntries(r.crons)).toEqual({ [NEWSLETTER_SYNC_SWEEP]: "0 5 * * *", [NEWSLETTER_WEEKLY]: "0 * * * *", [NEWSLETTER_AFTER_SEND]: "*/10 * * * *" });
  expect(r.queues.sort()).toEqual([NEWSLETTER_AFTER_SEND, NEWSLETTER_SYNC_ONE, NEWSLETTER_SYNC_SWEEP, NEWSLETTER_WEEKLY].sort());
});

test("the nightly sweep reads every list of every connected account, then asks again for each Workspace read", async () => {
  const { r, synced, askedAgain } = setup();
  await r.start();
  await r.run(NEWSLETTER_SYNC_SWEEP);
  expect(synced).toEqual(["cred-kit kit/newsletter.subscribers list-a", "cred-kit kit/newsletter.subscribers list-b", "cred-buttondown buttondown/newsletter.subscribers -"]);
  // A connection no newsletter plugin owns is skipped.
  expect(askedAgain).toEqual(["w1", "w2"]);
});

test("an account whose lists can't be read is logged and stops there; a stopped sync is logged and still asks again", async () => {
  const errors = vi.spyOn(console, "error").mockImplementation(() => {});
  const { r, synced, askedAgain } = setup({
    query: (async () => {
      throw new Error("key refused");
    }) as unknown as Deps["query"],
    syncOne: (async () => ({ kind: "too_slow", pages: 3, addresses: 250, detail: "page 3" })) as Deps["syncOne"],
  });
  await r.start();
  await r.run(NEWSLETTER_SYNC_SWEEP);
  expect(synced).toEqual([]);
  // The account with unreadable lists asks nothing again; the one whose sync stopped still does.
  expect(askedAgain).toEqual(["w2"]);
  expect(errors.mock.calls.map((c) => String(c[0]))).toEqual([
    "worker: couldn't read the lists behind newsletter key cred-kit: key refused",
    "worker: newsletter list cred-buttondown stopped after 250 addresses: too_slow, page 3",
  ]);
});

test("one list is read as soon as it is connected; an empty job does nothing", async () => {
  const { r, synced, askedAgain } = setup();
  await r.start();
  await r.run(NEWSLETTER_SYNC_ONE, key("buttondown", "w3"));
  await r.run(NEWSLETTER_SYNC_ONE);
  expect(synced).toEqual(["cred-buttondown buttondown/newsletter.subscribers -"]);
  expect(askedAgain).toEqual(["w3"]);
});

test("outreach is required: one handed in empty fails the job after the read rather than skipping the ask", async () => {
  const { r, synced } = setup({ outreach: undefined });
  await r.start();
  await expect(r.run(NEWSLETTER_SYNC_ONE, key("buttondown"))).rejects.toThrow(TypeError);
  expect(synced).toHaveLength(1);
});

test("the weekly draft and the after-send check run their passes", async () => {
  const { r, runs } = setup();
  await r.start();
  await r.run(NEWSLETTER_WEEKLY);
  await r.run(NEWSLETTER_AFTER_SEND);
  expect(runs).toEqual(["weekly", "after send"]);
});
