// SPDX-License-Identifier: AGPL-3.0-only
// The per-person email step: writing the emails, following the runs until they end, and fixing one draft.
import { afterEach, expect, test, vi } from "vitest";
import { act, cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { api } from "../client";
import { withQueries } from "../testing";
import type { PersonDraft, PersonPreview, Step } from "./actions";
import { PersonStep } from "./PersonStep";

const W = "00000000-0000-4000-8000-0000000000aa";
const ID = "00000000-0000-4000-8000-0000000000bb";
const reply = (status: number, body: unknown) => Promise.resolve({ ...(status < 400 ? { data: body } : { error: body }), response: new Response(null, { status }) });
const step = { key: "first", title: "First", type: "email", mailboxCredentialId: null } as unknown as Step;
const preview: PersonPreview = { willWrite: 2, generic: 1, already: 0, leftOut: [{ email: "nobody@acme.test", leftOut: { reason: "no_email" } }], worstCaseCents: 40, days: 1 };
const draft = (o: Partial<PersonDraft> = {}): PersonDraft => ({ personId: "p1", itemId: "i1", email: "kim@acme.test", state: "needs_approval", editable: true, warnings: [], subject: "Hello", text: "Hi Kim", spans: null, ...o });

type Handler = (path: string, init: { params: { path: Record<string, string> } }) => Promise<unknown> | undefined;
function serve(o: { get?: Handler; post?: Handler; put?: Handler }) {
  const fallback = (h?: Handler) => ((path: string, init: never) => h?.(path, init) ?? reply(404, { error: "not_found" })) as never;
  return { get: vi.spyOn(api, "GET").mockImplementation(fallback(o.get)), post: vi.spyOn(api, "POST").mockImplementation(fallback(o.post)), put: vi.spyOn(api, "PUT").mockImplementation(fallback(o.put)) };
}
/** Keeps the step's 5-second follow-up so a test can run it at once, leaving every other timer alone. */
function catchPolls() {
  const polls: (() => void)[] = [];
  const real = globalThis.setInterval;
  vi.spyOn(globalThis, "setInterval").mockImplementation(((fn: () => void, ms?: number) => {
    if (ms === 5000) polls.push(fn);
    return real(fn, ms);
  }) as never);
  return { poll: () => act(async () => polls.at(-1)!()) };
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

test("Write starts a run per email, follows them until they end, and says which couldn't be written", async () => {
  const { poll } = catchPolls();
  let drafts: PersonDraft[] = [];
  const runs: Record<string, unknown> = {
    r1: { id: "r1", status: "running", statusReason: null, proposals: [] },
    r2: { id: "r2", status: "failed", statusReason: null, proposals: [] },
  };
  const s = serve({
    get: (path, init) => {
      if (path.endsWith("/person-preview")) return reply(200, preview);
      if (path.endsWith("/person-drafts")) return reply(200, { drafts });
      if (path.endsWith("/agents/runs/{id}")) return reply(200, runs[init.params.path.id!]);
      return undefined;
    },
    post: (path) => (path.endsWith("/write-per-person") ? reply(200, { runIds: ["r1", "r2"], failed: [{ email: "lee@acme.test", reason: "failed" }] }) : undefined),
  });
  render(withQueries(<PersonStep workspaceId={W} id={ID} step={step} edit />));

  expect(await screen.findByText(/2 emails to write\. At most \$0\.40 in model costs, over about 1 day\./)).toBeTruthy();
  expect(screen.getByText(/1 email will be general, with no website to read\./)).toBeTruthy();
  expect(within(screen.getByRole("list", { name: "Left out" })).getByText(/nobody@acme\.test/)).toBeTruthy();

  await userEvent.click(screen.getByRole("button", { name: "Write 2 emails" }));
  expect(s.post.mock.calls[0]![1]).toMatchObject({ body: { timeZone: expect.any(String) } });
  expect(await screen.findByText(/1 email couldn't start\./)).toBeTruthy();
  expect(screen.getByText(/Writing\. New drafts appear below/)).toBeTruthy();
  expect(screen.queryByRole("button", { name: "Write 2 emails" })).toBeNull();

  // The first look: r2 stopped, r1 still runs, so the step keeps writing and says what stopped.
  await poll();
  expect(await screen.findByText(/1 email couldn't be written\. The draft didn't finish/)).toBeTruthy();
  expect(screen.getByText(/Writing\. New drafts appear below/)).toBeTruthy();

  // The next look: r1 finished with a draft, so the step stops following and shows it.
  runs.r1 = { id: "r1", status: "succeeded", statusReason: null, proposals: [] };
  drafts = [draft()];
  await poll();
  expect(await screen.findByRole("list", { name: "Drafts" })).toBeTruthy();
  expect(screen.queryByText(/Writing\. New drafts appear below/)).toBeNull();
  expect(screen.getByText(/1 email couldn't be written/)).toBeTruthy();
});

test("a reader that finished hands its person to a writer run, which the step follows until the draft is there", async () => {
  const { poll } = catchPolls();
  let written = false;
  const at = "2026-11-14T10:00:00.000Z";
  const runs: Record<string, unknown> = { r1: { id: "r1", agent: "recipient_reader", status: "running", statusReason: null, proposals: [], createdAt: at } };
  let writer = { id: "w1", agent: "recipient_writer", status: "running", statusReason: null, proposals: [], createdAt: "2026-11-14T10:01:00.000Z" };
  serve({
    get: (path, init) => {
      if (path.endsWith("/person-preview")) return reply(200, { ...preview, willWrite: written ? 0 : 1, already: written ? 1 : 0 });
      if (path.endsWith("/person-drafts")) return reply(200, { drafts: written ? [draft()] : [] });
      if (path.endsWith("/agents/runs/{id}")) return reply(200, init.params.path.id === "w1" ? writer : runs[init.params.path.id!]);
      if (path.endsWith("/agents/runs")) return reply(200, { runs: [writer, { ...writer, id: "old", createdAt: "2026-11-13T10:00:00.000Z" }] });
      return undefined;
    },
    post: (path) => (path.endsWith("/write-per-person") ? reply(200, { runIds: ["r1"], failed: [] }) : undefined),
  });
  render(withQueries(<PersonStep workspaceId={W} id={ID} step={step} edit />));
  await userEvent.click(await screen.findByRole("button", { name: "Write 1 email" }));

  // The reader is done, but its writer still runs: no draft yet, and no Write button offering to start it again.
  runs.r1 = { ...(runs.r1 as object), status: "succeeded" };
  await poll();
  expect(screen.getByText(/Writing\. New drafts appear below/)).toBeTruthy();
  expect(screen.queryByRole("button", { name: "Write 1 email" })).toBeNull();

  writer = { ...writer, status: "succeeded" };
  written = true;
  await poll();
  expect(await screen.findByRole("list", { name: "Drafts" })).toBeTruthy();
  expect(screen.queryByText(/Writing\. New drafts appear below/)).toBeNull();
  expect(screen.queryByText(/to write\./)).toBeNull();
  expect(screen.queryByRole("button", { name: /^Write / })).toBeNull();
});

test("Cancel stops the emails still being written, and the step stops following them", async () => {
  const runs: Record<string, { id: string; status: string; statusReason: null; proposals: [] }> = { r1: { id: "r1", status: "running", statusReason: null, proposals: [] } };
  const s = serve({
    get: (path, init) => {
      if (path.endsWith("/person-preview")) return reply(200, preview);
      if (path.endsWith("/person-drafts")) return reply(200, { drafts: [] });
      if (path.endsWith("/agents/runs/{id}")) return reply(200, runs[init.params.path.id!]);
      return undefined;
    },
    post: (path, init) => {
      if (path.endsWith("/write-per-person")) return reply(200, { runIds: ["r1"], failed: [] });
      if (path.endsWith("/agents/runs/{id}/cancel")) return ((runs[init.params.path.id!]!.status = "cancelled"), reply(200, { ok: true }));
      return undefined;
    },
  });
  render(withQueries(<PersonStep workspaceId={W} id={ID} step={step} edit />));
  await userEvent.click(await screen.findByRole("button", { name: "Write 2 emails" }));
  await userEvent.click(await screen.findByRole("button", { name: "Cancel the emails still being written" }));
  expect(s.post).toHaveBeenCalledWith("/api/w/{workspaceId}/agents/runs/{id}/cancel", { params: { path: { workspaceId: W, id: "r1" } } });
  await vi.waitFor(() => expect(screen.queryByText(/Writing\. New drafts appear below/)).toBeNull());
  expect(screen.getByRole("button", { name: "Write 2 emails" })).toBeTruthy();
});

test("a refused Write says why and starts nothing", async () => {
  serve({
    get: (path) => (path.endsWith("/person-preview") ? reply(200, preview) : path.endsWith("/person-drafts") ? reply(200, { drafts: [] }) : undefined),
    post: (path) => (path.endsWith("/write-per-person") ? reply(409, { error: "no_mailbox" }) : undefined),
  });
  render(withQueries(<PersonStep workspaceId={W} id={ID} step={step} edit />));
  await userEvent.click(await screen.findByRole("button", { name: "Write 2 emails" }));
  expect(await screen.findByRole("alert")).toBeTruthy();
  expect(screen.queryByText(/Writing\./)).toBeNull();
  expect(screen.getByRole("button", { name: "Write 2 emails" })).toBeTruthy();
});

test("a draft held for a decision opens its form; a refused fix says why, and a saved one offers Remember this", async () => {
  const held = draft({ warnings: [{ code: "unspecified", text: "Needs a decision: which offer to name." }] });
  let answer = reply(409, { error: "stale" });
  const s = serve({
    get: (path) => (path.endsWith("/person-preview") ? reply(200, { ...preview, willWrite: 0, leftOut: [] }) : path.endsWith("/person-drafts") ? reply(200, { drafts: [held] }) : undefined),
    put: (path) => (path.endsWith("/draft") ? answer : undefined),
  });
  render(withQueries(<PersonStep workspaceId={W} id={ID} step={step} edit />));

  const subject = await screen.findByRole("textbox", { name: "Subject" });
  await userEvent.clear(subject);
  await userEvent.type(subject, "Hello again");
  const body = screen.getByRole("textbox", { name: "Email" });
  await userEvent.clear(body);
  await userEvent.type(body, "Hi Kim, one more thing");
  await userEvent.click(screen.getByRole("button", { name: "Fix and send kim@acme.test for approval" }));
  expect(await screen.findByRole("alert")).toBeTruthy();
  expect(s.put.mock.calls[0]![1]).toMatchObject({ params: { path: { personId: "p1" } }, body: { subject: "Hello again", text: "Hi Kim, one more thing" } });
  expect(screen.queryByText("Remember this?")).toBeNull();

  answer = reply(200, {});
  await userEvent.click(screen.getByRole("button", { name: "Fix and send kim@acme.test for approval" }));
  expect(await screen.findByText("Remember this?")).toBeTruthy();
  expect(screen.queryByRole("alert")).toBeNull();
});

test("a rewrite started from the writer notes reloads the drafts", async () => {
  const s = serve({
    get: (path) => (path.endsWith("/person-preview") ? reply(200, { ...preview, willWrite: 0, leftOut: [] }) : path.endsWith("/person-drafts") ? reply(200, { drafts: [draft()] }) : undefined),
    post: (path, init) => (path.endsWith("/redraft") ? reply(200, (init as unknown as { body: { confirm: boolean } }).body.confirm ? { started: 1, runIds: [] } : { runs: 1, worstCaseCents: 5 }) : undefined),
  });
  render(withQueries(<PersonStep workspaceId={W} id={ID} step={{ ...step, writerNotes: "Keep it short." } as Step} edit />));
  await userEvent.click(await screen.findByRole("button", { name: "Rewrite the drafts nobody approved" }));
  const loads = () => s.get.mock.calls.filter((c) => (c[0] as string).endsWith("/person-drafts")).length;
  const before = loads();
  await userEvent.click(await screen.findByRole("button", { name: /^Rewrite 1 draft/ }));
  await vi.waitFor(() => expect(loads()).toBe(before + 1));
});

test("a step that can't write yet says why, and a reader sees drafts without a Write button or form", async () => {
  serve({
    get: (path) => (path.endsWith("/person-preview") ? reply(409, { error: "no_mailbox" }) : path.endsWith("/person-drafts") ? reply(200, { drafts: [draft()] }) : undefined),
  });
  render(withQueries(<PersonStep workspaceId={W} id={ID} step={step} edit={false} />));
  expect(await screen.findByText(/Emails can't be written yet\./)).toBeTruthy();
  expect(await screen.findByRole("list", { name: "Drafts" })).toBeTruthy();
  expect(screen.queryByRole("button", { name: /Write/ })).toBeNull();
  expect(screen.queryByRole("textbox", { name: "Subject" })).toBeNull();
});
