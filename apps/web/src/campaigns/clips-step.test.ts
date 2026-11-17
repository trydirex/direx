// SPDX-License-Identifier: AGPL-3.0-only
// A clips step on screen: the setup before a run, its progress during one, each clip with its posts after,
// recordings one after another, what one press approves, and the calls it makes.
import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { beforeAll, afterEach, expect, test, vi } from "vitest";
import { loadLaterFields } from "@/testing";
import { api } from "../client";
import type { Post } from "../social/actions";
import { clipStep, editClipCaption, makeClips, sayClips, type ClipRecording, type ClipStepView, type Step } from "./actions";
import { approvable, ClipsStep } from "./ClipsStep";

// The date, time, number and file fields load on first use; a page rendered to a string shows them only once loaded.
beforeAll(loadLaterFields);

const W = "00000000-0000-4000-8000-0000000000aa";
const ID = "00000000-0000-4000-8000-0000000000bb";
const C1 = "00000000-0000-4000-8000-0000000000c1";
const C2 = "00000000-0000-4000-8000-0000000000c2";
const step = { key: "launch", on: "2026-11-09", title: "Launch", inPlan: true, type: "clips", mailboxCredentialIds: [] } as unknown as Step;
const clip = (id: string, title: string) => ({ id, mediaId: id, startMs: 0, endMs: 31_000, title, caption: `${title} caption`, citations: ["f@1"], measureKey: null, why: "It states the offer." });
const post = (over: Partial<Post>): Post => ({ id: crypto.randomUUID(), itemId: crypto.randomUUID(), clipId: C1, connection: "linkedin", network: "LinkedIn", accountName: "Ana", mode: "publish", text: "Caption", video: null, images: [], url: null, followUps: [], state: "needs_approval", reason: null, revision: 1, clean: true, warnings: [], at: "2026-11-09T09:00:00Z", ...over });
const LI = { connection: "linkedin", credentialId: "00000000-0000-4000-8000-0000000000d1", networkId: "n1" };
const rec = (over: Partial<ClipRecording> = {}): ClipRecording => ({ setup: { sourceMediaId: C1, accounts: [LI], firstAt: "2026-11-09T09:00:00Z" }, run: null, clips: [], unposted: [], idle: [], ...over });
const view = (...recordings: ClipRecording[]): ClipStepView => ({ recordings, lastAccounts: recordings[0]?.setup.accounts ?? [] });
const account = { ...LI, network: "LinkedIn", name: "Ana", canDo: [] } as never;
const network = { connection: "linkedin", label: "LinkedIn", publishes: true } as never;
const render = (v: ClipStepView, posts: Post[] = [], edit = true) => renderToString(createElement(ClipsStep, { workspaceId: W, id: ID, step, edit, approve: true, initial: { accounts: [account], networks: [network], view: v, posts } }));
const done = (id: string) => ({ id, state: "done" as const, failure: null, dropped: [] });

afterEach(() => vi.restoreAllMocks());

test("before a run: upload a recording, pick accounts and a time; a reader sees none of it", () => {
  const html = render(view());
  expect(html).toContain('aria-label="Upload a recording"');
  expect(html).toContain('accept="video/mp4,video/quicktime,video/webm"');
  // The first post defaults to 9:00 on the next morning, shown as its date and time.
  expect(html).toContain('value="November 9, 2026"');
  expect(html).toContain('value="9:00 AM"');
  expect(html).toContain("Make clips");
  expect(render(view(), [], false)).not.toContain("Make clips");
});

test("during a run it says what it is doing, and offers nothing to start", () => {
  const html = render(view(rec({ run: { id: "r", state: "picking", failure: null, dropped: [] } }), rec({ run: done("r0") })));
  expect(html).toContain("Picking the moments worth posting. This takes a few minutes");
  expect(html).not.toContain("Make clips");
});

test("a failed run says why and offers to try again with the same recording", () => {
  const html = render(view(rec({ run: { id: "r", state: "failed", failure: "this video has no sound to transcribe", dropped: [] } })));
  expect(html).toContain("Clipping stopped: this video has no sound to transcribe.");
  expect(html).toContain("Try again");
});

