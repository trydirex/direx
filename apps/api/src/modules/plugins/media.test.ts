// SPDX-License-Identifier: AGPL-3.0-only
// An effect reads only the files its approved spec names, and only when its manifest grants it.
import { definePlugin, type CallContext, type MediaLink, type MediaRef } from "@direx/plugin-sdk";
import { expect, test } from "vitest";
import { loadPlugins, type MediaLinks } from "./index";

const W = crypto.randomUUID();
const ref = (n: number): MediaRef => ({ mediaId: crypto.randomUUID(), sha256: String(n).repeat(64), bytes: 10, contentType: "video/mp4" });
const linkOf = (r: MediaRef): MediaLink => ({ url: `https://files.example/${r.mediaId}`, sha256: r.sha256, bytes: r.bytes, contentType: r.contentType });

const seen: CallContext["media"][] = [];
const effect = (name: string, media?: "read") => ({ kind: "effect", name, connection: "c", dedupe: "blind", risk: "low", reachesPerson: false, ...(media && { media }) });
const handler = { prepare: async () => ({ spec: {}, preview: "" }), execute: async (_s: unknown, ctx: CallContext) => (seen.push(ctx.media), { kind: "sent" as const }) };
const plugin = definePlugin({
  manifest: { id: "com.example.video", apiVersion: 1, version: "1.0.0", minHostVersion: "0.1.0", trust: "first_party", connections: [{ key: "c", auth: "none" }], egress: { hosts: [] }, capabilities: [effect("video.post", "read"), effect("text.post")] },
  effects: { "video.post": handler, "text.post": handler },
});
const load = (mediaLinks?: MediaLinks) => loadPlugins({ sources: [{ mode: "in_process", plugin }], credentials: async () => null, confinement: "none", log: () => {}, ...(mediaLinks && { mediaLinks }) });
const ctx = { workspaceId: W, idempotencyKey: "k" };

test("a granted effect gets a link to each file its spec names, made for its own Workspace", async () => {
  const asked: [string, string][] = [];
  const p = load(async (ws, r) => (asked.push([ws, r.mediaId]), linkOf(r)));
  const a = ref(1);
  const b = ref(2);
  seen.length = 0;
  expect(await p.effects["com.example.video/video.post"]!.execute({ text: "hi", media: [a, b] }, ctx)).toEqual({ kind: "sent" });
  expect(seen).toEqual([{ [a.mediaId]: linkOf(a), [b.mediaId]: linkOf(b) }]);
  expect(asked).toEqual([[W, a.mediaId], [W, b.mediaId]]);
});

test("an effect without the grant, or a spec naming no files, gets no links", async () => {
  let asked = 0;
  const p = load(async (_ws, r) => (asked++, linkOf(r)));
  seen.length = 0;
  await p.effects["com.example.video/text.post"]!.execute({ media: [ref(1)] }, ctx);
  await p.effects["com.example.video/video.post"]!.execute({ text: "hi" }, ctx);
  expect(seen).toEqual([{}, {}]);
  expect(asked).toBe(0);
});

test("a file deleted or changed since approval, a failing store or no links at all holds the post unsent", async () => {
  const spec = { media: [ref(3)] };
  const run = (m?: MediaLinks) => load(m).effects["com.example.video/video.post"]!.execute(spec, ctx);
  seen.length = 0;
  expect(await run(async () => null)).toEqual({ kind: "refused", permanent: false, retryable: false, detail: "the approved file was deleted or changed after approval" });
  expect(await run(async () => Promise.reject(new Error("disk gone")))).toMatchObject({ kind: "refused", retryable: false, detail: "the approved file can't be read: disk gone" });
  expect(await run()).toMatchObject({ kind: "refused", retryable: false, detail: "this host can't hand files to plugins" });
  expect(seen).toEqual([]);
});
