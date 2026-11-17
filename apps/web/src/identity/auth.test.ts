// SPDX-License-Identifier: AGPL-3.0-only
import { afterEach, expect, test, vi } from "vitest";
import { signOut } from "./auth";

afterEach(() => vi.unstubAllGlobals());

test("a refused sign-out says so and stays on the page", async () => {
  const assign = vi.fn();
  vi.stubGlobal("location", { assign });
  vi.stubGlobal("fetch", vi.fn(async () => new Response("", { status: 403 })));
  expect(await signOut()).toContain("couldn't sign you out");
  vi.stubGlobal("fetch", vi.fn(async () => Promise.reject(new Error("offline"))));
  expect(await signOut()).toContain("couldn't sign you out");
  expect(assign).not.toHaveBeenCalled();
});

test("a sign-out the server accepts goes to the start page", async () => {
  const assign = vi.fn();
  vi.stubGlobal("location", { assign });
  vi.stubGlobal("fetch", vi.fn(async () => new Response("{}", { status: 200 })));
  expect(await signOut()).toBeNull();
  expect(assign).toHaveBeenCalledWith("/");
});
