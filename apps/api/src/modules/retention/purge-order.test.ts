// SPDX-License-Identifier: AGPL-3.0-only
import { expect, test } from "vitest";
import { deletionOrder } from "./domain/purge";

test("children go before their parents; a self reference or a table left out holds nothing up", () => {
  const edges = [
    { child: "public.steps", parent: "public.campaigns" },
    { child: "public.steps", parent: "public.steps" },
    { child: "public.campaigns", parent: "public.plans" },
    { child: "public.approvals", parent: "public.steps" },
  ];
  expect(deletionOrder(["public.plans", "public.campaigns", "public.steps"], edges)).toEqual(["public.steps", "public.campaigns", "public.plans"]);
});

test("a cycle between tables throws, naming them", () => {
  const edges = [
    { child: "public.a", parent: "public.b" },
    { child: "public.b", parent: "public.a" },
  ];
  expect(() => deletionOrder(["public.a", "public.b", "public.c"], edges)).toThrow("purge: the foreign keys between public.a, public.b form a cycle");
});
