// SPDX-License-Identifier: AGPL-3.0-only
// The shell's "Confirm it's you" (ADR 0037 rule 005): a step_up_required answer opens the sign-in over
// the page, any other code passes through, and nothing is re-run.
import { act } from "react";
import { afterEach, expect, test, vi } from "vitest";
import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { api } from "../client";
import { withQueries } from "../testing";
import { Lessons } from "../lessons/Lessons";
import { ConfirmIdentity } from "./ConfirmIdentity";
import { confirmOnStepUp } from "../api/messages";

const W = "00000000-0000-4000-8000-0000000000aa";
const reply = (status: number, body: unknown) => Promise.resolve({ ...(status < 400 ? { data: body } : { error: body }), response: new Response(null, { status }) });
const lesson = { id: "00000000-0000-4000-8000-0000000000bb", agent: "recipient_writer", version: 1, text: "First emails here run under 90 words.", createdAt: "2026-11-07T00:00:00.000Z", origin: { itemId: null, sourceRef: null, proposedBy: null } };
const dialog = () => screen.queryByRole("dialog", { name: "Confirm it's you" });

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

test("a code passes through unchanged, and only step_up_required opens the sign-in", async () => {
  expect(confirmOnStepUp("step_up_required")).toBe("step_up_required");
  vi.spyOn(api, "GET").mockImplementation((() => reply(200, { google: false, microsoft: false, firstRun: null })) as never);
  render(withQueries(<ConfirmIdentity />));
  const passed: (string | null)[] = [];
  act(() => void passed.push(confirmOnStepUp(null), confirmOnStepUp("forbidden")));
  expect(passed).toEqual([null, "forbidden"]);
  expect(dialog()).toBeNull();
  act(() => void confirmOnStepUp("step_up_required"));
  expect(await screen.findByRole("dialog", { name: "Confirm it's you" })).toBeTruthy();
  expect(screen.getByText("This needs a recent sign-in. Sign in again, then try once more.")).toBeTruthy();
  await userEvent.keyboard("{Escape}");
  expect(dialog()).toBeNull();
});

test("a lesson refused for step-up opens the sign-in over the page and is sent once", async () => {
  vi.spyOn(api, "GET").mockImplementation(((path: string) => reply(200, path.endsWith("/lessons") ? { lessons: [lesson] } : { google: false, microsoft: false, firstRun: null })) as never);
  const post = vi.spyOn(api, "POST").mockImplementation((() => reply(403, { error: "step_up_required" })) as never);
  render(withQueries(<><Lessons workspaceId={W} role="owner" initial={[lesson]} /><ConfirmIdentity /></>));
  await userEvent.click(screen.getByRole("button", { name: `Remove ${lesson.text}` }));
  await userEvent.click(await screen.findByRole("button", { name: "Remove" }));
  const prompt = await screen.findByRole("dialog", { name: "Confirm it's you" });
  expect(post).toHaveBeenCalledTimes(1);
  await userEvent.click(within(prompt).getByRole("button", { name: "Close" }));
  expect(dialog()).toBeNull();
  expect(post).toHaveBeenCalledTimes(1);
});
