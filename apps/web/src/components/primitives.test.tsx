// SPDX-License-Identifier: AGPL-3.0-only
// The shadcn/ui primitives, restyled to Direx tokens: each opens, closes on Escape, returns focus,
// and passes axe. Colour contrast is checked against the tokens in styles.test.tsx, since happy-dom
// computes no styles.
import { afterEach, expect, test } from "vitest";
import { useState } from "react";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import axe from "axe-core";
import { Field, Page } from "./layout";
import { Button } from "@/components/Button";
import { Confirm } from "./Confirm";
import { DropdownMenu } from "@astryxdesign/core/DropdownMenu";
import { Input, Textarea } from "@/components/Input";
import { Popover } from "@astryxdesign/core/Popover";
import { Selector } from "@astryxdesign/core/Selector";
import { Skeleton } from "@astryxdesign/core/Skeleton";
import { Table, TableBody, TableCell, TableFooter, TableHeader, TableHeaderCell, TableRow } from "@astryxdesign/core/Table";
import { Tab, TabList } from "@astryxdesign/core/TabList";
import { Toaster, toast } from "@/components/toast";
import { listFor, openDialog, pick } from "../testing";

afterEach(cleanup);

/** Serious and critical WCAG A and AA violations, 2.0 to 2.2. */
async function violations(node: Element = document.body) {
  // Base UI's focus guards are hidden tabindex=0 sentinels that send focus straight back into the
  // popup, so axe's aria-hidden-focus misreads them.
  const r = await axe.run({ include: [node], exclude: ["[data-base-ui-focus-guard]"] }, {
    runOnly: { type: "tag", values: ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22a", "wcag22aa"] },
    rules: { "color-contrast": { enabled: false } },
  });
  return r.violations.filter((v) => v.impact === "serious" || v.impact === "critical").map((v) => `${v.id}: ${v.nodes.map((n) => n.html).join(" | ")}`);
}

test("Dialog: opens from its trigger, takes focus, closes on Escape and gives focus back", async () => {
  const user = userEvent.setup();
  render(<Confirm trigger={<Button>Approve all with no warnings</Button>} title="Approve 12 with no warnings?" body="Anything with a warning is left for you." confirm="Approve 12" onConfirm={() => undefined} />);
  const trigger = screen.getByRole("button", { name: "Approve all with no warnings" });
  await user.click(trigger);
  const dialog = await screen.findByRole("dialog", { name: "Approve 12 with no warnings?" });
  await waitFor(() => expect(dialog.contains(document.activeElement)).toBe(true));
  expect(await violations()).toEqual([]);

  await user.keyboard("{Escape}");
  await waitFor(() => expect(openDialog()).toBeNull());
  expect(document.activeElement).toBe(trigger);
});

test("Dialog: Cancel closes it", async () => {
  const user = userEvent.setup();
  render(<Confirm trigger={<Button>Pause all sending</Button>} title="Pause all sending?" confirm="Pause" onConfirm={() => undefined} />);
  await user.click(screen.getByRole("button", { name: "Pause all sending" }));
  await user.click(await screen.findByRole("button", { name: "Cancel" }));
  await waitFor(() => expect(openDialog()).toBeNull());
});

test("DropdownMenu: opens by keyboard, picks an item, and Escape gives focus back", async () => {
  const user = userEvent.setup();
  const picked: string[] = [];
  render(
    <DropdownMenu
      button={{ label: "Workspace", variant: "secondary" }}
      items={[
        { type: "section", title: "Workspaces", items: [
          { id: "contoso", label: "Contoso", onClick: () => picked.push("Contoso") },
          { id: "direx", label: "Direx", onClick: () => picked.push("Direx") },
        ] },
        { type: "divider" },
        { id: "new", label: "New organization" },
      ]}
    />,
  );
  const trigger = screen.getByRole("button", { name: "Workspace" });
  trigger.focus();
  await user.keyboard("{Enter}");
  const menu = listFor(trigger);
  expect(await menu.findByRole("menuitem", { name: "Direx" })).toBeTruthy();
  expect(trigger.getAttribute("aria-expanded")).toBe("true");
  expect(await violations()).toEqual([]);
  await user.keyboard("{Escape}");
  await waitFor(() => expect(trigger.getAttribute("aria-expanded")).not.toBe("true"));
  expect(document.activeElement).toBe(trigger);

  await pick(trigger, "Direx", "menuitem");
  expect(picked).toEqual(["Direx"]);
});

test("Popover: opens, closes on Escape, gives focus back", async () => {
  const user = userEvent.setup();
  render(
    <Popover label="Why this draft" content={<p>Cites Fact: pricing, version 3.</p>}>
      <Button variant="ghost">Why</Button>
    </Popover>,
  );
  const trigger = screen.getByRole("button", { name: "Why" });
  await user.click(trigger);
  expect(await screen.findByText("Cites Fact: pricing, version 3.")).toBeTruthy();
  expect(trigger.getAttribute("aria-expanded")).toBe("true");
  expect(await violations()).toEqual([]);
  await user.keyboard("{Escape}");
  await waitFor(() => expect(trigger.getAttribute("aria-expanded")).not.toBe("true"));
  expect(document.activeElement).toBe(trigger);
});

test("Select: opens, picks an option, shows it", async () => {
  const items = [
    { label: "Week", value: "week" },
    { label: "Month", value: "month" },
  ];
  function View() {
    const [v, setV] = useState("week");
    return <Selector label="Calendar view" isLabelHidden options={items} value={v} onChange={setV} />;
  }
  render(<View />);
  const trigger = screen.getByRole("combobox", { name: "Calendar view" });
  expect(trigger.textContent).toContain("Week");
  await pick(trigger, "Month");
  await waitFor(() => expect(trigger.textContent).toContain("Month"));
  expect(await violations()).toEqual([]);
});

test("Tabs: arrow keys move between tabs and show the panel", async () => {
  const user = userEvent.setup();
  function Steps() {
    const [tab, setTab] = useState("plan");
    return (
      <>
        <TabList role="tablist" value={tab} onChange={setTab}>
          <Tab value="plan" label="Plan" panelId="step-plan" />
          <Tab value="drafts" label="Drafts" panelId="step-drafts" />
        </TabList>
        <div role="tabpanel" id="step-plan" aria-label="Plan" hidden={tab !== "plan"}>The plan</div>
        <div role="tabpanel" id="step-drafts" aria-label="Drafts" hidden={tab !== "drafts"}>The drafts</div>
      </>
    );
  }
  render(<Steps />);
  screen.getByRole("tab", { name: "Plan" }).focus();
  await user.keyboard("{ArrowRight}{Enter}");
  await waitFor(() => expect(screen.getByRole("tab", { name: "Drafts" }).getAttribute("aria-selected")).toBe("true"));
  expect(screen.getByRole("tabpanel").textContent).toBe("The drafts");
  expect(await violations()).toEqual([]);
});

test("Toast: a message shows as a status and can be closed", async () => {
  const user = userEvent.setup();
  render(<Toaster />);
  act(() => {
    toast.add({ title: "Approved", description: "Sends Tue 9:00" });
  });
  expect(await screen.findByText("Sends Tue 9:00")).toBeTruthy();
  expect(await violations()).toEqual([]);
  await user.click(screen.getByRole("button", { name: "Dismiss notification" }));
  await waitFor(() => expect(screen.queryByText("Sends Tue 9:00")).toBeNull());
});

test("form fields, table and skeleton render with labels and pass axe", async () => {
  render(
    <main>
      <Field label="Subject">
        <Input defaultValue="Q4 ops" />
      </Field>
      <Field label="Note">
        <Textarea defaultValue="Hold until Monday" />
      </Field>
      <Table aria-label="This week">
        <TableHeader>
          <TableRow>
            <TableHeaderCell>Item</TableHeaderCell>
            <TableHeaderCell>State</TableHeaderCell>
          </TableRow>
        </TableHeader>
        <TableBody>
          <TableRow>
            <TableCell>Q4 ops email</TableCell>
            <TableCell>Scheduled</TableCell>
          </TableRow>
        </TableBody>
        <TableFooter>
          <TableRow>
            <TableCell colSpan={2}>1 Item</TableCell>
          </TableRow>
        </TableFooter>
      </Table>
      <Skeleton aria-hidden className="h-6 w-40" />
      <Button size="sm" variant="secondary">
        Skip
      </Button>
      <Button size="icon" aria-label="More">
        …
      </Button>
      <Button variant="destructive">Pause all sending</Button>
    </main>,
  );
  expect(screen.getByRole("table", { name: "This week" })).toBeTruthy();
  expect(screen.getByLabelText("Subject")).toBeTruthy();
  expect(await violations()).toEqual([]);
});

test("an embedded page is a section with a second-level title, so the screen keeps one main and one h1", () => {
  render(
    <Page title="Q4 ops">
      <Page title="The plan" embedded>
        <p>Steps</p>
      </Page>
    </Page>,
  );
  expect(document.querySelectorAll("main")).toHaveLength(1);
  expect(screen.getAllByRole("heading", { level: 1 }).map((h) => h.textContent)).toEqual(["Q4 ops"]);
  expect(screen.getByRole("heading", { level: 2, name: "The plan" })).toBeTruthy();
});

test("focus is the 2px outline from DESIGN.md, not a soft ring", () => {
  render(
    <>
      <Button>Save</Button>
      <Input aria-label="Subject" />
    </>,
  );
  // Both are Astryx's: the field's control box and the Button read --focus-outline-color and
  // --focus-outline-offset, which astryx.css sets to --ring and --ring-offset (the mapping test in
  // styles.test.tsx checks it). The Button is Astryx's, whose outline reads --focus-outline-color and --focus-outline-offset; astryx.css
  // sets those to --ring and --ring-offset (checked by the mapping test in styles.test.tsx).
  expect(screen.getByRole("button", { name: "Save" }).className).toContain("astryx-button");
  const input = screen.getByRole("textbox", { name: "Subject" });
  expect(input.closest("[data-pressable-container]")).toBeTruthy();
  expect(input.className).not.toMatch(/focus-visible:ring-(3|\[3px\]|ring\/50)/);
});
