// SPDX-License-Identifier: AGPL-3.0-only
// The first bytes of an upload decide its type; the header a browser sends is not trusted.
import { expect, test } from "vitest";
import { SNIFF_BYTES, sniff } from "./domain/sniff";

const ftyp = (brand: string) => new Uint8Array([0, 0, 0, 0x20, ...new TextEncoder().encode(`ftyp${brand}`), 0, 0, 0, 0]);

test("MP4, MOV and WebM are told apart by their first bytes", () => {
  expect(sniff(ftyp("isom"))).toEqual({ ok: true, contentType: "video/mp4" });
  expect(sniff(ftyp("mp42"))).toEqual({ ok: true, contentType: "video/mp4" });
  expect(sniff(ftyp("qt  "))).toEqual({ ok: true, contentType: "video/quicktime" });
  expect(sniff(new Uint8Array([0x1a, 0x45, 0xdf, 0xa3, 0x9f, 0x42, 0x86, 0x81, 1, 0x42, 0xf7, 0x81]))).toEqual({ ok: true, contentType: "video/webm" });
});

test("PNG, JPEG, GIF and WebP images are told apart by their first bytes too", () => {
  const bytes = (s: string, ...head: number[]) => new Uint8Array([...head, ...new TextEncoder().encode(s)]).slice(0, 12);
  expect(sniff(bytes("PNG\r\n\x1a\n\0\0\0\r", 0x89))).toEqual({ ok: true, contentType: "image/png" });
  expect(sniff(new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 0x10, 0x4a, 0x46, 0x49, 0x46, 0, 1]))).toEqual({ ok: true, contentType: "image/jpeg" });
  expect(sniff(bytes("GIF89a\x01\0\x01\0\0\0"))).toEqual({ ok: true, contentType: "image/gif" });
  expect(sniff(bytes("RIFF\x10\0\0\0WEBP"))).toEqual({ ok: true, contentType: "image/webp" });
});

test("anything else is not supported, however short", () => {
  expect(sniff(new TextEncoder().encode("%PDF-1.7\n%abc"))).toEqual({ ok: false, reason: "not_supported" });
  // SVG can carry script, so it is never an image here.
  expect(sniff(new TextEncoder().encode("<svg xmlns='http://www.w3.org/2000/svg'/>"))).toEqual({ ok: false, reason: "not_supported" });
  expect(sniff(new Uint8Array())).toEqual({ ok: false, reason: "not_supported" });
  expect(sniff(ftyp("isom").slice(0, 11))).toEqual({ ok: false, reason: "not_supported" });
  expect(SNIFF_BYTES).toBe(12);
});
