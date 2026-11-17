// SPDX-License-Identifier: MIT
import { expect, test } from "vitest";
import * as sdk from "../src/host";
import { definePlugin, parseManifest } from "../src/index";

const base = () => ({
  id: "com.example.mail",
  apiVersion: 1,
  version: "1.0.0",
  minHostVersion: "0.1.0",
  trust: "third_party",
  connections: [{ key: "mail", auth: "oauth2" }],
  egress: { hosts: ["api.example.com"] },
  capabilities: [
    { kind: "effect", name: "email.send", connection: "mail", dedupe: "blind", risk: "medium", reachesPerson: true } as Record<string, unknown>,
  ],
});

const errorsOf = (m: unknown) => {
  const r = parseManifest(m);
  return r.ok ? [] : r.errors;
};

test("a complete manifest is accepted", () => {
  expect(parseManifest(base())).toMatchObject({ ok: true });
  expect(parseManifest({ ...base(), name: "Example Mail" })).toMatchObject({ ok: true, manifest: { name: "Example Mail" } });
  expect(errorsOf({ ...base(), name: "" })).toEqual([expect.stringMatching(/^name/)]);
});

test("unknown fields, kinds, dedupe classes and risks are rejected with the field named", () => {
  expect(errorsOf({ ...base(), extra: 1 })).toEqual([expect.stringMatching(/^manifest: .*extra/)]);
  const kind = base();
  kind.capabilities[0]!.kind = "agent";
  expect(errorsOf(kind)).toEqual([expect.stringMatching(/^capabilities\.0\.kind/)]);
  const dedupe = base();
  dedupe.capabilities[0]!.dedupe = "maybe";
  expect(errorsOf(dedupe)).toEqual([expect.stringMatching(/^capabilities\.0\.dedupe/)]);
  const risk = base();
  risk.capabilities[0]!.risk = "none";
  expect(errorsOf(risk)).toEqual([expect.stringMatching(/^capabilities\.0\.risk/)]);
});

test("an effect without dedupe, risk or reachesPerson is rejected", () => {
  for (const field of ["dedupe", "risk", "reachesPerson"]) {
    const m = base();
    delete m.capabilities[0]![field];
    expect(errorsOf(m)).toEqual([expect.stringMatching(new RegExp(`^capabilities\\.0\\.${field}`))]);
  }
});

test("provider_idempotent needs keyWindowMs, connections must exist, names must be unique", () => {
  const pi = base();
  pi.capabilities[0]!.dedupe = "provider_idempotent";
  expect(errorsOf(pi)).toEqual(["capabilities.0.keyWindowMs: required for provider_idempotent"]);

  const conn = base();
  conn.capabilities[0]!.connection = "crm";
  expect(errorsOf(conn)).toEqual(["capabilities.0.connection: no connection named crm"]);

  const also = base();
  also.connections.push({ key: "mail_key", auth: "api_key" });
  also.capabilities[0]!.alsoConnections = ["mail_key"];
  expect(parseManifest(also)).toMatchObject({ ok: true });
  also.capabilities[0]!.alsoConnections = ["mail_key", "crm"];
  expect(errorsOf(also)).toEqual(["capabilities.0.alsoConnections.1: no connection named crm"]);

  const dup = base();
  dup.capabilities.push({ ...dup.capabilities[0]! });
  expect(errorsOf(dup)).toEqual(["capabilities.1.name: duplicate capability email.send"]);
});

test("a third-party plugin that connects must list its hosts", () => {
  expect(errorsOf({ ...base(), egress: { hosts: [] } })).toEqual([expect.stringMatching(/^egress\.hosts/)]);
  expect(errorsOf({ ...base(), egress: { hosts: ["http://x.com"] } })).toEqual([expect.stringMatching(/^egress\.hosts\.0/)]);
});

test("poll triggers poll at most once a minute; webhook triggers need a known signature scheme", () => {
  const poll = { ...base(), capabilities: [{ kind: "trigger", name: "mail.received", connection: "mail", source: "poll", pollIntervalMs: 59_999 }] };
  expect(errorsOf(poll)).toEqual([expect.stringMatching(/^capabilities\.0\.pollIntervalMs/)]);
  const hook = { ...base(), capabilities: [{ kind: "trigger", name: "mail.received", connection: "mail", source: "webhook" }] };
  expect(errorsOf(hook)).toEqual([expect.stringMatching(/^capabilities\.0\.signature/)]);
  hook.capabilities[0] = { ...hook.capabilities[0]!, signature: { scheme: "jwt", header: "x-sig" } } as never;
  expect(errorsOf(hook)).toEqual([expect.stringMatching(/^capabilities\.0\.signature\.scheme/)]);
});

