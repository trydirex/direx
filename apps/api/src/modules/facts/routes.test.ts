// SPDX-License-Identifier: AGPL-3.0-only
// Brand over HTTP with real sessions and roles, and Actions citing facts through the real Dispatcher.
import { expect, test } from "vitest";
import { POST, actionIdOf, itemsApp, person } from "../items/fixtures/items";
import { createFacts, factKinds, factRoutes, factVersion } from "./index";

const { routes, call, signIn, createOrg, addMember, items, ledger } = await itemsApp({ kinds: factKinds(), resolvers: { fact: factVersion } });
const facts = createFacts({ items: () => items });
routes.route("/", factRoutes({ facts: () => facts }));

const owner = await signIn();
const W = (await createOrg(owner)).workspace.id;
const url = (rest = "") => `/api/w/${W}/facts${rest}`;
const post = (path: string, cookie: string, body?: unknown) => call(path, cookie, { method: "POST", ...(body !== undefined && { body }) });
const setFact = async (subject: string, value = "$1") => (await (await post(url(), owner, { field: "price", subject, value })).json()) as { id: string; version: number };

/** Approves an Action citing these facts, ready for the Dispatcher. */
async function approvedCiting(...cited: { id: string; version: number }[]) {
  const i = await items.createActionItem(W, {
    idempotencyKey: crypto.randomUUID(),
    capability: POST,
    dedupe: "blind",
    spec: { body: "hello" },
    actor: person,
    details: { title: "A post", warnings: [], snapshot: cited.map((f) => ({ kind: "fact", id: f.id, version: String(f.version) })) },
  });
  await items.submitItem(W, i.id, person);
  expect((await post(`/api/w/${W}/items/${i.id}/approve`, owner, { revision: 1 })).status).toBe(200);
  return i.id;
}
const run = async (id: string) => {
  const actionId = await actionIdOf(W, id);
  await ledger.run(W, actionId);
  return { view: (await items.view(W, id))!, action: (await ledger.getAction(W, actionId))! };
};

test("setting, listing and history, with the source from the session", async () => {
  const f = await setFact("per audit", "$4,500");
  expect(f.version).toBe(1);
  expect((await setFact("per audit", "$4,900")).version).toBe(2);
  const { facts: list } = (await (await call(url(), owner)).json()) as { facts: { id: string; value: string; version: number; usable: boolean; source: { kind: string } }[] };
  expect(list.find((x) => x.id === f.id)).toMatchObject({ value: "$4,900", version: 2, usable: true, source: { kind: "person" } });
  const { versions } = (await (await call(url(`/${f.id}/versions`), owner)).json()) as { versions: { value: string }[] };
  expect(versions.map((v) => v.value)).toEqual(["$4,500", "$4,900"]);
});

test("a source, actor or confidence in the request is rejected, not used", async () => {
  expect((await post(url(), owner, { field: "tone", value: "x", source: { kind: "website", label: "y" } })).status).toBe(400);
  expect((await post(url("/proposals"), owner, { field: "tone", value: "x", confidence: "high" })).status).toBe(400);
  expect((await post(url(), owner, { field: "logo", value: "x" })).status).toBe(400);
});

test("a stale edit gets 409, and an unknown fact 404", async () => {
  await setFact("stale");
  await setFact("stale", "$2");
  expect((await post(url(), owner, { field: "price", subject: "stale", value: "$3", expectedVersion: 1 })).status).toBe(409);
  expect((await post(url(`/${crypto.randomUUID()}/retire`), owner)).status).toBe(404);
  expect((await call(url(`/${crypto.randomUUID()}/versions`), owner)).status).toBe(404);
});

test("Marketers edit, Contributors only suggest, Viewers only read", async () => {
  const marketer = await addMember(owner, W, "marketer");
  const contributor = await addMember(owner, W, "contributor");
  const viewer = await addMember(owner, W, "viewer");
  const f = await setFact("roles");
  const edit = (c: string) => post(url(), c, { field: "price", subject: "roles", value: `$${crypto.randomUUID()}` });
  const retire = (c: string) => post(url(`/${f.id}/retire`), c);
  const suggest = (c: string) => post(url("/proposals"), c, { field: "price", subject: "suggested", value: "$5" });

  expect((await edit(contributor.cookie)).status).toBe(403);
  expect((await retire(contributor.cookie)).status).toBe(403);
  for (const req of [edit, retire, suggest]) expect((await req(viewer.cookie)).status).toBe(403);
  expect((await call(url(), viewer.cookie)).status).toBe(200);
  expect((await call(url(`/${f.id}/versions`), viewer.cookie)).status).toBe(200);

  const s = (await (await suggest(contributor.cookie)).json()) as { itemId: string };
  // A Contributor can suggest, and can't accept their own suggestion.
  expect((await post(`/api/w/${W}/items/${s.itemId}/approve`, contributor.cookie, { revision: 1 })).status).toBe(403);
  expect((await post(`/api/w/${W}/items/${s.itemId}/approve`, marketer.cookie, { revision: 1 })).status).toBe(200);
  expect((await edit(marketer.cookie)).status).toBe(200);
  expect((await retire(marketer.cookie)).status).toBe(200);
}, 30_000);

test("deciding a contradiction through the items route", async () => {
  const f = await setFact("decide", "$1");
  const { itemId } = (await (await post(url("/proposals"), owner, { field: "price", subject: "decide", value: "$2" })).json()) as { itemId: string };
  const approve = (body: object) => post(`/api/w/${W}/items/${itemId}/approve`, owner, body);
  const refused = await approve({ revision: 1 });
  expect(await refused.json()).toEqual({ error: "choice_required" });
  expect((await approve({ revision: 1, choice: "use_new" })).status).toBe(200);
  const { versions } = (await (await call(url(`/${f.id}/versions`), owner)).json()) as { versions: { value: string }[] };
  expect(versions.map((v) => v.value)).toEqual(["$1", "$2"]);
});

test("an Action citing a fact is held when it is corrected, and the reason names the fact", async () => {
  const cited = await setFact("cited corrected");
  const id = await approvedCiting(cited);
  await setFact("cited corrected", "$2");
  const { view, action } = await run(id);
  expect(view).toMatchObject({ state: "held", reasonCode: "snapshot_changed" });
  expect(action.reasonDetail).toContain(`fact:${cited.id}`);
});

test("an Action citing a fact is held when it is retired", async () => {
  const cited = await setFact("cited retired");
  const id = await approvedCiting(cited);
  await post(url(`/${cited.id}/retire`), owner);
  expect((await run(id)).view).toMatchObject({ state: "held", reasonCode: "snapshot_changed" });
});

test("work that doesn't cite the changed fact goes out, and a new fact holds nothing", async () => {
  const other = await setFact("other");
  const changed = await setFact("changed");
  const citesOther = await approvedCiting(other);
  const citesNothing = await approvedCiting();
  await setFact("changed", "$2");
  await setFact("brand new");
  expect((await run(citesOther)).view.state).toBe("sent");
  expect((await run(citesNothing)).view.state).toBe("sent");
  expect(changed.id).toBeDefined();
});

test("an open contradiction doesn't hold work already scheduled", async () => {
  const cited = await setFact("contested");
  const id = await approvedCiting(cited);
  await post(url("/proposals"), owner, { field: "price", subject: "contested", value: "$9" });
  expect((await run(id)).view.state).toBe("sent");
});
