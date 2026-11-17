// SPDX-License-Identifier: AGPL-3.0-only
// Send, read-back, reconcile and the profile query against the fake Gmail.
import { parseManifest, type CallContext, type ExecuteResult } from "@direx/plugin-sdk";
import { afterEach, expect, test } from "vitest";
import { startFakeGmail, type FakeGmail, type SendStep } from "./fake-gmail";
import { GMAIL_SCOPES, gmailManifest } from "./manifest";
import { prepareMessage } from "./mime";
import { createGmailPlugin, SENT_SCAN } from "./plugin";

const fakes: FakeGmail[] = [];
afterEach(() => fakes.splice(0).forEach((f) => f.stop()));

function setup(opts: Parameters<typeof startFakeGmail>[0] = {}) {
  const fake = startFakeGmail(opts);
  fakes.push(fake);
  const plugin = createGmailPlugin({ baseUrl: fake.url, timeoutMs: 300 });
  const send = plugin.effects["email.send"]!;
  const ctx = (actionId = crypto.randomUUID(), credential: CallContext["credential"] = { accessToken: fake.token, expiresAt: "" }): CallContext => ({
    workspaceId: "00000000-0000-4000-8000-000000000001",
    idempotencyKey: actionId,
    credential,
    log: () => {},
  });
  const spec = prepareMessage({ to: ["kim@example.com"], subject: "Hello", text: "Hi Kim", threadId: "t9" }).spec;
  return { fake, plugin, send, ctx, spec };
}

const header = (f: FakeGmail, i: number, name: string) => f.sent[i]!.headers.find((h) => h.name.toLowerCase() === name.toLowerCase())?.value;

test("the manifest has exactly twelve capabilities, Gmail as its only host, and one restricted scope", () => {
  expect(parseManifest(gmailManifest).ok).toBe(true);
  expect(gmailManifest.capabilities.map((c) => `${c.kind}:${c.name}`)).toEqual([
    "effect:email.send",
    "effect:mailbox.probe",
    "effect:placement.join",
    "effect:placement.send",
    "effect:placement.report",
    "effect:placement.archive",
    "trigger:email.received",
    "trigger:mail.sent",
    "query:mailbox.profile",
    "query:mail.from",
    "query:mailbox.probe_read",
    "query:placement.read",
  ]);
  expect(gmailManifest.egress.hosts).toEqual(["gmail.googleapis.com"]);
  expect(GMAIL_SCOPES).toEqual(["https://www.googleapis.com/auth/gmail.modify"]);
});

test("a send reaches Gmail once with the token and both correlation headers, and is sent with Gmail's id", async () => {
  const { fake, send, ctx, spec } = setup();
  const c = ctx();
  expect(await send.execute(spec, c)).toEqual({ kind: "sent", providerRef: "m1", correlationKey: "<gmail-1@mail.gmail.com>" });
  expect(fake.calls.send).toBe(1);
  expect(fake.authHeaders).toContain(`Bearer ${fake.token}`);
  expect(header(fake, 0, "X-Direx-Action")).toBe(c.idempotencyKey);
  expect(fake.sent[0]!.threadId).toBe("t9");
});

test("the Message-ID Gmail assigned is the correlation key; a failed read-back leaves none, and the send is still sent", async () => {
  const s = setup();
  s.fake.failNext("get", 500);
  expect(await s.send.execute(s.spec, s.ctx())).toEqual({ kind: "sent", providerRef: "m1" });
});

test("a slow Message-ID read is cut short, so the send is still reported sent within one call's deadline", async () => {
  const fake = startFakeGmail();
  fakes.push(fake);
  const slow = (async (url: string, init: RequestInit) => {
    if (init.method === "GET" && url.includes("/messages/")) {
      // Waits until aborted, as a hung read does.
      await new Promise((_, reject) => init.signal?.addEventListener("abort", () => reject(init.signal?.reason)));
    }
    return fetch(url, init);
  }) as unknown as typeof fetch;
  const send = createGmailPlugin({ baseUrl: fake.url, timeoutMs: 1_000, fetch: slow }).effects["email.send"]!;
  const spec = prepareMessage({ to: ["kim@example.com"], subject: "Hello", text: "Hi Kim" }).spec;
  const started = Date.now();
  const r = await send.execute(spec, { workspaceId: "00000000-0000-4000-8000-000000000001", idempotencyKey: crypto.randomUUID(), credential: { accessToken: fake.token, expiresAt: "" }, log: () => {} });
  expect(r).toEqual({ kind: "sent", providerRef: "m1" });
  expect(Date.now() - started).toBeLessThan(800);
});

test.each<[string, SendStep, Partial<ExecuteResult> | "unknown"]>([
  ["400", { status: 400, reason: "invalidArgument" }, { kind: "refused", permanent: true, retryable: false }],
  ["401", { status: 401, reason: "authError" }, { kind: "refused", permanent: false, retryable: true }],
  ["403 rate limit", { status: 403, reason: "userRateLimitExceeded" }, { kind: "refused", permanent: false, retryable: true, providerLimit: "sending_limit" }],
  ["403 daily limit", { status: 403, reason: "dailyLimitExceeded" }, { kind: "refused", permanent: false, retryable: true, providerLimit: "sending_limit" }],
  ["429", { status: 429, reason: "rateLimitExceeded" }, { kind: "refused", permanent: false, retryable: true, providerLimit: "sending_limit" }],
  ["403 missing scope", { status: 403, reason: "insufficientPermissions" }, { kind: "refused", permanent: false, retryable: false }],
  ["500", { status: 500, reason: "backendError", record: true }, "unknown"],
  ["a timeout", "hang", "unknown"],
  ["a send that is taken and never answered", "accept_then_hang", "unknown"],
  ["a garbled 200", "garbled", "unknown"],
])("Gmail answering %s maps to the spec's outcome, and no result or error carries the token", async (_name, step, want) => {
  const { fake, send, ctx, spec } = setup();
  fake.sendScript.push(step);
  if (want === "unknown") {
    const e = await send.execute(spec, ctx()).catch((x: Error) => x);
    expect(e).toBeInstanceOf(Error);
    expect((e as Error).message).not.toContain(fake.token);
  } else {
    const r = await send.execute(spec, ctx());
    expect(r).toMatchObject(want);
    expect(JSON.stringify(r)).not.toContain(fake.token);
  }
});

