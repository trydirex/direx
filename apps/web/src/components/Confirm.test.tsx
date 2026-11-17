// SPDX-License-Identifier: AGPL-3.0-only
import { afterEach, expect, test, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Confirm } from "./Confirm";
import { Button } from "@/components/Button";
import { openDialog } from "../testing";

afterEach(cleanup);

test("a confirmed action asks first: Cancel does nothing, the confirm button runs it once", async () => {
  const run = vi.fn();
  render(<Confirm title="Remove Sam?" body="They lose access." confirm="Remove" onConfirm={run} trigger={<Button aria-label="Remove Sam">Remove</Button>} />);

  await userEvent.click(screen.getByRole("button", { name: "Remove Sam" }));
  expect(await screen.findByText("They lose access.")).toBeTruthy();
  await userEvent.click(screen.getByRole("button", { name: "Cancel" }));
  await waitFor(() => expect(openDialog()).toBeNull());
  expect(run).not.toHaveBeenCalled();

  await userEvent.click(screen.getByRole("button", { name: "Remove Sam" }));
  await userEvent.click(await screen.findByRole("button", { name: "Remove" }));
  expect(run).toHaveBeenCalledTimes(1);
  await waitFor(() => expect(openDialog()).toBeNull());
});
