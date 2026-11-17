// SPDX-License-Identifier: AGPL-3.0-only
// For the web tests only. happy-dom opens a <dialog> with showModal() but, unlike a browser, does not
// run the dialog focusing steps, so focus would stay outside an Astryx Dialog or Drawer. This runs them:
// the first autofocus element, else the first focusable one, else the dialog itself.
import { loadLaterFields } from "./testing";
const FOCUSABLE = 'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';
const showModal = HTMLDialogElement.prototype.showModal;
HTMLDialogElement.prototype.showModal = function (this: HTMLDialogElement) {
  showModal.call(this);
  const target = this.querySelector<HTMLElement>("[autofocus]") ?? this.querySelector<HTMLElement>(FOCUSABLE) ?? this;
  target.focus();
};

// Astryx repeats each toast in a live region so screen readers announce it. Text queries skip that
// copy, so a test finds the toast once, as a person sees it.
import { configure } from "@testing-library/react";
configure({ defaultIgnore: "script, style, [data-astryx-live-region]" });

// Astryx keeps polite and assertive live regions (role status and alert) for its announcements, some
// marked data-astryx-live-region, some (in its fields) only by aria-live while empty. Role queries have
// no ignore option, so tests would find these channels beside the alert a screen shows. They keep
// aria-live; only the role goes, here in tests.
const unrole = (root: ParentNode) =>
  root.querySelectorAll("[data-astryx-live-region][role], [aria-live][role='alert']:empty, [aria-live][role='status']:empty").forEach((e) => e.removeAttribute("role"));
new MutationObserver(() => unrole(document)).observe(document.documentElement, { subtree: true, childList: true, attributes: true, attributeFilter: ["role"] });

// happy-dom runs no CSS transitions, and Astryx finishes a toast's opening and its exit when the row's
// own grid-template-rows transition ends. Each time a toast row's class changes, end that transition at
// once, as a 0 ms one would, so a dismissed or replaced toast really goes.
new MutationObserver((records) => {
  for (const r of records) {
    const row = r.target as HTMLElement;
    if (r.attributeName !== "class" || !row.hasAttribute?.("data-toast-id")) continue;
    queueMicrotask(() => row.dispatchEvent(Object.assign(new Event("transitionend", { bubbles: true }), { propertyName: "grid-template-rows" })));
  }
}).observe(document.documentElement, { subtree: true, attributes: true, attributeFilter: ["class"] });

// The number, date, time and file fields load on first use in the app; tests look at once, so load them now.
await loadLaterFields();
