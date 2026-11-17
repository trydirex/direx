// SPDX-License-Identifier: AGPL-3.0-only
// An SEO brief step on screen: the page and search before a Brief, its state after, the link field once
// it is approved, and the words for each refusal.
import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { afterEach, expect, test, vi } from "vitest";
import { api } from "../client";
import { makeBrief, sayBrief, type BriefStepView, type Step } from "./actions";
import { withQueries } from "../testing";
import { BriefStep } from "./BriefStep";

const W = "00000000-0000-4000-8000-0000000000aa";
const ID = "00000000-0000-4000-8000-0000000000bb";
const ITEM = "00000000-0000-4000-8000-0000000000cc";
const step = (over: Partial<Step> = {}) => ({ key: "rank", on: "2026-11-09", title: "Rank", inPlan: true, type: "seo_brief", mailboxCredentialIds: [], dependsOnStepKey: null, ...over }) as unknown as Step;
const view = (over: Partial<BriefStepView> = {}): BriefStepView => ({ setup: null, brief: null, available: true, ...over });
const render = (v: BriefStepView, s: Step = step(), edit = true) => renderToString(withQueries(createElement(BriefStep, { workspaceId: W, id: ID, step: s, edit, initial: v }, createElement("p", null, "LINK FIELD"))));

afterEach(() => vi.restoreAllMocks());

test("before a Brief: a page and a search to fill in; a reader sees no form", () => {
  const html = render(view());
  expect(html).toContain('type="url"');
  expect(html).toContain("Make brief");
  expect(html).not.toContain("LINK FIELD");
  expect(render(view(), step(), false)).not.toContain("Make brief");
});

test("a step that waits on another names it instead of asking for a page", () => {
  const html = render(view({ setup: { page: null, query: "acme pricing" } }), step({ dependsOnStepKey: "page" } as Partial<Step>));
  expect(html).toContain("Page: the link from step <!-- -->page");
  expect(html).not.toContain('type="url"');
  expect(html).toContain('value="acme pricing"');
});

test("each state says where the Brief stands, and only approval shows the link field", () => {
  const running = render(view({ brief: { state: "running" } }));
  expect(running).toContain("Reading the page and writing the Brief");
  expect(running).not.toContain("Make brief");
  expect(render(view({ brief: { state: "waiting", itemId: ITEM } }))).toContain("Needs approval");
  expect(render(view({ brief: { state: "approved", itemId: ITEM } }))).toContain("Applied");
  expect(running).not.toContain("Needs approval");
  expect(render(view({ brief: { state: "waiting", itemId: ITEM } }))).toMatch(new RegExp(`<a [^>]*href="/w/${W}"[^>]*>Home</a>`));
  expect(render(view({ brief: { state: "no_brief", reason: "no_gaps" } }))).toContain("found nothing to change");
  expect(render(view({ brief: { state: "failed", reason: "<b>x</b>" } }))).not.toContain("<b>x</b>");
  const approved = render(view({ brief: { state: "approved", itemId: ITEM } }));
  expect(approved).toContain("LINK FIELD");
  expect(approved).not.toContain("Make brief");
  expect(render(view({ available: false }))).toContain("self-hosted Direx server");
  expect(render(view({ available: false }))).not.toContain("Make brief");
});

test("refusals and runs without a Brief read as words", () => {
  expect(sayBrief("brief_waiting")).toContain("Approve or dismiss it first");
  expect(sayBrief("model_refusal")).toContain("didn't come back as a Brief");
  expect(sayBrief("brief_refused: quote not on the page")).toContain("quoted words that aren't on the page");
  expect(sayBrief("something_new")).toBe("That didn't work. Try again.");
});

test("Make brief sends the page and search to the step", async () => {
  const put = vi.spyOn(api, "PUT").mockResolvedValue({ data: { runId: ITEM }, response: new Response() } as never);
  expect(await makeBrief(W, ID, "rank", { page: "https://acme.test/pricing", query: "acme pricing" })).toBeNull();
  expect(put).toHaveBeenCalledWith("/api/w/{workspaceId}/campaigns/{id}/steps/{key}/brief", { params: { path: { workspaceId: W, id: ID, key: "rank" } }, body: { page: "https://acme.test/pricing", query: "acme pricing" } });
  put.mockResolvedValue({ error: { error: "brief_running" }, response: new Response() } as never);
  expect(await makeBrief(W, ID, "rank", { page: null, query: "acme pricing" })).toBe("brief_running");
});