test("after a run: each clip once with its posts, approve only where a post is clean, and what was left out", () => {
  const html = render(
    view(
      rec({
        run: { id: "r", state: "done", failure: null, dropped: [{ moment: { startMs: 0, endMs: 5000, title: "<Short>" }, reason: "is shorter than 20 s" }] },
        clips: [clip(C1, "Setup <in> a day"), clip(C2, "Pricing")],
        unposted: ["x"],
        idle: [{ connection: "x", credentialId: null, networkId: null }],
      }),
    ),
    [post({ text: "One" }), post({ clipId: C2, text: "Two", clean: false, warnings: [{ code: "unspecified", text: "Another post on this account is planned within 15 minutes." }] })],
  );
  expect(html).toContain("Setup &lt;in&gt; a day");
  expect(html).toContain(`src="/api/w/${W}/media/${C1}"`);
  expect(html).toContain("31 s. It states the offer. Backs 1 brand fact.");
  expect(html.match(/Approve this clip/g)).toHaveLength(1);
  expect(html).toContain("Another post on this account is planned within 15 minutes.");
  expect(html).toContain("&lt;Short&gt;: is shorter than 20 s");
  expect(html).toContain("1 more clip doesn&#x27;t fit in a week");
  expect(html).toContain("1 account gets no clip this time");
});

test("recordings one after another: newest first, each with its own clips, and another offered with the last accounts ticked", () => {
  const older = rec({ run: done("r1"), clips: [clip(C1, "Older clip")] });
  const newer = rec({ setup: { sourceMediaId: C2, accounts: [LI], firstAt: "2026-11-12T09:00:00Z" }, run: done("r2"), clips: [clip(C2, "Newer clip")] });
  const html = render(view(newer, older), [post({ clipId: C1, text: "Old post" }), post({ clipId: C2, text: "New post" })]);
  expect(html.indexOf("Newer clip")).toBeLessThan(html.indexOf("Older clip"));
  expect(html.match(/Approve this clip/g)).toHaveLength(2);
  expect(html).toContain("Another recording");
  expect(html).toContain("skipping days it already posts a clip from this step");
  expect(html).toMatch(/<input type="checkbox" checked=""\/> <!-- -->LinkedIn: Ana/);
  expect(render(view())).toMatch(/<input type="checkbox"\/> <!-- -->LinkedIn: Ana/);
});

test("one press approves exactly the clip's waiting posts with no warnings", () => {
  const ok = post({ revision: 3 });
  expect(approvable([ok, post({ clean: false }), post({ state: "scheduled" })])).toEqual([{ id: ok.itemId, revision: 3 }]);
});

test("the calls: make clips, read the step, save a caption, and say why one was refused", async () => {
  const calls: unknown[][] = [];
  vi.spyOn(api, "PUT").mockImplementation((async (...a: unknown[]) => (calls.push(["PUT", ...a]), { error: { error: "in_progress" } })) as never);
  vi.spyOn(api, "GET").mockImplementation((async (...a: unknown[]) => (calls.push(["GET", ...a]), { data: view() })) as never);
  const body = { sourceMediaId: C1, accounts: [{ connection: "linkedin", credentialId: null, networkId: null }], firstAt: "2026-11-09T09:00:00.000Z" };
  expect(await makeClips(W, ID, "launch", body)).toBe("in_progress");
  expect(await clipStep(W, ID, "launch")).toEqual(view());
  expect(await editClipCaption(W, ID, "launch", C1, "Better")).toBe("in_progress");
  const path = { workspaceId: W, id: ID, key: "launch" };
  expect(calls).toEqual([
    ["PUT", "/api/w/{workspaceId}/campaigns/{id}/steps/{key}/clips", { params: { path }, body }],
    ["GET", "/api/w/{workspaceId}/campaigns/{id}/steps/{key}/clips", { params: { path } }],
    ["PUT", "/api/w/{workspaceId}/campaigns/{id}/steps/{key}/clips/{clipId}/caption", { params: { path: { ...path, clipId: C1 } }, body: { text: "Better" } }],
  ]);
  expect(sayClips("not_available")).toBe("Clipping needs a self-hosted Direx server for now.");
  expect(sayClips("anything")).toBe("That didn't go through. Try again.");
});
