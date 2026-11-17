// SPDX-License-Identifier: AGPL-3.0-only
// Video posts against fakes written from each network's docs: what is refused at draft, and the
// upload, wait and post at publish. Nothing is posted with bytes other than the approved ones.
import { type MediaLink, type MediaRef, type Plugin } from "@direx/plugin-sdk";
import { invoke } from "../test-wire";
import { createHash, randomUUID } from "node:crypto";
import { afterAll, beforeEach, describe, expect, test } from "vitest";
import { createBlueskyPlugin } from "./bluesky/plugin";
import { fakeBluesky } from "./bluesky/fake-bluesky";
import { fakeFacebook } from "./facebook/fake-facebook";
import { createFacebookPlugin } from "./facebook/plugin";
import { fakeLinkedIn } from "./linkedin/fake-linkedin";
import { createLinkedInPlugin } from "./linkedin/plugin";
import { fakeThreads } from "./threads/fake-threads";
import { createThreadsPlugin } from "./threads/plugin";
import { fakeX } from "./x/fake-x";
import { createXPlugin } from "./x/plugin";

const MiB = 1024 * 1024;
const file = new Uint8Array(9 * MiB).map((_, i) => i % 253);
const sha = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");
let served: Uint8Array<ArrayBuffer> = file;
// The approved file, as the host's link serves it.
const files = Bun.serve({ port: 0, fetch: () => new Response(served) });
const li = fakeLinkedIn();
const x = fakeX();
const bsky = fakeBluesky();
const fb = fakeFacebook();
const th = fakeThreads();
const fakes = [li, x, bsky, fb, th];
afterAll(() => {
  files.stop(true);
  for (const f of fakes) f.stop();
});
beforeEach(() => {
  for (const f of fakes) f.reset();
  served = file;
});

const o = { baseUrl: li.url, timeoutMs: 2000, videoWait: { everyMs: 5, forMs: 30 } };
const ctx = { workspaceId: "w", log: () => undefined };
const token = { accessToken: "T", expiresAt: "2030-01-01T00:00:00.000Z" };
const ref = (over: Partial<MediaRef> = {}): MediaRef => ({ mediaId: randomUUID(), sha256: sha(file), bytes: file.length, contentType: "video/mp4", ...over });
const linkOf = (r: MediaRef): MediaLink => ({ url: `http://localhost:${files.port}/f`, sha256: r.sha256, bytes: r.bytes, contentType: r.contentType });
const prepare = (p: Plugin, media?: MediaRef[]) => invoke(p, "prepare", { capability: "social.publish", input: { text: "watch this", followUps: [], target: "me", links: true, ...(media && { media }) } }, ctx) as Promise<{ spec: Record<string, unknown> }>;
type Result = { kind: string; retryable?: boolean; detail?: string; url?: string; providerRef?: string };
const execute = (p: Plugin, r: MediaRef, links: Record<string, MediaLink> = { [r.mediaId]: linkOf(r) }, over: { credential?: unknown; target?: string } = {}) =>
  invoke(p, "execute", { capability: "social.publish", spec: { text: "watch this", followUps: [], target: over.target ?? "me", media: [r] }, idempotencyKey: "k", credential: over.credential ?? token, media: links }, ctx) as Promise<Result>;
const swapped = () => (served = file.map((b, i) => (i === 5 ? b ^ 1 : b)));

describe("at draft", () => {
  const p = createLinkedInPlugin(o);
  test("a video post carries its file; a text post has no media at all, so its approval hash is unchanged", async () => {
    const r = ref();
    expect((await prepare(p, [r])).spec).toEqual({ text: "watch this", followUps: [], target: "me", media: [r] });
    expect(Object.keys((await prepare(p)).spec)).toEqual(["text", "followUps", "target"]);
  });
  test("a file the network won't take is refused in the person's words", async () => {
    await expect(prepare(p, [ref({ bytes: 640 * 1_000_000 })])).rejects.toThrow("LinkedIn takes MP4 up to 500 MB; this file is 640 MB");
    await expect(prepare(p, [ref({ contentType: "video/quicktime" })])).rejects.toThrow("LinkedIn takes MP4 up to 500 MB; this file is MOV");
    await expect(prepare(createXPlugin(o), [ref({ contentType: "video/webm" })])).rejects.toThrow("X takes MP4 up to 512 MB; this file is WebM");
    await expect(invoke(createFacebookPlugin(o), "prepare", { capability: "social.publish", input: { text: "t", followUps: [], target: "me", links: true, media: [ref()] } }, ctx)).resolves.toBeTruthy();
  });
  test("one video per post", async () => {
    await expect(prepare(p, [ref(), ref()])).rejects.toThrow();
  });
});

