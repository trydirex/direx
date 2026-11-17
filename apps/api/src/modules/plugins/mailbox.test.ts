// SPDX-License-Identifier: AGPL-3.0-only
// Core finds a mailbox provider from its manifest, whichever plugin it is.
import { parseManifest } from "@direx/plugin-sdk";
import { expect, test } from "vitest";
import { mailboxShapes } from "./application/mailbox";
import { createTestMail, testMailManifest } from "./fixtures/mailbox";
import { behaveManifest } from "./fixtures/manifest";
import { loadPlugins } from "./index";

const parsed = (m: unknown) => {
  const r = parseManifest(m);
  if (!r.ok) throw new Error(r.errors.join("; "));
  return r.manifest;
};
const load = (log: (l: string) => void = () => {}, fixtures = [createTestMail()]) =>
  loadPlugins({ sources: fixtures.map(({ plugin }) => ({ mode: "in_process" as const, plugin })), credentials: async () => ({ key: "k" }), confinement: "none", log });

test("a plugin with all four capabilities on a connection is a mailbox provider", () => {
  const plugins = load();
  expect(plugins.mailboxFor("testmail")).toEqual({
    pluginId: "com.example.testmail",
    connection: "testmail",
    dedupe: "blind",
    send: "com.example.testmail/email.send",
    mailFrom: "com.example.testmail/mail.from",
    profile: "com.example.testmail/mailbox.profile",
    readsSent: false,
  });
  expect(plugins.mailboxConnections()).toEqual(["testmail"]);
  expect(plugins.mailboxBySend("com.example.testmail/email.send")?.connection).toBe("testmail");
});

test("an unknown connection, no connection, or another capability finds no provider", () => {
  const plugins = load();
  expect(plugins.mailboxFor("nothing")).toBeUndefined();
  expect(plugins.mailboxFor(null)).toBeUndefined();
  expect(plugins.mailboxBySend("com.example.other/post.publish")).toBeUndefined();
});

test.each(["email.send", "email.received", "mailbox.profile", "mail.from"])("a plugin lacking %s is not a mailbox provider, and says so", (name) => {
  const m = parsed({ ...testMailManifest, capabilities: testMailManifest.capabilities.filter((c) => c.name !== name) });
  expect(mailboxShapes(m)).toEqual({ shapes: [], incomplete: [{ connection: "testmail", missing: [name] }] });
});

test("a plugin with no mail capabilities is left alone", () => {
  expect(mailboxShapes(parsed(behaveManifest))).toEqual({ shapes: [], incomplete: [] });
});

test("the host logs what an incomplete provider lacks", () => {
  const logs: string[] = [];
  const { plugin } = createTestMail();
  const manifest = parsed({ ...testMailManifest, capabilities: testMailManifest.capabilities.filter((c) => c.name !== "mail.from") });
  const plugins = loadPlugins({ sources: [{ mode: "in_process", plugin: { ...plugin, manifest } }], credentials: async () => null, confinement: "none", log: (l) => logs.push(l) });
  expect(plugins.mailboxConnections()).toEqual([]);
  expect(logs.join()).toContain("it lacks mail.from");
});

test("two providers can't share a connection", () => {
  const second = createTestMail();
  const plugin = { ...second.plugin, manifest: { ...second.plugin.manifest, id: "com.example.other" } };
  expect(() => load(() => {}, [createTestMail(), { ...second, plugin }])).toThrow(/two mailbox providers/);
});
