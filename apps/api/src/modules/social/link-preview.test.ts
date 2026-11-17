// SPDX-License-Identifier: AGPL-3.0-only
import { expect, test } from "vitest";
import { firstLink, imageType, mustRead, previewOf, RETRY_MS } from "./domain/link-preview";

test("a post's first link is found without the punctuation after it", () => {
  expect(firstLink("Read it here: https://acme.test/q4-ops. Thoughts?")).toBe("https://acme.test/q4-ops");
  expect(firstLink("(see http://acme.test/a?b=1)")).toBe("http://acme.test/a?b=1");
  expect(firstLink("No link, just words.")).toBeNull();
});

test("a page's card reads Open Graph first, then Twitter, then the plain title and description", () => {
  const og = `<html><head><title>Plain</title><meta content="Q4 ops &amp; you" property="og:title"><meta property='og:description' content='Three things.'><meta property="og:site_name" content="Acme Blog"></head></html>`;
  expect(previewOf(og, "https://www.acme.test/q4")).toEqual({ title: "Q4 ops & you", description: "Three things.", site: "Acme Blog", image: null });
  const plain = `<title> Plain   title </title><meta name="description" content="What it says">`;
  expect(previewOf(plain, "https://www.acme.test/q4")).toEqual({ title: "Plain title", description: "What it says", site: "acme.test", image: null });
  expect(previewOf("", "https://acme.test/")).toEqual({ title: null, description: null, site: "acme.test", image: null });
  expect(previewOf(`<meta property="og:description" content="${"x".repeat(400)}">`, "https://acme.test/").description).toHaveLength(300);
});

test("a page is read for a new link, and a failed one again only after a day", () => {
  const now = new Date("2026-11-10T12:00:00Z");
  const card = { title: "T", description: null, site: "acme.test", image: null };
  const url = "https://acme.test/q4";
  expect(mustRead(null, url, now)).toBe(true);
  expect(mustRead({ url: "https://acme.test/old", preview: card }, url, now)).toBe(true);
  expect(mustRead({ url, preview: card, at: "2026-01-01T00:00:00Z" }, url, now)).toBe(false);
  expect(mustRead({ url, preview: null, at: new Date(now.getTime() - RETRY_MS + 1000).toISOString() }, url, now)).toBe(false);
  expect(mustRead({ url, preview: null, at: new Date(now.getTime() - RETRY_MS - 1000).toISOString() }, url, now)).toBe(true);
  // Kept before the time was stored: tried again.
  expect(mustRead({ url, preview: null }, url, now)).toBe(true);
});

test("a page's image is its Open Graph or Twitter image, made absolute; only http and https", () => {
  expect(previewOf(`<meta property="og:image" content="/img/q4.png?a=1&amp;b=2">`, "https://acme.test/blog/q4").image).toBe("https://acme.test/img/q4.png?a=1&b=2");
  expect(previewOf(`<meta name="twitter:image" content="https://cdn.test/q4.jpg">`, "https://acme.test/").image).toBe("https://cdn.test/q4.jpg");
  expect(previewOf(`<meta property="og:image" content="javascript:alert(1)">`, "https://acme.test/").image).toBeNull();
});

test("an image's type is what its first bytes say, among PNG, JPEG, GIF and WebP", () => {
  expect(imageType(Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d]))).toBe("image/png");
  expect(imageType(Uint8Array.from([0xff, 0xd8, 0xff, 0xe0]))).toBe("image/jpeg");
  expect(imageType(new TextEncoder().encode("GIF89a"))).toBe("image/gif");
  expect(imageType(new TextEncoder().encode("RIFF\0\0\0\0WEBPVP8 "))).toBe("image/webp");
  expect(imageType(new TextEncoder().encode("<svg onload='x()'/>"))).toBeNull();
  expect(imageType(new Uint8Array())).toBeNull();
});
