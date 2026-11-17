// SPDX-License-Identifier: AGPL-3.0-only
// A post's video on screen: attach while writing, download for a hand post once approved, and the upload call.
import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { beforeAll, afterEach, expect, test, vi } from "vitest";
import { loadLaterFields } from "@/testing";
import { megabytes, uploadImage, uploadVideo, videoUrl, type Post } from "../social/actions";
import type { Step } from "./actions";
import { PostStep } from "./PostStep";
import { withQueries } from "../testing";

// The date, time, number and file fields load on first use; a page rendered to a string shows them only once loaded.
beforeAll(loadLaterFields);

const W = "00000000-0000-4000-8000-0000000000aa";
const ID = "00000000-0000-4000-8000-0000000000bb";
const M = "00000000-0000-4000-8000-0000000000ee";
const step = { key: "launch", on: "2026-11-03", title: "Launch", inPlan: true, type: "post", touchClass: null, mailboxCredentialId: null, audience: "everyone", dmChannel: null, templateRevision: 0, template: null, dependsOnStepKey: null, outputConnection: null, outputNetworkId: null, utm: false, waitingOn: null, output: null } as unknown as Step;
const post: Post = { id: "p", itemId: "00000000-0000-4000-8000-000000000009", clipId: null, connection: "instagram", network: "Instagram", accountName: null, mode: "manual", text: "Launch day", video: { mediaId: M, fileName: "Demo <1>.mp4" }, images: [], url: null, followUps: [], state: "scheduled", reason: null, revision: 1, clean: true, warnings: [], at: null };
const render = (over: Partial<Post> = {}, edit = false) =>
  renderToString(withQueries(createElement(PostStep, { workspaceId: W, id: ID, step, edit, approve: true, initial: { accounts: [], networks: [], posts: [{ ...post, ...over }] } })));

afterEach(() => vi.unstubAllGlobals());

test("an approved hand post offers its video to download next to its text, with the name escaped", () => {
  const html = render();
  expect(html).toContain("Download video");
  expect(html).toContain(`href="/api/w/${W}/media/${M}"`);
  expect(html).toContain('download="Demo &lt;1&gt;.mp4"');
  expect(html).toContain("With a video: Demo &lt;1&gt;.mp4");
  expect(html).toContain("Copy text");
});

test("no download before approval, and none for a post without video", () => {
  expect(render({ state: "needs_approval" })).not.toContain("Download video");
  expect(render({ video: null })).not.toContain("Download video");
  expect(render({ video: null })).not.toContain("With a video");
});

test("writing a post offers a video to add", () => {
  const html = render({}, true);
  expect(html).toContain("Add video");
  expect(html).toContain('accept="video/mp4,video/quicktime,video/webm"');
});

test("the upload streams the file as a clip, with its name encoded, and says why it was refused", async () => {
  const fetch = vi.fn(async () => Response.json({ media: { id: M, fileName: "Demo.mp4", bytes: 5_200_000 } }, { status: 201 }));
  vi.stubGlobal("fetch", fetch);
  const file = new File([new Uint8Array(10)], "Démo 1.mp4", { type: "video/mp4" });
  expect(await uploadVideo(W, file)).toEqual({ video: { id: M, fileName: "Demo.mp4", bytes: 5_200_000 } });
  const [url, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
  expect(url).toBe(`/api/w/${W}/media?kind=clip`);
  expect(init.headers).toMatchObject({ "content-type": "video/mp4", "x-file-name": "D%C3%A9mo%201.mp4" });
  expect(init.body).toBe(file);

  vi.stubGlobal("fetch", async () => Response.json({ error: "too_large" }, { status: 413 }));
  expect(await uploadVideo(W, file)).toEqual({ error: "That file is too large: a video may be up to 2 GB, an image up to 10 MB." });
  vi.stubGlobal("fetch", async () => Response.json({ error: "not_supported" }, { status: 415 }));
  expect(await uploadVideo(W, file)).toEqual({ error: "That isn't an MP4, MOV or WebM video, or a PNG, JPEG, GIF or WebP image." });
  vi.stubGlobal("fetch", async () => new Response("down", { status: 502 }));
  expect(await uploadVideo(W, file)).toEqual({ error: "The upload didn't go through. Try again." });
});

test("sizes read in whole megabytes, never zero", () => {
  expect(megabytes(5_200_000)).toBe("5 MB");
  expect(megabytes(10)).toBe("1 MB");
  expect(videoUrl(W, M)).toBe(`/api/w/${W}/media/${M}`);
});

test("a post's images show in order with their alt text, and an approved hand post offers each to download", () => {
  const images = [
    { mediaId: "00000000-0000-4000-8000-0000000000f1", fileName: "chart.png", alt: "A chart of Q4" },
    { mediaId: "00000000-0000-4000-8000-0000000000f2", fileName: "team.png", alt: "" },
  ];
  const html = render({ video: null, images });
  expect(html).toContain(`<img src="/api/w/${W}/media/${images[0]!.mediaId}" alt="A chart of Q4"`);
  // No alt text written: the file's name stands in, so a screen reader says something.
  expect(html).toContain(`<img src="/api/w/${W}/media/${images[1]!.mediaId}" alt="team.png"`);
  expect(html).toContain('download="chart.png"');
  expect(html).toContain("Download image 2");
});

test("writing a post offers images, each with a description to write", () => {
  const html = render({}, true);
  expect(html).toContain("Add an image");
  expect(html).toContain('accept="image/png,image/jpeg,image/gif,image/webp"');
});

test("an image uploads the same way and comes back as an image", async () => {
  vi.stubGlobal("fetch", async () => Response.json({ media: { id: M, fileName: "chart.png", bytes: 40_000 } }, { status: 201 }));
  expect(await uploadImage(W, new File([new Uint8Array(10)], "chart.png", { type: "image/png" }))).toEqual({ image: { id: M, fileName: "chart.png", bytes: 40_000 } });
  vi.stubGlobal("fetch", async () => Response.json({ error: "too_large" }, { status: 413 }));
  expect(await uploadImage(W, new File([new Uint8Array(10)], "huge.png"))).toEqual({ error: "That file is too large: a video may be up to 2 GB, an image up to 10 MB." });
});
