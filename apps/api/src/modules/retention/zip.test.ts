// SPDX-License-Identifier: AGPL-3.0-only
// The ZIP writer: deflated batches, stored files and empty entries read back whole, and the ZIP64
// records take over once sizes and offsets pass the limit (lowered here so the test stays small).
import { expect, test } from "vitest";
import { unzip } from "./fixtures/unzip";
import { createZip } from "./adapters/zip";

async function write(limit?: number) {
  const parts: Uint8Array[] = [];
  const zip = createZip(async (b) => void parts.push(Buffer.from(b)), new Date("2026-11-16T12:00:00Z"), limit);
  const e = zip.entry("tables/items.jsonl", true);
  for (let i = 0; i < 3; i++) await e.write(Buffer.from(`{"n":${i},"title":"${"ä".repeat(2000)}"}\n`));
  await e.end();
  await zip.file("media/clip.mp4", Buffer.from([0, 1, 2, 3, 255]), false);
  await zip.file("tables/empty.jsonl", new Uint8Array(0));
  const bytes = await zip.end();
  const all = Buffer.concat(parts);
  expect(all.length).toBe(bytes);
  return all;
}

const expected = new Map([
  ["tables/items.jsonl", [0, 1, 2].map((n) => `{"n":${n},"title":"${"ä".repeat(2000)}"}\n`).join("")],
  ["media/clip.mp4", Buffer.from([0, 1, 2, 3, 255]).toString("latin1")],
  ["tables/empty.jsonl", ""],
]);
const read = (zip: Buffer) => new Map([...unzip(zip)].map(([name, body]) => [name, name.endsWith(".mp4") ? body.toString("latin1") : body.toString("utf8")]));

test("every entry reads back whole, with its CRC, and the JSON is deflated", async () => {
  const zip = await write();
  expect(read(zip)).toEqual(expected);
  // Deflated: the repeated text takes less room than it would stored.
  expect(zip.length).toBeLessThan(Buffer.byteLength(expected.get("tables/items.jsonl")!) / 10);
  // No ZIP64 end record below the limit.
  expect(zip.includes(Buffer.from([0x50, 0x4b, 0x06, 0x06]))).toBe(false);
});

test("past the limit, sizes, offsets and the end record move to ZIP64", async () => {
  const zip = await write(40);
  expect(zip.includes(Buffer.from([0x50, 0x4b, 0x06, 0x06]))).toBe(true);
  expect(read(zip)).toEqual(expected);
});