test("with no credential the send is refused and no request is made", async () => {
  const { fake, send, ctx, spec } = setup();
  expect(await send.execute(spec, ctx(undefined, null))).toEqual({
    kind: "refused",
    permanent: false,
    retryable: false,
    detail: "mailbox not connected",
  });
  expect(fake.calls).toEqual({ send: 0, get: 0, list: 0, history: 0, profile: 0, modify: 0 });
});

test("a spec that is not a Gmail message is refused before any request", async () => {
  const { fake, send, ctx } = setup();
  expect(await send.execute({ to: "x" }, ctx())).toMatchObject({ kind: "refused", permanent: true });
  expect(fake.calls.send).toBe(0);
});

test("reconcile finds a cut-off send by its X-Direx-Action header, even when search hides it", async () => {
  const { fake, send, ctx, spec } = setup();
  const c = ctx();
  fake.sendScript.push("accept_then_hang");
  await expect(send.execute(spec, c)).rejects.toThrow();
  fake.hideFromSearch("m1");
  expect(await send.reconcile!("ignored", c)).toEqual({ kind: "sent", providerRef: "m1" });
});

test("a send older than the scan window is unknown, never not sent, and reconcile never searches", async () => {
  const { fake, send, ctx, spec } = setup();
  const c = ctx();
  fake.sendScript.push("accept_then_hang");
  await expect(send.execute(spec, c)).rejects.toThrow();
  for (let i = 0; i < SENT_SCAN; i++) await send.execute(spec, ctx());
  const lists = fake.calls.list;
  expect(await send.reconcile!("ignored", c)).toEqual({ kind: "unknown" });
  expect(fake.calls.list - lists).toBe(1);
});

test("reconcile never says not sent: a missing message, an error or no credential is unknown", async () => {
  const { fake, send, ctx } = setup();
  expect(await send.reconcile!("ignored", ctx())).toEqual({ kind: "unknown" });
  fake.failNext("list", 500);
  expect(await send.reconcile!("ignored", ctx())).toEqual({ kind: "unknown" });
  expect(await send.reconcile!("ignored", ctx(undefined, null))).toEqual({ kind: "unknown" });
});

test("the profile query returns the connected address", async () => {
  const { plugin, ctx } = setup({ email: "dana@acme.example" });
  expect(await plugin.queries["mailbox.profile"]!({}, ctx())).toEqual({ emailAddress: "dana@acme.example" });
  await expect(plugin.queries["mailbox.profile"]!({}, ctx(undefined, null))).rejects.toThrow("mailbox not connected");
});

test("a profile without an address is a provider error, never an empty address", async () => {
  const { plugin, ctx } = setup({ email: "" });
  await expect(plugin.queries["mailbox.profile"]!({}, ctx())).rejects.toMatchObject({ reason: "provider_error", message: "Gmail gave no address for this account" });
});

test("placement.join sends the approved reply without X-Direx-Action, keeps the Message-ID, and has no reconcile", async () => {
  const { fake, plugin, ctx } = setup();
  const join = plugin.effects["placement.join"]!;
  expect(join.reconcile).toBeUndefined();
  const { spec } = await join.prepare({ to: ["signer@example.com"], subject: "Joining the Placement circle", text: "Part 1: x", inReplyTo: "<p1@mail.gmail.com>", references: ["<p1@mail.gmail.com>"] }, ctx());
  expect(await join.execute(spec, ctx())).toEqual({ kind: "sent", providerRef: "m1", correlationKey: "<gmail-1@mail.gmail.com>" });
  expect(header(fake, 0, "X-Direx-Action")).toBeUndefined();
  expect(header(fake, 0, "In-Reply-To")).toBe("<p1@mail.gmail.com>");
});

test("placement.send sends a Placement check without X-Direx-Action or List-Unsubscribe, keeps Gmail's Message-ID, and has no reconcile", async () => {
  const { fake, plugin, ctx } = setup();
  const check = plugin.effects["placement.send"]!;
  expect(check.reconcile).toBeUndefined();
  expect(gmailManifest.capabilities.find((c) => c.name === "placement.send")).toMatchObject({ kind: "effect", dedupe: "blind", reachesPerson: false });
  const { spec } = await check.prepare({ to: ["kim@circle.example"], subject: "Thursday", text: "Hi, does Thursday still work?" }, ctx());
  expect(await check.execute(spec, ctx())).toEqual({ kind: "sent", providerRef: "m1", correlationKey: "<gmail-1@mail.gmail.com>" });
  expect(header(fake, 0, "X-Direx-Action")).toBeUndefined();
  expect(header(fake, 0, "List-Unsubscribe")).toBeUndefined();
  expect(header(fake, 0, "Subject")).toBe("Thursday");
});
