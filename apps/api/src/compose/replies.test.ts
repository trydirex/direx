// SPDX-License-Identifier: AGPL-3.0-only
// The reply search across a Workspace's connected Mailboxes, with plugins, the vault and the skip list
// as fakes: which Mailboxes are searched, what is asked of them, and when the answer is incomplete.
import { expect, test } from "vitest";
import { CallFailed } from "../modules/plugins/index";
import { mailboxSearch } from "./replies";

type Deps = Parameters<typeof mailboxSearch>[0];
const W = "w1";
// A received message as the catalogue's email.received entry describes it, so found mail parses as the poll's does.
const MAIL = { headers: { from: "Kim <kim@acme.test>", subject: "Re: Hello", date: "Mon, 16 Nov 2026 09:00:00 +0000", inReplyTo: "", references: "" }, text: "Thanks" };

function setup(over: { query?: (credentialId: string, input: unknown) => Promise<unknown>; skipList?: unknown[]; waiting?: boolean; vault?: boolean; plugins?: boolean } = {}) {
  const asked: { credentialId: string; input: unknown }[] = [];
  const reauth: string[] = [];
  const plugins = {
    mailboxConnections: () => ["google"],
    mailboxFor: (connection: string | null) => (connection === "google" ? { mailFrom: "gmail/mail.from" } : undefined),
    query: async (_ws: string, _capability: string, input: unknown, credentialId: string) => {
      asked.push({ credentialId, input });
      return over.query ? over.query(credentialId, input) : { events: [{ eventId: `e-${credentialId}`, data: MAIL }] };
    },
  } as unknown as ReturnType<Deps["plugins"]>;
  const vault = {
    markNeedsReauth: async (_ws: string, credentialId: string) => void reauth.push(credentialId),
    list: async () => (over.waiting ? [{ status: "needs_reauth", connection: "google" }] : [{ status: "active", connection: "google" }]),
  } as unknown as Deps["vault"];
  const search = mailboxSearch({
    plugins: () => (over.plugins === false ? undefined : plugins),
    vault: over.vault === false ? undefined : vault,
    connected: async () => [
      { workspaceId: W, credentialId: "m1", connection: "google" },
      { workspaceId: "w2", credentialId: "other", connection: "google" },
      { workspaceId: W, credentialId: "no-provider", connection: "imap" },
      { workspaceId: W, credentialId: "m2", connection: "google" },
    ],
    skipFor: (async () => over.skipList ?? []) as Deps["skipFor"],
    now: () => new Date("2026-11-16T10:00:00Z"),
  });
  return { search, asked, reauth };
}

test("with no plugins loaded, nothing is searched and the answer is complete", async () => {
  expect(await setup({ plugins: false }).search(W, "kim@acme.test")).toEqual({ events: [], complete: true });
});

test("only this Workspace's Mailboxes with a provider are searched, and each event names its Mailbox", async () => {
  const { search, asked } = setup();
  const r = await search(W, "kim@acme.test");
  expect(asked).toEqual([
    { credentialId: "m1", input: { email: "kim@acme.test" } },
    { credentialId: "m2", input: { email: "kim@acme.test" } },
  ]);
  expect(r).toEqual({
    events: [
      { eventId: "e-m1", data: MAIL, workspaceId: W, credentialId: "m1" },
      { eventId: "e-m2", data: MAIL, workspaceId: W, credentialId: "m2" },
    ],
    complete: true,
  });
});

test("the Placement checks a Mailbox expects are passed as the skip list", async () => {
  const skip = [{ from: "seed@placement.test", subject: "Check 1", after: 1, before: 2 }];
  const { search, asked } = setup({ skipList: skip });
  await search(W, "kim@acme.test");
  expect(asked[0]!.input).toEqual({ email: "kim@acme.test", skip });
});

test("a Mailbox that needs a reconnect is marked, the others are still searched, and the answer is incomplete", async () => {
  const { search, reauth } = setup({
    query: async (credentialId) => {
      if (credentialId === "m1") throw new CallFailed("token revoked", { reason: "credential_rejected" });
      return { events: [{ eventId: "e-m2", data: MAIL }] };
    },
  });
  const r = await search(W, "kim@acme.test");
  expect(reauth).toEqual(["m1"]);
  expect(r.complete).toBe(false);
  expect(r.events.map((e) => e.credentialId)).toEqual(["m2"]);
});

test("any other failure is thrown, not hidden as an incomplete search", async () => {
  const { search, reauth } = setup({
    query: async () => {
      throw new CallFailed("rate limited", { reason: "rate_limited" });
    },
  });
  await expect(search(W, "kim@acme.test")).rejects.toThrow("rate limited");
  expect(reauth).toEqual([]);
});

test("a Mailbox already waiting for a reconnect makes the answer incomplete; with no vault nothing is waiting", async () => {
  expect((await setup({ waiting: true }).search(W, "kim@acme.test")).complete).toBe(false);
  expect((await setup({ waiting: true, vault: false }).search(W, "kim@acme.test")).complete).toBe(true);
});
