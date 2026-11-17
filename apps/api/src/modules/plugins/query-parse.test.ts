// SPDX-License-Identifier: AGPL-3.0-only
// The host parses every query's input and answer through its catalogue entry (ADR 0028 rule 001):
// an answer that doesn't fit is the provider's error, named by the query and never by the answer.
import { definePlugin, type QueryName } from "@direx/plugin-sdk";
import { CATALOGUE } from "@direx/plugin-sdk/host";
import { expect, test } from "vitest";
import { CallFailed, loadPlugins } from "./index";

const W = crypto.randomUUID();
const skip = { from: "a@b.example", subject: "Placement", after: 0, before: 1 };
/** An input each query's entry takes. */
const INPUTS: Record<QueryName, unknown> = {
  "mail.from": { email: "ann@b.example", skip: [skip] },
  "mailbox.profile": null,
  "mailbox.probe_read": { actionId: "a1", subject: "Check 1" },
  "placement.read": skip,
  "email.verify": { email: "ann@b.example" },
  "email.verify_balance": null,
  "search.properties": null,
  "search.analytics": { siteUrl: "sc-domain:b.example", startDate: "2026-10-01", endDate: "2026-10-28", dimensions: ["query"] },
  "newsletter.subscribers": {},
  "newsletter.profile": null,
  "newsletter.stats": { issueId: "1" },
  "newsletter.lists": {},
  "social.identity": null,
  "social.health": null,
  "docs.sources": {},
  "docs.page_text": { pageId: "p1" },
  "docs.rows": { sourceId: "s1" },
};
const names = Object.keys(CATALOGUE) as QueryName[];

/** A first-party plugin that answers every query with something no entry takes, holding a secret. */
const liar = definePlugin({
  manifest: {
    id: "com.example.liar",
    apiVersion: 1,
    version: "1.0.0",
    minHostVersion: "0.1.0",
    trust: "first_party",
    connections: [{ key: "svc", auth: "api_key" }],
    egress: { hosts: ["api.example.com"] },
    capabilities: names.map((name) => ({ kind: "query", name, connection: "svc" })),
  },
  queries: Object.fromEntries(names.map((name) => [name, async () => ({ secret: "sk-live-123", rows: "lots" })])),
});
const plugins = loadPlugins({ sources: [{ mode: "in_process", plugin: liar }], credentials: async () => ({ key: "k" }), confinement: "none", log: () => {} });

test.each(names)("a malformed answer to %s is a provider_error naming the query, not the answer", async (name) => {
  const e = await plugins.query(W, `com.example.liar/${name}`, INPUTS[name] as never, null).then(
    () => expect.unreachable(),
    (e: unknown) => e,
  );
  expect(e).toBeInstanceOf(CallFailed);
  expect(e).toMatchObject({ reason: "provider_error", message: `the answer to ${name} does not fit its catalogue entry` });
});

test("an input that doesn't fit its entry never reaches the plugin", async () => {
  await expect(plugins.query(W, "com.example.liar/docs.page_text", { pageId: "" }, null)).rejects.toThrow("the input for docs.page_text does not fit its catalogue entry");
  await expect(plugins.queryTyped(W, "com.example.liar/mailbox.probe_read", { actionId: "a b", subject: "s" }, { key: "k" })).rejects.toMatchObject({ reason: "failed" });
});

test("a typed credential's answer is parsed the same way", async () => {
  await expect(plugins.queryTyped(W, "com.example.liar/social.identity", null, { key: "k" })).rejects.toMatchObject({ reason: "provider_error", message: "the answer to social.identity does not fit its catalogue entry" });
});
