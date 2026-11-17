// SPDX-License-Identifier: AGPL-3.0-only
// Which account posts which clip, and when.
import { expect, test } from "vitest";
import { CLIP_DAYS, spreadClips, type ClipAccount, type SpreadClip } from "./domain/clip-spread";

const FACT = "00000000-0000-4000-8000-0000000000f1";
const at = new Date("2026-11-09T09:00:00Z");
const clip = (n: number): SpreadClip => ({ id: `c${n}`, mediaId: `m${n}`, caption: `Caption ${n}`, citations: n === 1 ? [`${FACT}@3`] : [] });
const li: ClipAccount = { connection: "linkedin", credentialId: "k1", networkId: "n1" };
const x1: ClipAccount = { connection: "x", credentialId: "k2", networkId: "n2" };
const x2: ClipAccount = { connection: "x", credentialId: "k3", networkId: "n3" };
const hours = (d: Date) => (d.getTime() - at.getTime()) / 3_600_000;

test("clips go out best first, round robin, one a day per account, half an hour apart on one network", () => {
  const r = spreadClips([1, 2, 3, 4, 5].map(clip), [li, x1, x2], at);
  expect(r.posts.map((p) => [p.clipId, p.connection, p.networkId, hours(p.at)])).toEqual([
    ["c1", "linkedin", "n1", 0],
    ["c2", "x", "n2", 0],
    ["c3", "x", "n3", 0.5],
    ["c4", "linkedin", "n1", 24],
    ["c5", "x", "n2", 24],
  ]);
  expect(r.posts[0]).toMatchObject({ mediaId: "m1", text: "Caption 1", credentialId: "k1", citations: [{ factId: FACT, version: 3 }] });
  expect(new Set(r.posts.map((p) => p.clipId)).size).toBe(5);
  expect(r).toMatchObject({ unposted: [], idle: [] });
});

test("clips past the last day are unposted, accounts past the last clip are idle, and no accounts posts nothing", () => {
  const many = Array.from({ length: CLIP_DAYS + 2 }, (_, i) => clip(i + 1));
  const r = spreadClips(many, [li], at);
  expect(r.posts).toHaveLength(CLIP_DAYS);
  expect(hours(r.posts.at(-1)!.at)).toBe((CLIP_DAYS - 1) * 24);
  expect(r.unposted).toEqual([`c${CLIP_DAYS + 1}`, `c${CLIP_DAYS + 2}`]);
  expect(spreadClips([clip(1)], [li, x1, x2], at)).toMatchObject({ posts: [{ clipId: "c1" }], idle: [x1, x2] });
  expect(spreadClips([clip(1), clip(2)], [], at)).toEqual({ posts: [], unposted: ["c1", "c2"], idle: [] });
});

test("a second recording skips the days its accounts already post on, and what has no free day is unposted", () => {
  const first = spreadClips([1, 2, 3].map(clip), [li], at).posts;
  const later = new Date(at.getTime() + 24 * 3_600_000);
  const r = spreadClips([6, 7, 8, 9, 10].map(clip), [li, x1], later, first);
  expect(r.posts.map((p) => [p.clipId, p.connection, hours(p.at)])).toEqual([
    ["c6", "x", 24],
    ["c7", "x", 48],
    ["c8", "linkedin", 72],
    ["c9", "x", 72],
    ["c10", "linkedin", 96],
  ]);
  for (const p of [...first, ...r.posts].filter((p) => p.connection === "linkedin")) {
    expect([...first, ...r.posts].filter((q) => q !== p && q.connection === "linkedin" && Math.abs(q.at.getTime() - p.at.getTime()) < 86_400_000)).toEqual([]);
  }
  const full = spreadClips(Array.from({ length: CLIP_DAYS }, (_, i) => clip(i + 1)), [li], at).posts;
  expect(spreadClips([clip(20)], [li], at, full)).toEqual({ posts: [], unposted: ["c20"], idle: [li] });
});
