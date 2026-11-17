// SPDX-License-Identifier: AGPL-3.0-only
import { afterEach, expect, test, vi } from "vitest";
import { createElement, type ReactElement } from "react";
import { createMemoryHistory, createRootRoute, createRouter, RouterContextProvider } from "@tanstack/react-router";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { Link } from "@astryxdesign/core/Link";
import { AstryxSpike } from "../dev/Astryx";
import { AstryxProvider, RouterLink } from "./astryx";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

function withRouter(ui: ReactElement) {
  const router = createRouter({ routeTree: createRootRoute(), history: createMemoryHistory() });
  const navigate = vi.spyOn(router, "navigate").mockResolvedValue(undefined);
  render(createElement(RouterContextProvider, { router, children: ui }));
  return navigate;
}

test("a plain click on a same-site link moves through the router, search params and all", () => {
  const navigate = withRouter(<RouterLink href="/w/1/review?item=7">Review</RouterLink>);
  const link = screen.getByRole("link", { name: "Review" });
  expect(fireEvent.click(link)).toBe(false);
  expect(navigate).toHaveBeenCalledWith({ href: "/w/1/review?item=7" });
});

test.each([
  ["a modifier click", <RouterLink key="m" href="/w/1">Go</RouterLink>, { ctrlKey: true }],
  ["a middle click", <RouterLink key="b" href="/w/1">Go</RouterLink>, { button: 1 }],
  ["a link with a target", <RouterLink key="t" href="/w/1" target="_blank">Go</RouterLink>, {}],
  ["another site", <RouterLink key="e" href="https://trydirex.com">Go</RouterLink>, {}],
  ["a mailto link", <RouterLink key="x" href="mailto:sam@example.com">Go</RouterLink>, {}],
])("%s stays a browser link", (_, ui, init) => {
  const navigate = withRouter(ui);
  expect(fireEvent.click(screen.getByRole("link", { name: "Go" }), init)).toBe(true);
  expect(navigate).not.toHaveBeenCalled();
});

test("Astryx's own Link renders through the router adapter", () => {
  const navigate = withRouter(<AstryxProvider><Link href="/w/1/plan">Plan</Link></AstryxProvider>);
  fireEvent.click(screen.getByRole("link", { name: "Plan" }));
  expect(navigate).toHaveBeenCalledWith({ href: "/w/1/plan" });
});

test("the token page's Astryx spike renders its buttons and reports a click", () => {
  withRouter(<AstryxProvider><AstryxSpike /></AstryxProvider>);
  fireEvent.click(screen.getByRole("button", { name: "Approve and send" }));
  expect(screen.getByText("Last picked: Approve")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Open dialog" }));
  expect(screen.getByText("Skip this email?")).toBeTruthy();
});