describe("LinkedIn", () => {
  const p = createLinkedInPlugin(o);
  test("uploads in LinkedIn's parts, waits for processing, then posts the video", async () => {
    li.processing.push("PROCESSING", "PROCESSING");
    const r = ref();
    expect(await execute(p, r)).toEqual({ kind: "sent", providerRef: "urn:li:share:7", url: "https://www.linkedin.com/feed/update/urn:li:share:7/" });
    expect(li.calls.filter((s) => s.path.startsWith("/upload/")).map((s) => s.bytes)).toEqual([4 * MiB, 4 * MiB, MiB]);
    const finalize = JSON.parse(li.calls.find((s) => s.path.includes("finalizeUpload"))!.body);
    expect(finalize.finalizeUploadRequest).toEqual({ video: "urn:li:video:V1", uploadToken: "", uploadedPartIds: ["e0", "e1", "e2"] });
    expect(JSON.parse(li.calls.at(-1)!.body)).toMatchObject({ author: "urn:li:person:me", content: { media: { id: "urn:li:video:V1" } } });
    expect(li.paths().filter((x) => x.startsWith("/rest/videos/"))).toHaveLength(3);
  });
  test("bytes that aren't the approved ones are held and nothing is posted", async () => {
    served = file.map((b, i) => (i === 5 ? b ^ 1 : b));
    expect(await execute(p, ref())).toMatchObject({ kind: "refused", retryable: false, detail: "the video is not the one approved, so it was not posted" });
    expect(li.paths()).not.toContain("/rest/posts");
    expect(li.paths()).not.toContain("/rest/videos?action=finalizeUpload");
  });
  test("still processing at the end is retried later; a failed processing waits for a person; neither posts", async () => {
    li.processing.push(...Array<string>(100).fill("PROCESSING"));
    expect(await execute(p, ref())).toMatchObject({ kind: "refused", retryable: true, detail: "LinkedIn was still processing the video" });
    li.reset();
    li.processing.push("PROCESSING_FAILED");
    expect(await execute(p, ref())).toMatchObject({ kind: "refused", retryable: false, detail: "LinkedIn could not process the video: bad codec" });
    expect(li.paths()).not.toContain("/rest/posts");
  });
  test("a video post with no link from the host is held", async () => {
    expect(await execute(p, ref(), {})).toMatchObject({ kind: "refused", retryable: false, detail: "the approved video was not handed to this post" });
    expect(li.calls).toEqual([]);
  });
  test("a failed upload part is retried later, before anything is posted", async () => {
    const failing = createLinkedInPlugin({ ...o, fetch: ((url: string, init: RequestInit) => (String(url).includes("/upload/1") ? Promise.resolve(new Response(null, { status: 500 })) : fetch(url, init))) as unknown as typeof fetch });
    expect(await execute(failing, ref())).toMatchObject({ kind: "refused", retryable: true, detail: "LinkedIn answered 500 to an upload part" });
    expect(li.paths()).not.toContain("/rest/posts");
  });
});

describe("X", () => {
  const p = createXPlugin({ ...o, baseUrl: x.url });
  test("uploads in segments of 5 MB or less, waits for processing, then posts with the media id", async () => {
    x.processing.push("pending", "in_progress");
    expect(await execute(p, ref())).toEqual({ kind: "sent", providerRef: "T1", url: "https://x.com/i/status/T1" });
    expect(JSON.parse(x.calls[0]!.body)).toEqual({ media_type: "video/mp4", total_bytes: file.length, media_category: "tweet_video" });
    const parts = x.calls.filter((c) => c.path.endsWith("/append"));
    expect(parts.map((c) => c.bytes)).toEqual([4 * MiB, 4 * MiB, MiB]);
    expect(parts.map((c) => c.body)).toEqual(["segment_index=0", "segment_index=1", "segment_index=2"]);
    expect(x.paths().filter((path) => path.includes("command=STATUS"))).toHaveLength(2);
    expect(JSON.parse(x.calls.at(-1)!.body)).toEqual({ text: "watch this", media: { media_ids: ["M1"] } });
  });
  test("other bytes, a failed processing or one still running at the end post nothing", async () => {
    swapped();
    expect(await execute(p, ref())).toMatchObject({ retryable: false, detail: "the video is not the one approved, so it was not posted" });
    served = file;
    x.processing.push("failed");
    expect(await execute(p, ref())).toMatchObject({ retryable: false, detail: "X could not process the video: InvalidMedia" });
    x.processing.push(...Array<string>(100).fill("in_progress"));
    expect(await execute(p, ref())).toMatchObject({ retryable: true, detail: "X was still processing the video" });
    expect(x.paths()).not.toContain("/2/tweets");
  });
  test("X refusing the upload for this app's access waits for a person", async () => {
    const refusing = createXPlugin({ ...o, baseUrl: x.url, fetch: ((url: string, init: RequestInit) => (String(url).endsWith("/initialize") ? Promise.resolve(new Response("{}", { status: 403 })) : fetch(url, init))) as unknown as typeof fetch });
    expect(await execute(refusing, ref())).toMatchObject({ retryable: false, detail: "X refused the video upload; this connection or app may not have media access" });
  });
});