const send = { prepare: async (i: unknown) => ({ spec: i, preview: "" }), execute: async () => ({ kind: "sent" as const }) };

test("definePlugin needs a handler for every declared capability, and nothing undeclared", () => {
  expect(() => definePlugin({ manifest: base() })).toThrow(/effect email.send has no handler/);
  expect(() => definePlugin({ manifest: base(), effects: { "email.send": send, "sms.send": send } })).toThrow(
    /effect handler sms.send is not in the manifest/,
  );
  const q = base();
  q.capabilities[0]!.dedupe = "queryable";
  expect(() => definePlugin({ manifest: q, effects: { "email.send": send } })).toThrow(/queryable effect email.send has no reconcile/);
  expect(definePlugin({ manifest: base(), effects: { "email.send": send } }).manifest.id).toBe("com.example.mail");
});

test("the SDK has no way to fetch a secret", () => {
  expect(Object.keys(sdk).filter((k) => /secret|resolve|credential/i.test(k))).toEqual([]);
});

test("a connection may declare any credential kind the vault stores, and nothing else", () => {
  for (const auth of ["oauth2", "api_key", "header", "basic", "secret", "none"]) {
    expect(parseManifest({ ...base(), connections: [{ key: "mail", auth }] }), auth).toMatchObject({ ok: true });
  }
  expect(errorsOf({ ...base(), connections: [{ key: "mail", auth: "bearer" }] })).toEqual([expect.stringMatching(/auth/)]);
});

test("a query must be one the catalogue holds", () => {
  const q = (name: string) => ({ ...base(), capabilities: [{ kind: "query", name, connection: "mail" }] });
  expect(parseManifest(q("mail.from"))).toMatchObject({ ok: true });
  expect(parseManifest(q("newsletter.lists"))).toMatchObject({ ok: true });
  expect(errorsOf(q("crm.contacts"))).toEqual([expect.stringMatching(/^capabilities\.0\.name: not a query Direx knows/)]);
});

test("an agent query is found only by name and version, and code-only queries are not agent queries", () => {
  expect(sdk.agentQuery("mail.from@1")?.scope).toBe("person_address_in_run");
  for (const ref of ["mail.from", "mail.from@2", "mailbox.profile@1"]) expect(sdk.agentQuery(ref), ref).toBeUndefined();
  for (const q of sdk.AGENT_QUERIES) expect(sdk.QUERY_NAMES.has(q.name)).toBe(true);
});

test("mail.from shows the model the newest messages, trimmed, and drops bounces and anything it can't read", () => {
  const q = sdk.agentQuery("mail.from@1")!;
  expect(q.input.safeParse({ email: "a@b.example" }).success).toBe(true);
  expect(q.input.safeParse({ email: "a@b.example", q: "in:sent" }).success).toBe(false);
  const msg = (date: string, extra: Record<string, unknown> = {}) => ({
    kind: "message",
    headers: { from: "Ann <a@b.example>", to: "me@x.example", subject: `s ${date}`, date },
    text: "x".repeat(5000),
    ...extra,
  });
  const wire = q.output.parse({
    events: [
      { eventId: "1", data: msg("Mon, 02 Nov 2026 10:00:00 +0000") },
      { eventId: "2", data: msg("2026-11-04T10:00:00.000Z") },
      { eventId: "3", data: msg("2026-11-05T10:00:00.000Z", { bounce: true }) },
      { eventId: "4", data: { kind: "message" } },
      ...Array.from({ length: 12 }, (_, i) => ({ eventId: `old${i}`, data: msg(`2026-10-0${(i % 9) + 1}T00:00:00.000Z`) })),
    ],
  });
  const { messages } = q.view(wire) as { messages: { subject: string; excerpt: string }[] };
  expect(messages).toHaveLength(10);
  expect(messages.slice(0, 2).map((m) => m.subject)).toEqual(["s 2026-11-04T10:00:00.000Z", "s Mon, 02 Nov 2026 10:00:00 +0000"]);
  expect(messages[0]!.excerpt).toHaveLength(1000);
  expect(messages[0]).toEqual({ from: "Ann <a@b.example>", date: "2026-11-04T10:00:00.000Z", subject: "s 2026-11-04T10:00:00.000Z", excerpt: "x".repeat(1000) });
  expect(q.output.safeParse({ events: [], extra: "ignore me" }).success).toBe(false);
});
