// SPDX-License-Identifier: AGPL-3.0-only
// A video player seeks with Range headers; a single range is served, anything else gets the whole file.
import { expect, test } from "vitest";
import { byteRange } from "./domain/range";

test("one range in each of its three forms", () => {
  expect(byteRange("bytes=0-99", 1000)).toEqual({ start: 0, end: 99 });
  expect(byteRange("bytes=900-", 1000)).toEqual({ start: 900, end: 999 });
  expect(byteRange("bytes=-100", 1000)).toEqual({ start: 900, end: 999 });
  expect(byteRange("bytes=990-5000", 1000)).toEqual({ start: 990, end: 999 });
});

test("no header, several ranges or a malformed one mean the whole file", () => {
  expect(byteRange(undefined, 1000)).toBeNull();
  expect(byteRange("bytes=0-1,5-6", 1000)).toBeNull();
  expect(byteRange("items=0-1", 1000)).toBeNull();
  expect(byteRange("bytes=5-1", 1000)).toBeNull();
});

test("a range past the end can't be served", () => {
  expect(byteRange("bytes=1000-", 1000)).toBe("unsatisfiable");
  expect(byteRange("bytes=-0", 1000)).toBe("unsatisfiable");
});
