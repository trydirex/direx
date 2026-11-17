// SPDX-License-Identifier: AGPL-3.0-only
import { expect, test } from "vitest";
import { render, screen } from "@testing-library/react";
import { Button, textOf } from "./Button";

test("a button is named by its text, not by a key hint a screen reader skips", () => {
  expect(textOf(["Approve", " ", <kbd key="k" aria-hidden>A</kbd>])).toBe("Approve");
  render(<Button pending>Save email</Button>);
  const b = screen.getByRole("button", { name: "Save email" });
  expect(b.getAttribute("aria-busy")).toBe("true");
});
