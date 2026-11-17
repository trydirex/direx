// SPDX-License-Identifier: AGPL-3.0-only
// Writer notes in a DOM: a repeated edit is offered as a note, saving names the revision read, and a
// rewrite shows how many drafts and what it could cost before anything starts.
import { afterEach, expect, test, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { api } from "../client";
import { noteFor, type Step } from "./actions";
import { WriterNotes } from "./WriterNotes";

const W = "00000000-0000-4000-8000-0000000000aa";
const ID = "00000000-0000-4000-8000-0000000000bb";
const reply = (status: number, body: unknown) => Promise.resolve({ ...(status < 400 ? { data: body } : { error: body }), response: new Response(null, { status }) });
const step: Step = { key: "first", on: "2026-11-03", title: "First", inPlan: true, type: "email", touchClass: "cold", mailboxCredentialId: "m", audience: "everyone", dmChannel: null, dependsOnStepKey: null, outputConnection: null, outputNetworkId: null, utm: false, draftingMode: "per_person", cancelled: false, waived: false, waitingOn: null, output: null, planChange: null, templateRevision: 1, template: null, writerNotes: null, writerNotesRevision: 0 };

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

test("a note reads as an instruction to the writer", () => {
  expect(noteFor("-i hope this finds you well")).toBe('Don\'t write "i hope this finds you well".');
  expect(noteFor("+our audit")).toBe('Include "our audit".');
});

test("a repeated edit is offered as a note, and saving sends the revision it was read at", async () => {
  const put = vi.spyOn(api, "PUT").mockImplementation((() => reply(200, { revision: 1 })) as never);
  render(<WriterNotes workspaceId={W} id={ID} step={step} edit onRedraft={() => {}} initial={[{ phrase: "-i hope this finds you well", count: 3 }]} />);
  expect(screen.getByText(/cut the same words in 3 drafts/)).toBeTruthy();
  await userEvent.click(screen.getByRole("button", { name: "Add to the notes" }));
  expect((screen.getByRole("textbox", { name: "Writer notes" }) as HTMLTextAreaElement).value).toBe('Don\'t write "i hope this finds you well".');
  // Once it's in the notes, it isn't offered again.
  expect(screen.queryByRole("button", { name: "Add to the notes" })).toBeNull();
  await userEvent.click(screen.getByRole("button", { name: "Save notes" }));
  await waitFor(() => expect(screen.getByText(/New drafts follow these notes/)).toBeTruthy());
  expect(put.mock.calls[0]![1]).toMatchObject({ body: { notes: 'Don\'t write "i hope this finds you well".', revision: 0 } });
});

test("a reason given three times is offered as a note in the writer's words, and not again once it's there", async () => {
  const words = "It's too salesy. Make it lower-key, with no hard sell or hype.";
  render(<WriterNotes workspaceId={W} id={ID} step={step} edit onRedraft={() => {}} initial={[]} initialReasons={[{ reason: "salesy", count: 3, words }]} />);
  expect(screen.getByText(/3 emails on this step were marked Too salesy/)).toBeTruthy();
  await userEvent.click(screen.getByRole("button", { name: "Add to the notes" }));
  expect((screen.getByRole("textbox", { name: "Writer notes" }) as HTMLTextAreaElement).value).toBe(words);
  expect(screen.queryByText(/were marked Too salesy/)).toBeNull();
});

test("a rewrite says how many and what it could cost, and starts only on confirm", async () => {
  const post = vi.spyOn(api, "POST").mockImplementation(((_path: string, o: { body: { confirm: boolean } }) => reply(200, { runs: 2, worstCaseCents: 200, started: o.body.confirm ? 2 : 0 })) as never);
  const onRedraft = vi.fn();
  render(<WriterNotes workspaceId={W} id={ID} step={{ ...step, writerNotes: "Shorter.", writerNotesRevision: 1 }} edit onRedraft={onRedraft} initial={[]} />);
  await userEvent.click(screen.getByRole("button", { name: "Rewrite the drafts nobody approved" }));
  await waitFor(() => expect(screen.getByText(/That rewrites 2 drafts, at most \$2.00/)).toBeTruthy());
  expect(post.mock.calls.map((c) => (c[1] as { body: { confirm: boolean } }).body.confirm)).toEqual([false]);
  expect(onRedraft).not.toHaveBeenCalled();
  await userEvent.click(screen.getByRole("button", { name: "Rewrite 2 drafts" }));
  await waitFor(() => expect(screen.getByText(/Rewriting 2 drafts/)).toBeTruthy());
  expect(post.mock.calls.map((c) => (c[1] as { body: { confirm: boolean } }).body.confirm)).toEqual([false, true]);
  expect(onRedraft).toHaveBeenCalledOnce();
});

test("once the rewrites end, it says which landed and why the rest didn't, instead of saying it's rewriting", async () => {
  vi.spyOn(api, "POST").mockImplementation(((_path: string, o: { body: { confirm: boolean } }) => reply(200, { runs: 2, worstCaseCents: 200, started: o.body.confirm ? 2 : 0, runIds: o.body.confirm ? ["r1", "r2"] : [] })) as never);
  let quota = "running";
  vi.spyOn(api, "GET").mockImplementation(((_path: string, o: { params: { path: { id: string } } }) =>
    reply(200, o.params.path.id === "r1" ? { status: "succeeded", statusReason: null, proposals: [{ kind: "person_email", itemId: "i1", rejectionCode: null, incomplete: false }] } : { status: quota, statusReason: "provider_quota", proposals: [] })) as never);
  const onRedraft = vi.fn();
  render(<WriterNotes workspaceId={W} id={ID} step={{ ...step, writerNotes: "Shorter.", writerNotesRevision: 1 }} edit onRedraft={onRedraft} initial={[]} />);
  await userEvent.click(screen.getByRole("button", { name: "Rewrite the drafts nobody approved" }));
  await userEvent.click(await screen.findByRole("button", { name: "Rewrite 2 drafts" }));
  expect(await screen.findByText(/Rewriting 2 drafts/)).toBeTruthy();
  quota = "timed_out";
  expect(await screen.findByText("Rewrote 1 draft. 1 draft wasn't rewritten: the model provider's usage limit is used up, so try again once it resets.", undefined, { timeout: 8_000 })).toBeTruthy();
  expect(screen.queryByText(/Rewriting 2 drafts/)).toBeNull();
  expect(onRedraft).toHaveBeenCalledTimes(2);
}, 15_000);

test("a refused save stays on the page in words", async () => {
  vi.spyOn(api, "PUT").mockImplementation((() => reply(409, { error: "revision_moved" })) as never);
  render(<WriterNotes workspaceId={W} id={ID} step={step} edit onRedraft={() => {}} initial={[]} />);
  await userEvent.type(screen.getByRole("textbox", { name: "Writer notes" }), "Shorter.");
  await userEvent.click(screen.getByRole("button", { name: "Save notes" }));
  await waitFor(() => expect(screen.getByRole("alert").textContent).toContain("Someone saved these notes"));
});

test("without edit rights, saved notes are only shown", () => {
  render(<WriterNotes workspaceId={W} id={ID} step={{ ...step, writerNotes: "Shorter." }} edit={false} onRedraft={() => {}} initial={[]} />);
  expect(screen.getByText("Writer notes: Shorter.")).toBeTruthy();
  expect(screen.queryByRole("button")).toBeNull();
});
