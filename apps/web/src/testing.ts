// SPDX-License-Identifier: AGPL-3.0-only
// For tests: wraps a screen in a fresh query client, a bare router and the Astryx theme, so screens that load through
// TanStack Query render with the `initial` data a test passes in, their Links render as links, and
// their toasts show.
import { createElement, type ReactElement } from "react";
import { fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClientProvider } from "@tanstack/react-query";
import { createMemoryHistory, createRootRoute, createRouter, RouterContextProvider } from "@tanstack/react-router";
import { makeQueryClient } from "./api/query";
import { Toaster } from "@/components/toast";
import { AstryxProvider } from "./components/astryx";
import { loadFields, provideFields } from "./components/laterSource";
import * as laterFields from "./components/laterFields";

/** `path` is the address the screen is shown at, for screens that read it. */
export function withQueries(screen: ReactElement, path = "/") {
  const client = makeQueryClient();
  // Keep the app's other defaults (how long a read stays fresh), only not retrying.
  client.setDefaultOptions({ ...client.getDefaultOptions(), queries: { ...client.getDefaultOptions().queries, retry: false } });
  const router = createRouter({ routeTree: createRootRoute(), history: createMemoryHistory({ initialEntries: [path] }) });
  return createElement(QueryClientProvider, { client }, createElement(RouterContextProvider, { router, children: createElement(AstryxProvider, null, createElement(Toaster, null, screen)) }));
}

/** The opening tags of the buttons whose visible text is `name`, in rendered HTML. */
export function buttons(html: string, name: string): string[] {
  return [...html.matchAll(/<button\b[^>]*>[\s\S]*?<\/button>/g)]
    .filter((m) => m[0].replace(/<[^>]+>/g, "").trim() === name)
    .map((m) => m[0].slice(0, m[0].indexOf(">") + 1));
}

/** HTML without its buttons, for checks about the rest of a page. */
export const withoutButtons = (html: string) => html.replace(/<button\b[\s\S]*?<\/button>/g, "");

/** The one live status region in `root` that is not a Button's own loading announcement. */
export function ownStatus(root: ParentNode = document.body): HTMLElement {
  const found = Array.from(root.querySelectorAll<HTMLElement>('[role="status"]')).filter((s) => !s.closest("button"));
  if (found.length !== 1) throw new Error(`expected one status region, found ${found.length}`);
  return found[0]!;
}

/** The open dialog (with this name), or null. A closed <dialog> stays in the page: the browser hides it,
    happy-dom does not, so a role query alone still finds it. */
export function openDialog(name?: string): HTMLElement | null {
  return screen.queryAllByRole("dialog", name ? { name } : {}).find((d) => !(d instanceof HTMLDialogElement) || d.open) ?? null;
}

/** The list or menu a trigger opens. Astryx keeps every Selector's list and menu in the page and hides
    closed ones with the Popover API, which happy-dom lacks, so look inside the one this trigger opens. */
export function listFor(trigger: HTMLElement) {
  const list = document.getElementById(trigger.getAttribute("aria-controls") ?? "") ?? (trigger.id ? document.querySelector<HTMLElement>(`[aria-labelledby="${trigger.id}"]`) : null);
  if (!list) throw new Error("the trigger opens no list");
  return within(list);
}

/** Opens a Selector or menu and picks the option or item with this name. Astryx picks on a press it
    hit-tests, which happy-dom can't lay out for userEvent.click, so it gets the press as plain events (a
    real browser takes the click; that is checked there). */
export async function pick(trigger: HTMLElement, name: string, role: "option" | "menuitem" = "option") {
  await userEvent.click(trigger);
  const option = await listFor(trigger).findByRole(role, { name });
  fireEvent.pointerDown(option);
  fireEvent.pointerUp(option);
  fireEvent.click(option);
}

/** Sets an Astryx date-and-time field, named `label`, to `iso` ("YYYY-MM-DDTHH:MM"): it is two typed
    fields, the date and "<label> time", each read when it loses focus. */
export async function setDateTime(label: string, iso: string) {
  const [date, time] = iso.split("T") as [string, string];
  for (const [field, text] of [[screen.getByLabelText(label), date], [screen.getByLabelText(`${label} time`), time]] as const) {
    await userEvent.clear(field);
    await userEvent.type(field, text);
    await userEvent.tab();
  }
}

/** Picks the option a person sees as `option` in the select named `label` (an Astryx Selector, whose
    trigger is a combobox). Says which options there are when it isn't one. */
export async function choose(label: string | RegExp, option: string, root: Pick<typeof screen, "findByRole"> = screen) {
  const trigger = await root.findByRole("combobox", { name: label });
  await userEvent.click(trigger);
  const list = listFor(trigger);
  const names = list.queryAllByRole("option").map((o) => o.textContent?.trim());
  if (!names.includes(option)) throw new Error(`no option "${option}" in ${String(label)}: ${names.join(", ")}`);
  await userEvent.click(trigger);
  await pick(trigger, option);
}

/** Each select's options (and how many groups they fall in) by its name, from `el` rendered in the DOM.
    A closed Astryx Selector puts only its choice in server-rendered HTML, so a smoke test that asks what
    a page offers renders it here. Its file needs `// @vitest-environment happy-dom`. */
export function selectOptions(el: ReactElement): Record<string, { options: string[]; groups: number }> {
  const { unmount } = render(el);
  try {
    return Object.fromEntries(
      screen.queryAllByRole("combobox").flatMap((t) => {
        const id = t.getAttribute("aria-controls");
        const list = id ? document.getElementById(id) : null;
        if (!list) return [];
        const name = t.getAttribute("aria-label") ?? (t.id ? document.querySelector(`label[for="${t.id}"]`)?.textContent?.trim() : undefined) ?? "";
        return [[name, { options: Array.from(list.querySelectorAll('[role="option"]')).map((o) => o.textContent?.trim() ?? ""), groups: list.querySelectorAll('[role="group"]').length }]];
      }),
    );
  } finally {
    unmount();
  }
}

/** Loads the fields Input.tsx loads on first use, from a static import, for tests that render and look at once. */
export function loadLaterFields() {
  provideFields(async () => laterFields);
  return loadFields();
}
