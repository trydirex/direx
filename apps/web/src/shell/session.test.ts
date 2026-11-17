// SPDX-License-Identifier: AGPL-3.0-only
import { expect, test, vi } from "vitest";
import { reloadOnRestore } from "./session";

const pageshow = (persisted: boolean) => dispatchEvent(Object.assign(new Event("pageshow"), { persisted }));

test("a page restored on Back loads again, so a signed-out person isn't shown their data", () => {
  const reload = vi.fn();
  reloadOnRestore(reload);
  pageshow(false);
  expect(reload).not.toHaveBeenCalled();
  pageshow(true);
  expect(reload).toHaveBeenCalledOnce();
});
