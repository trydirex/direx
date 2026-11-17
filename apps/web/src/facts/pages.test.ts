// SPDX-License-Identifier: AGPL-3.0-only
// Smoke test for Brand: each role sees what it may do, in glossary terms, and each action
// calls its endpoint.
import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { expect, test, vi } from "vitest";
import { api } from "../client";
import { approve, type Item, type Role } from "../items/actions";
import { retire, save, sourceLabel, suggest, versions, waiting, type Fact } from "./actions";
import { Brand } from "./Brand";
import { withQueries } from "../testing";

const W = "00000000-0000-4000-8000-0000000000aa";
const fact = (o: Partial<Fact> = {}): Fact => ({ id: crypto.randomUUID(), field: "what_you_sell", subject: "", value: "Plain and direct.", version: 1, source: { kind: "website", label: "/about" }, confidence: "high", usable: true, ...o });
const item = (o: Partial<Item>) => ({ id: crypto.randomUUID(), kind: "fact_proposal", state: "needs_approval", title: 'Add to Tone: "Short"', warnings: [], revision: 1, ...o }) as Item;
const page = (role: Role, facts: Fact[] = [fact()], conflicts: Item[] = [], proposals: Item[] = []) =>
  renderToString(withQueries(createElement(Brand, { workspaceId: W, role, initial: { facts, conflicts, proposals } }))).replaceAll("<!-- -->", "");

test("facts show their source, and an empty field says so", () => {
  const html = page("marketer");
  expect(html).toContain("Plain and direct.");
  expect(html).toContain("From /about");
  expect(html).toContain("Not set.");
  expect(sourceLabel({ kind: "person", label: "sam@example.com" })).toBe("Added by sam@example.com");
});

test("Marketers edit and retire, Contributors suggest, Viewers only read", () => {
  const marketer = page("marketer");
  expect(marketer).toContain("Edit");
  expect(marketer).toContain("Remove");
  const contributor = page("contributor");
  expect(contributor).toContain("Suggest a change");
  expect(contributor).not.toContain("Remove");
  const viewer = page("viewer");
  for (const word of ["Edit", "Remove", "Suggest a change", "<textarea", "<form"]) expect(viewer).not.toContain(word);
});

test("a contradiction offers three answers to whoever may decide, and marks the fact", () => {
  const conflict = item({ kind: "fact_conflict", title: "Prices: needs a decision", warnings: [{ code: "unspecified", text: 'Two values don\'t match: "$4,500" from /services, and "$3,900" from deck.pdf' }] });
  const html = page("marketer", [fact({ field: "price", subject: "per audit", value: "$4,500", usable: false })], [conflict]).replaceAll("&#x27;", "'").replaceAll("&quot;", '"');
  expect(html).toContain('"$3,900" from deck.pdf');
  for (const word of ["Keep the current one", "Use the new one", "Don't mention this", "Needs a decision", "per audit: $4,500"]) expect(html).toContain(word);
  expect(page("contributor", [], [conflict])).not.toContain("Use the new one");
});

test("a proposal offers Accept and Dismiss, and shows its warning", () => {
  const html = page("marketer", [], [], [item({ warnings: [{ code: "unspecified", text: "low confidence" }] })]);
  for (const word of ["Add this?", "Accept", "Dismiss", "low confidence"]) expect(html).toContain(word);
  expect(page("viewer", [], [], [item({})])).not.toContain("Accept");
});

test("the page uses glossary words", () => {
  expect(page("owner").replace(/<[^>]+>/g, " ")).not.toMatch(/\b(tenant|failed)\b/i);
});

test("each action calls its endpoint", async () => {
  const post = vi.spyOn(api, "POST").mockResolvedValue({ data: {}, error: undefined } as never);
  const get = vi.spyOn(api, "GET").mockResolvedValue({ data: { items: [item({}), item({ kind: "fact_conflict" }), item({ kind: "action" })], versions: [] } } as never);
  const all = { path: { workspaceId: W } };
  const v = { field: "tone" as const, value: "x" };
  await save(W, { ...v, expectedVersion: 2 });
  expect(post).toHaveBeenLastCalledWith("/api/w/{workspaceId}/facts", { params: all, body: { ...v, expectedVersion: 2 } });
  await suggest(W, v);
  expect(post).toHaveBeenLastCalledWith("/api/w/{workspaceId}/facts/proposals", { params: all, body: v });
  await retire(W, "f");
  expect(post).toHaveBeenLastCalledWith("/api/w/{workspaceId}/facts/{id}/retire", { params: { path: { workspaceId: W, id: "f" } } });
  await approve(W, { id: "i", revision: 1 }, "use_new");
  expect(post).toHaveBeenLastCalledWith("/api/w/{workspaceId}/items/{id}/approve", { params: { path: { workspaceId: W, id: "i" } }, body: { revision: 1, choice: "use_new" } });
  const w = await waiting(W);
  expect([w.conflicts.length, w.proposals.length]).toEqual([1, 1]);
  await versions(W, "f");
  expect(get).toHaveBeenLastCalledWith("/api/w/{workspaceId}/facts/{id}/versions", { params: { path: { workspaceId: W, id: "f" } } });
  vi.restoreAllMocks();
});
