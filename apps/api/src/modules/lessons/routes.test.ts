// SPDX-License-Identifier: AGPL-3.0-only
// Lessons over HTTP with real sessions and roles: who may suggest, change and withdraw a lesson.
import { expect, test } from "vitest";
import { factKinds } from "../facts/index";
import { itemsApp } from "../items/fixtures/items";
import type { Items } from "../items/index";
import type { Models } from "../models/index";
import { createLessons, lessonRoutes } from "./index";

const state = { open: true };
const generate = (async () => ({ ok: true, callId: crypto.randomUUID(), routeHash: "r", output: { schemaVersion: 1, verdict: "clean", reasons: [] } })) as unknown as Models["generate"];
const late: { items?: Items } = {};
const lessons = createLessons({
  items: () => late.items!,
  generate: () => generate,
  checkOpen: () => state.open,
  suspendRules: async () => 0,
  warnDrafts: async () => {},
  applyFact: factKinds().fact_proposal!.apply,
  liveFacts: async () => [],
  now: () => new Date(),
});
const app = await itemsApp({ kinds: lessons.kinds() });
late.items = app.items;
app.routes.route("/", lessonRoutes({ lessons: () => lessons, agents: () => ["recipient_writer"], definitionVersion: () => 2 }));
const { call, signIn, createOrg, addMember } = app;

const owner = await signIn();
const W = (await createOrg(owner)).workspace.id;
const proposer = await addMember(owner, W, "marketer");
const marketer = proposer.cookie;
const viewer = (await addMember(owner, W, "viewer")).cookie;
const url = (rest = "") => `/api/w/${W}/lessons${rest}`;
const post = (path: string, cookie: string, body: unknown) => call(path, cookie, { method: "POST", body });

test("a person who may edit suggests a lesson for a known writer; it waits for someone who may grant rules", async () => {
  expect((await post(url(), viewer, { agent: "recipient_writer", text: "Keep it short." })).status).toBe(403);
  expect(await (await post(url(), marketer, { agent: "made_up", text: "Keep it short." })).json()).toEqual({ error: "unknown_agent" });
  state.open = false;
  const closed = await post(url(), marketer, { agent: "recipient_writer", text: "Keep it short." });
  expect([closed.status, await closed.json()]).toEqual([409, { error: "lesson_check_unevaluated" }]);
  state.open = true;
  const made = (await (await post(url(), marketer, { agent: "recipient_writer", text: "First emails here run short.", sourceRef: "campaign:c/s/p" })).json()) as { itemId: string };
  const approve = await post(`/api/w/${W}/items/${made.itemId}/approve`, marketer, { revision: 1 });
  expect(approve.status).toBe(403);
  expect((await post(`/api/w/${W}/items/${made.itemId}/approve`, owner, { revision: 1 })).status).toBe(200);

  const listed = (await (await call(url("?agent=recipient_writer"), viewer)).json()) as { lessons: { id: string; version: number; text: string; origin: unknown }[] };
  expect(listed.lessons.map((l) => l.text)).toEqual(["First emails here run short."]);
  // Where it came from: the proposal Item, the edit it followed and who proposed it, not who accepted it.
  expect(listed.lessons[0]!.origin).toEqual({ itemId: made.itemId, sourceRef: "campaign:c/s/p", proposedBy: proposer.email });
});

test("changing, withdrawing and moving a lesson to Brand", async () => {
  const [l] = ((await (await call(url(), owner)).json()) as { lessons: { id: string; version: number }[] }).lessons;
  expect((await post(url(`/${l!.id}/rewrite`), marketer, { version: 1, text: "x" })).status).toBe(403);
  expect(await (await post(url(`/${l!.id}/rewrite`), owner, { version: 1, text: "First emails here run under 90 words." })).json()).toEqual({ ok: true, version: 2 });
  const rewritten = ((await (await call(url(), owner)).json()) as { lessons: { origin: { sourceRef: string | null } }[] }).lessons[0]!;
  expect(rewritten.origin.sourceRef).toBe("campaign:c/s/p");
  const fact = await post(url(`/${l!.id}/to-fact`), marketer, { version: 2, field: "tone", sourceLabel: "Sales lead" });
  expect(fact.status).toBe(200);
  expect(await (await post(url(`/${l!.id}/retire`), owner, { version: 1 })).json()).toEqual({ error: "target_changed" });
  expect((await post(url(`/${crypto.randomUUID()}/retire`), owner, { version: 1 })).status).toBe(404);
  expect(await (await post(url(`/${l!.id}/retire`), owner, { version: 2 })).json()).toEqual({ ok: true });
  expect(((await (await call(url(), owner)).json()) as { lessons: unknown[] }).lessons).toEqual([]);
});
