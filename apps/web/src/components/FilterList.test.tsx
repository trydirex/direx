// SPDX-License-Identifier: AGPL-3.0-only
import { afterEach, expect, test } from "vitest";
import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ownStatus } from "../testing";
import { FilterList } from "./FilterList";

afterEach(cleanup);

type P = { id: string; email: string; held: boolean };
const people: P[] = Array.from({ length: 250 }, (_, n) => ({ id: `p${n}`, email: `person${n}@acme.test`, held: n < 3 }));
const show = () =>
  render(
    <FilterList noun="People" items={people} id={(x) => x.id} text={(x) => x.email} filters={[{ label: "Held", test: (x) => x.held }]}>
      {(x) => <span>{x.email}</span>}
    </FilterList>,
  );
const rows = () => within(screen.getByRole("list", { name: "People" })).getAllByRole("listitem");

test("a long list counts each filter, shows a page at a time, and filters and searches", async () => {
  show();
  expect(ownStatus().textContent).toBe("250 People");
  expect(screen.getByRole("button", { name: "All 250" }).getAttribute("aria-pressed")).toBe("true");
  expect(rows()).toHaveLength(100);
  await userEvent.click(screen.getByRole("button", { name: "Show 100 more" }));
  await userEvent.click(screen.getByRole("button", { name: "Show 50 more" }));
  expect(rows()).toHaveLength(250);
  expect(screen.queryByRole("button", { name: /^Show/ })).toBeNull();

  await userEvent.click(screen.getByRole("button", { name: "Held 3" }));
  expect(screen.getByRole("button", { name: "Held 3" }).getAttribute("aria-pressed")).toBe("true");
  expect(ownStatus().textContent).toBe("3 of 250 People");
  await userEvent.type(screen.getByRole("searchbox", { name: "Search People" }), "PERSON1@");
  expect(rows().map((r) => r.textContent)).toEqual(["person1@acme.test"]);
  await userEvent.type(screen.getByRole("searchbox", { name: "Search People" }), "x");
  expect(screen.getByText("No People match.")).toBeTruthy();
  // Pressing the active filter again shows everyone.
  await userEvent.click(screen.getByRole("button", { name: "Held 3" }));
  expect(screen.getByRole("button", { name: "All 250" }).getAttribute("aria-pressed")).toBe("true");
});