describe("Bluesky", () => {
  const p = createBlueskyPlugin({ ...o, baseUrl: bsky.url, videoServiceUrl: bsky.url });
  const app = { username: "ana.bsky.social", password: "abcd-efgh-ijkl-mnop" };
  test("asks for an upload token for its own server, uploads to the video service, waits, then embeds the video", async () => {
    bsky.processing.push("JOB_STATE_ENCODING");
    expect(await execute(p, ref(), undefined, { credential: app })).toMatchObject({ kind: "sent", url: expect.stringContaining("https://bsky.app/profile/did:plc:ana/post/") });
    const auth = bsky.calls.find((c) => c.path.includes("getServiceAuth"))!;
    expect(new URL(`http://x${auth.path}`).searchParams.get("aud")).toBe("did:web:pds.example");
    const upload = bsky.calls.find((c) => c.path.includes("uploadVideo"))!;
    expect(upload).toMatchObject({ bytes: file.length, auth: "Bearer service-token" });
    const record = JSON.parse(bsky.calls.at(-1)!.body).record;
    expect(record.embed).toEqual({ $type: "app.bsky.embed.video", video: bsky.blob });
  });
  test("other bytes stop the upload; a failed job waits for a person; neither posts", async () => {
    swapped();
    expect(await execute(p, ref(), undefined, { credential: app })).toMatchObject({ retryable: false, detail: "the video is not the one approved, so it was not posted" });
    served = file;
    bsky.processing.push("JOB_STATE_FAILED");
    expect(await execute(p, ref(), undefined, { credential: app })).toMatchObject({ retryable: false, detail: "Bluesky could not process the video: unsupported codec" });
    expect(bsky.paths()).not.toContain("/xrpc/com.atproto.repo.createRecord");
  });
});

describe("Facebook Reels", () => {
  const p = createFacebookPlugin({ ...o, baseUrl: fb.url, uploadUrl: `${fb.url}/rupload` });
  test("starts a Reel, uploads the parts with their offsets, then publishes it with the caption", async () => {
    fb.processing.push("in_progress");
    expect(await execute(p, ref(), undefined, { target: "P1" })).toEqual({ kind: "sent", providerRef: "V1", url: "https://www.facebook.com/reel/V1" });
    expect(fb.calls.filter((c) => c.path.startsWith("/rupload/")).map((c) => [c.offset, c.bytes])).toEqual([["0", 8 * MiB], [String(8 * MiB), MiB]]);
    const finish = new URLSearchParams(fb.calls.find((c) => c.body.includes("upload_phase=finish"))!.body);
    expect(Object.fromEntries(finish)).toEqual({ upload_phase: "finish", video_id: "V1", video_state: "PUBLISHED", description: "watch this" });
  });
  test("other bytes stop before publishing; a processing error waits for a person", async () => {
    swapped();
    expect(await execute(p, ref(), undefined, { target: "P1" })).toMatchObject({ retryable: false, detail: "the video is not the one approved, so it was not posted" });
    expect(fb.calls.some((c) => c.body.includes("upload_phase=finish"))).toBe(false);
    served = file;
    fb.processing.push("error");
    expect(await execute(p, ref(), undefined, { target: "P1" })).toMatchObject({ retryable: false, detail: "Facebook could not process the video: Video too long" });
  });
  test("still processing at the end counts as sent, since Facebook publishes it by itself", async () => {
    fb.processing.push(...Array<string>(100).fill("in_progress"));
    expect(await execute(p, ref(), undefined, { target: "P1" })).toMatchObject({ kind: "sent", providerRef: "V1" });
  });
});

describe("Threads", () => {
  const p = createThreadsPlugin({ ...o, baseUrl: th.url, wait: async () => undefined });
  test("makes a video container from the link, waits until Threads has the file, then publishes", async () => {
    th.processing.push("IN_PROGRESS");
    const r = ref();
    expect(await execute(p, r)).toEqual({ kind: "sent", providerRef: "m1", url: "https://www.threads.com/@ana/post/abc" });
    expect(th.calls[0]!.form).toMatchObject({ media_type: "VIDEO", video_url: linkOf(r).url, text: "watch this" });
    expect(th.fetched).toEqual([file.length]);
    expect(th.paths()).toEqual(["/v1.0/me/threads", "/c1", "/c1", "/v1.0/me/threads_publish", "/m1"]);
  });
  test("a container Threads can't process waits for a person; one still working at the end is retried", async () => {
    th.processing.push("ERROR");
    expect(await execute(p, ref())).toMatchObject({ retryable: false, detail: "Threads could not process the video: Video duration too long" });
    th.processing.push(...Array<string>(100).fill("IN_PROGRESS"));
    expect(await execute(p, ref())).toMatchObject({ retryable: true, detail: "Threads was still processing the video" });
    expect(th.paths()).not.toContain("/v1.0/me/threads_publish");
  });
  test("MOV is taken here, up to 1 GB", async () => {
    await expect(prepare(p, [ref({ contentType: "video/quicktime" })])).resolves.toBeTruthy();
    await expect(prepare(p, [ref({ bytes: 1_100_000_000 })])).rejects.toThrow("Threads takes MP4 or MOV up to 1000 MB; this file is 1100 MB");
  });
  test("a video post with no link from the host is held", async () => {
    expect(await execute(p, ref(), {})).toMatchObject({ retryable: false, detail: "the approved video was not handed to this post" });
    expect(th.calls).toEqual([]);
  });
});
