// SPDX-License-Identifier: AGPL-3.0-only
// The header probe against the fake Gmail: sent like an email, read back from INBOX or SPAM
// without touching a label.
import type { CallContext } from "@direx/plugin-sdk";
import { afterEach, expect, test } from "vitest";
import { startFakeGmail, type FakeGmail } from "./fake-gmail";
import { gmailManifest } from "./manifest";
import { createGmailPlugin, PROBE_TEXT_CHARS } from "./plugin";

const fakes: FakeGmail[] = [];
afterEach(() => fakes.splice(0).forEach((f) => f.stop()));

const SUBJECT = "Direx header check";
const UNSUB = "https://direx.example/u/abc";

function setup() {
  const fake = startFakeGmail({ email: "dana@example.com" });
  fakes.push(fake);
  const plugin = createGmailPlugin({ baseUrl: fake.url, timeoutMs: 500 });
  const ctx = (actionId: string): CallContext => ({
    workspaceId: "00000000-0000-4000-8000-000000000001",
    idempotencyKey: actionId,
    credential: { accessToken: fake.token, expiresAt: "" },
    log: () => {},
  });
  const probe = plugin.effects["mailbox.probe"]!;
  const read = (actionId: string, subject = SUBJECT) => plugin.queries["mailbox.probe_read"]!({ actionId, subject }, ctx(actionId));
  const sendProbe = async (to: string, actionId: string) => {
    const { spec } = await probe.prepare({ to: [to], subject: SUBJECT, text: "Checking this Mailbox.", listUnsubscribe: UNSUB }, ctx(actionId));
    return probe.execute(spec, ctx(actionId));
  };
  return { fake, plugin, probe, read, sendProbe, ctx };
}

test("the probe is a low-risk queryable effect that reaches no Person, beside a read-only query", () => {
  const caps = gmailManifest.capabilities.filter((c) => c.name.startsWith("mailbox.probe"));
  expect(caps).toEqual([
    { kind: "effect", name: "mailbox.probe", connection: "google", dedupe: "queryable", risk: "low", reachesPerson: false },
    { kind: "query", name: "mailbox.probe_read", connection: "google" },
  ]);
});

test("a probe sent to self is found in INBOX with our headers, and reading it changes no label", async () => {
  const { fake, read, sendProbe } = setup();
  const actionId = crypto.randomUUID();
  expect(await sendProbe("dana@example.com", actionId)).toMatchObject({ kind: "sent", providerRef: "m1" });
  const before = fake.labelsOf("m1");
  const requests = fake.requests.length;

  const r = (await read(actionId)) as { found: true; folder: string; headers: string; text: string; html: string | null };
  expect(r).toMatchObject({ found: true, folder: "inbox", html: null });
  expect(r.headers).toContain(`List-Unsubscribe: <${UNSUB}>`);
  expect(r.headers).toContain("List-Unsubscribe-Post: List-Unsubscribe=One-Click");
  expect(r.headers).toContain(`X-Direx-Action: ${actionId}`);
  expect(r.headers).not.toContain("\r\n\r\n");
  expect(r.text.trim()).toBe("Checking this Mailbox.");
  expect(fake.labelsOf("m1")).toEqual(before);
  expect(fake.requests.slice(requests).every((x) => x.startsWith("GET "))).toBe(true);
  expect(fake.requests.slice(requests).some((x) => x.startsWith("GET /messages/m1"))).toBe(true);
});

test("the sender's copy in Sent alone is not found", async () => {
  const { read, sendProbe } = setup();
  const actionId = crypto.randomUUID();
  await sendProbe("kim@example.com", actionId);
  expect(await read(actionId)).toEqual({ found: false });
});

test("a probe in SPAM comes back as junk, with its text capped", async () => {
  const { fake, read } = setup();
  const actionId = crypto.randomUUID();
  fake.deliver({ from: "dana@example.com", subject: SUBJECT, text: "x".repeat(PROBE_TEXT_CHARS + 50), labelIds: ["SPAM"], headers: { "X-Direx-Action": actionId } });
  const r = (await read(actionId)) as { found: true; folder: string; text: string };
  expect(r).toMatchObject({ found: true, folder: "junk" });
  expect(r.text).toHaveLength(PROBE_TEXT_CHARS);
});

test("an unknown actionId, or a message with the subject but another Action's header, is not found", async () => {
  const { fake, read } = setup();
  fake.deliver({ from: "dana@example.com", subject: SUBJECT, text: "other", headers: { "X-Direx-Action": "someone-else" } });
  expect(await read(crypto.randomUUID())).toEqual({ found: false });
});

test("probe_read refuses a bad input or no credential before any request", async () => {
  const { fake, plugin, ctx } = setup();
  const q = plugin.queries["mailbox.probe_read"]!;
  await expect(q({ actionId: "a b", subject: SUBJECT }, ctx("x"))).rejects.toThrow("actionId");
  await expect(q({ actionId: "x" }, ctx("x"))).rejects.toThrow("subject");
  await expect(q({ actionId: "x", subject: SUBJECT }, { ...ctx("x"), credential: null })).rejects.toThrow("mailbox not connected");
  expect(fake.requests).toEqual([]);
});

test("a cut-off probe is confirmed by reconcile, as an email is", async () => {
  const { fake, probe, sendProbe, ctx } = setup();
  const actionId = crypto.randomUUID();
  fake.sendScript.push("accept_then_hang");
  await expect(sendProbe("dana@example.com", actionId)).rejects.toThrow();
  expect(await probe.reconcile!("ignored", ctx(actionId))).toEqual({ kind: "sent", providerRef: "m1" });
});
