// SPDX-License-Identifier: AGPL-3.0-only
import { expect, test } from "vitest";
import { buttonVariants } from "@/components/native";
import { cn } from "./cn";

test("an outline Link styled with buttonVariants keeps its visible border", () => {
  const classes = buttonVariants({ variant: "outline" }).split(" ");
  expect(classes).toContain("border-input");
  expect(classes).not.toContain("border-transparent");
});

test("our radius tokens replace a component's radius instead of sitting beside it", () => {
  expect(cn("rounded-full px-4", "rounded-card")).toBe("px-4 rounded-card");
  expect(cn("rounded-full", "rounded-card")).toBe("rounded-card");
  expect(cn("rounded-card", "rounded-full")).toBe("rounded-full");
});
