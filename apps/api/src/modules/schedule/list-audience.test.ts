// SPDX-License-Identifier: AGPL-3.0-only
// A newsletter issue may name its list instead of a Person. Nothing else may, and the list must be
// the one the Action sends through.
import type { EffectCapability } from "@direx/plugin-sdk";
import { expect, test } from "vitest";
import { touchCheck } from "./index";

const LIST = "00000000-0000-4000-8000-0000000000c1";
const OTHER = "00000000-0000-4000-8000-0000000000c2";
const reaches = { dedupe: "blind", reachesPerson: true, execute: async () => ({ kind: "sent" }) } as unknown as EffectCapability;
const check = touchCheck({ effects: { "com.trydirex.kit/newsletter.publish": reaches, "com.trydirex.gmail/email.send": reaches, "com.trydirex.kit/newsletter.publishing": reaches }, now: () => new Date() });
const approval = { approverId: "u1", standingRuleId: null, producerDigest: null };
const run = (capability: string, credentialId: string | null, audience: unknown) =>
  check({} as never, { id: "a1", capability, credentialId, dueAt: null, spec: { title: "Week 12", audience } } as never, approval);
const audience = (credentialId: string) => ({ kind: "newsletter_list", credentialId });

test("a newsletter issue naming its own list passes without a Touch", async () => {
  expect(await run("com.trydirex.kit/newsletter.publish", LIST, audience(LIST))).toEqual({ kind: "ok" });
});

test("anything else that reaches people still has to name a Person", async () => {
  const blocked = { kind: "block", reason: "touch_undeclared" };
  expect(await run("com.trydirex.gmail/email.send", LIST, audience(LIST))).toMatchObject(blocked);
  expect(await run("com.trydirex.kit/newsletter.publishing", LIST, audience(LIST))).toMatchObject(blocked);
  expect(await run("com.trydirex.kit/newsletter.publish", LIST, audience(OTHER))).toMatchObject(blocked);
  expect(await run("com.trydirex.kit/newsletter.publish", null, audience(LIST))).toMatchObject(blocked);
  expect(await run("com.trydirex.kit/newsletter.publish", LIST, { kind: "everyone", credentialId: LIST })).toMatchObject(blocked);
  expect(await run("com.trydirex.kit/newsletter.publish", LIST, undefined)).toMatchObject(blocked);
});
