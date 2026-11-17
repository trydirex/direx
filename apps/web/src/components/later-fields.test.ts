// SPDX-License-Identifier: AGPL-3.0-only
// The number, date, time and file fields load on first use: until then a disabled text field with the
// same label and value stands in, and once loaded the real field renders at once.
import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { expect, test } from "vitest";
import { Input } from "./Input";
import { loadLaterFields } from "../testing";

const page = () => renderToString(createElement("form", null, createElement(Input, { type: "date", label: "On", name: "on", value: "2026-11-10", onChange: () => {} })));

test("a date field shows a disabled stand-in until it has loaded, then the date field itself", async () => {
  const before = page();
  expect(before).toMatch(/<input[^>]*disabled[^>]*value="2026-11-10"|<input[^>]*value="2026-11-10"[^>]*disabled/);
  expect(before).toContain(">On<");
  // FormData still reads the value while the stand-in shows.
  expect(before).toContain('type="hidden" name="on" value="2026-11-10"');
  await loadLaterFields();
  const after = page();
  expect(after).not.toMatch(/<input[^>]*disabled/);
  expect(after).toContain(">On<");
});
