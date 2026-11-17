// SPDX-License-Identifier: AGPL-3.0-only
// The issue screen: writing with a preview of what goes out, the approval cutoff for a tool handed
// issues early, plain stats with opens said to overcount, and a handoff's copy page.
import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { expect, test, vi } from "vitest";
import { api } from "../client";
import { withQueries } from "../testing";
import { previewHtml, statsWords, type Issue as IssueData } from "./actions";
import { Issue } from "./Issue";

const W = "00000000-0000-4000-8000-0000000000aa";
const ID = "00000000-0000-4000-8000-000000000010";
const base: IssueData = {
  itemId: ID,
  state: "draft",
  approveBy: "2026-11-10T08:00:00.000Z",
  warnings: [],
  revision: 1,
  slot: "2026-11-10T08:00:00.000Z",
  title: "Week 45",
  previewText: "",
  markdown: "We **shipped**.",
  html: "<p>We <strong>shipped</strong>.</p>",
  handoffTo: null,
  sentAt: null,
  stats: null,
  statsReadAt: null,
};
const page = (initial: IssueData, role: "owner" | "viewer" = "owner") => renderToString(withQueries(createElement(Issue, { workspaceId: W, itemId: ID, role, initial })));

test("a draft is written in Markdown beside a sandboxed preview of the saved HTML, and goes for approval", () => {
  const html = page(base);
  expect(html).toContain("Markdown: **bold**, # heading, [link](url)");
  expect(html).toContain("Send for approval");
  expect(html).toContain('sandbox=""');
  expect(html).toContain('srcDoc="&lt;p&gt;We &lt;strong&gt;shipped&lt;/strong&gt;.&lt;/p&gt;"');
  expect(html).not.toContain("Approve by");
});

test("the live preview asks the server, so it is the same rendering the issue carries", async () => {
  const post = vi.spyOn(api, "POST").mockResolvedValue({ data: { html: "<h2>Hi</h2>" } } as never);
  expect(await previewHtml(W, "# Hi")).toBe("<h2>Hi</h2>");
  expect(post).toHaveBeenCalledWith("/api/w/{workspaceId}/newsletter/preview", { params: { path: { workspaceId: W } }, body: { markdown: "# Hi" } });
});

test("a tool handed issues early says when approving stops", () => {
  const html = page({ ...base, state: "needs_approval", approveBy: "2026-11-10T07:55:00.000Z" });
  expect(html).toContain("Approve by ");
  expect(html).toContain("Approve · goes out");
});

test("a viewer reads it but can't write or approve it", () => {
  const html = page({ ...base, state: "needs_approval" }, "viewer");
  expect(html).not.toContain("<textarea");
  expect(html).not.toContain("Approve ·");
});

test("after the send the stats are plain, and opens are said to overcount", () => {
  expect(statsWords({ recipients: 1200, delivered: 1180, clicks: 1, unsubscribes: 3, opens: 640 })).toEqual([
    "Sent to 1,200 people, 1,180 delivered.",
    "1 click on links, 3 unsubscribes.",
    "640 opens, but many are recorded automatically by mail apps, so this counts more than really read it.",
  ]);
  const html = page({ ...base, state: "sent", sentAt: "2026-11-10T08:00:00.000Z", stats: { recipients: 2, clicks: 0, unsubscribes: 0, opens: 1 }, statsReadAt: "2026-11-10T09:00:00.000Z" });
  expect(html).toMatch(/<dt[^>]*>Sent to<\/dt><dd[^>]*>2<\/dd>/);
  expect(html).toContain("recorded automatically by mail apps");
  expect(html).not.toContain("<textarea");
});

test("an approved handoff shows the HTML to copy and I sent it, and no editor", () => {
  const html = page({ ...base, state: "scheduled", handoffTo: "Substack" });
  expect(html).toContain("Copy this into Substack");
  expect(html).toContain("Copy HTML");
  expect(html).toContain("I sent it");
  expect(html).not.toContain("Markdown: **bold**, # heading, [link](url)");
});
