// SPDX-License-Identifier: AGPL-3.0-only
import { afterEach, expect, test, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ownStatus, withQueries } from "../testing";
import { EmptyState } from "./layout";
import { Button } from "@/components/Button";
import { FALLBACK, useAction } from "./useAction";

afterEach(cleanup);

function Retire(p: { action: () => Promise<string | null>; undo: () => void }) {
  const a = useAction({ forbidden: "Your role doesn't allow that." });
  return (
    <>
      <Button pending={a.pending} onClick={() => void a.run(p.action, { say: "Retired.", undo: p.undo })}>
        Retire
      </Button>
      {a.error && <p role="alert">{a.error}</p>}
    </>
  );
}

test("an action is busy while it runs, says a refusal in the screen's words, and on success shows a toast with Undo", async () => {
  let finish: (code: string | null) => void = () => {};
  const action = vi.fn(() => new Promise<string | null>((r) => (finish = r)));
  const undo = vi.fn();
  render(withQueries(<Retire action={action} undo={undo} />));
  const button = screen.getByRole("button", { name: "Retire" });

  await userEvent.click(button);
  expect(button.getAttribute("aria-busy")).toBe("true");
  finish("forbidden");
  expect((await screen.findByRole("alert")).textContent).toBe("Your role doesn't allow that.");
  expect(button.getAttribute("aria-busy")).toBeNull();

  await userEvent.click(button);
  finish("something_new");
  expect((await screen.findByRole("alert")).textContent).toBe(FALLBACK);

  await userEvent.click(button);
  finish(null);
  expect(await screen.findByText("Retired.")).toBeTruthy();
  await waitFor(() => expect(screen.queryByRole("alert")).toBeNull());
  await userEvent.click(screen.getByRole("button", { name: "Undo" }));
  expect(undo).toHaveBeenCalledTimes(1);
});

test("an empty state says what will be here and offers one thing to do", () => {
  render(<EmptyState title="No People yet" action={<Button>Add a Person</Button>}>Add someone you may email.</EmptyState>);
  expect(ownStatus().textContent).toBe("No People yetAdd someone you may email.Add a Person");
});

function Save(p: { words?: Record<string, string> | ((code: string) => string); code: string }) {
  const a = useAction(p.words);
  return (
    <>
      <Button onClick={() => void a.run(async () => p.code)}>Save</Button>
      {a.error && <p role="alert">{a.error}</p>}
    </>
  );
}

test("a refusal uses the shared words for codes every screen has, or the screen's own function", async () => {
  render(<Save code="forbidden" />);
  await userEvent.click(screen.getByRole("button", { name: "Save" }));
  expect((await screen.findByRole("alert")).textContent).toBe("Your role doesn't allow that.");
  cleanup();
  render(<Save code="over_cap" words={(code) => `Refused: ${code}`} />);
  await userEvent.click(screen.getByRole("button", { name: "Save" }));
  expect((await screen.findByRole("alert")).textContent).toBe("Refused: over_cap");
});
