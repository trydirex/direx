// SPDX-License-Identifier: AGPL-3.0-only
// The clips step: uploading a recording and starting clips, following the run, trying again, approving a
// clip's posts and editing its caption.
import { afterEach, expect, test, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { api } from "../client";
import { withQueries } from "../testing";
import type { Post } from "../social/actions";
import type { Step } from "./actions";
import { ClipsStep } from "./ClipsStep";

// Astryx draws its own file and date pickers, which happy-dom can't drive; a native input stands in, so
// these tests are about the step and not the picker.
vi.mock("@/components/Input", async (load) => ({
  ...(await load<object>()),
  Input: ({ label, className: _, ...p }: { label?: string; className?: string }) => (
    <label>
      {label}
      <input {...p} />
    </label>
  ),
}));

const W = "00000000-0000-4000-8000-0000000000aa";
const ID = "00000000-0000-4000-8000-0000000000bb";
const reply = (status: number, body: unknown) => Promise.resolve({ ...(status < 400 ? { data: body } : { error: body }), response: new Response(null, { status }) });
const step = { key: "first", on: "2026-11-03", title: "First", type: "clips" } as unknown as Step;
const account = { id: "a1", credentialId: "cr1", connection: "youtube", network: "YouTube", accountType: "channel", networkId: "n1", name: "Acme", status: "ok", ownerUserId: null, lastCheckedAt: null, canDo: [] };
const network = { connection: "youtube", label: "YouTube", accountTypes: [], connect: "oauth", availability: "available", canConnect: true, publishes: true, app: null };
const setup = { sourceMediaId: "src1", accounts: [{ connection: "youtube", credentialId: "cr1", networkId: "n1" }], firstAt: "2026-11-04T10:00:00.000Z" };
const clip = { id: "c1", mediaId: "m1", startMs: 0, endMs: 30000, title: "The hook", caption: "Launch day", citations: [], measureKey: null, why: "Strong opener." };
const recording = (state: string, o: object = {}) => ({ setup, run: { id: "r1", state, failure: state === "failed" ? "the transcript came back empty" : null, dropped: [] }, clips: state === "done" ? [clip] : [], unposted: [], idle: [], ...o });
const post = (o: Partial<Post> = {}): Post => ({ id: "s1", itemId: "i1", clipId: "c1", connection: "youtube", network: "YouTube", accountName: null, mode: "publish", text: "Launch day", video: null, images: [], url: null, followUps: [], state: "needs_approval", reason: null, revision: 1, clean: true, warnings: [], at: null, ...o });

type Handler = (path: string) => Promise<unknown> | undefined;
function serve(o: { get?: Handler; post?: Handler; put?: Handler }) {
  const fallback = (h?: Handler) => ((path: string) => h?.(path) ?? reply(404, { error: "not_found" })) as never;
  return { get: vi.spyOn(api, "GET").mockImplementation(fallback(o.get)), post: vi.spyOn(api, "POST").mockImplementation(fallback(o.post)), put: vi.spyOn(api, "PUT").mockImplementation(fallback(o.put)) };
}
/** The step's reads: its accounts, networks, the clip view as the test sets it, and its posts. */
const reads = (view: () => unknown, posts: Post[] = []): Handler => (path) => {
  if (path.endsWith("/social/accounts")) return reply(200, { accounts: [account] });
  if (path.endsWith("/social/networks")) return reply(200, { networks: [network] });
  if (path.endsWith("/social/posts")) return reply(200, { posts });
  if (path.endsWith("/clips")) return reply(200, view());
  return undefined;
};
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
const uploads = (...answers: [number, unknown][]) => {
  const spy = vi.spyOn(globalThis, "fetch");
  for (const [status, body] of answers) spy.mockResolvedValueOnce(new Response(JSON.stringify(body), { status }));
  return spy;
};
const show = (o: { edit?: boolean; approve?: boolean } = {}) => render(withQueries(<ClipsStep workspaceId={W} id={ID} step={step} edit={o.edit ?? true} approve={o.approve ?? false} />));

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

test("upload a recording, pick an account and a time, Make clips; a refusal says why, then the run is followed until its clips show", async () => {
  const { poll } = catchPolls();
  let view: unknown = { recordings: [], lastAccounts: [] };
  let answer = reply(409, { error: "too_long" });
  const s = serve({ get: reads(() => view, [post()]), put: (path) => (path.endsWith("/clips") ? answer : undefined) });
  const upload = uploads([413, { error: "nope" }], [201, { media: { id: "src0", fileName: "old.mp4", bytes: 1_000_000 } }], [201, { media: { id: "src1", fileName: "talk.mp4", bytes: 2_000_000 } }]);
  show();

  const file = await screen.findByLabelText("Upload a recording");
  await userEvent.upload(file, new File(["x"], "talk.mp4", { type: "video/mp4" }));
  expect(await screen.findByText("The upload didn't go through. Try again.")).toBeTruthy();
  expect(upload.mock.calls[0]![0]).toBe(`/api/w/${W}/media?kind=source`);

  // A second try works; Choose another puts the picker back for a third.
  await userEvent.upload(screen.getByLabelText("Upload a recording"), new File(["x"], "old.mp4", { type: "video/mp4" }));
  expect(await screen.findByText(/old\.mp4/)).toBeTruthy();
  await userEvent.click(screen.getByRole("button", { name: "Choose another" }));
  await userEvent.upload(screen.getByLabelText("Upload a recording"), new File(["x"], "talk.mp4", { type: "video/mp4" }));
  expect(await screen.findByText(/talk\.mp4/)).toBeTruthy();

  const make = screen.getByRole("button", { name: "Make clips" });
  expect(make.hasAttribute("disabled")).toBe(true);
  await userEvent.click(await screen.findByRole("checkbox", { name: /YouTube: Acme/ }));
  fireEvent.change(screen.getByLabelText("First post"), { target: { value: "2026-11-04T10:00" } });
  expect(make.hasAttribute("disabled")).toBe(false);

  await userEvent.click(make);
  expect(await screen.findByRole("alert")).toBeTruthy();
  expect(s.put.mock.calls[0]![1]).toMatchObject({ body: { sourceMediaId: "src1", accounts: setup.accounts, firstAt: new Date("2026-11-04T10:00").toISOString() } });
  expect(screen.getByText(/talk\.mp4/)).toBeTruthy();

  answer = reply(200, {});
  view = { recordings: [recording("transcribing")], lastAccounts: setup.accounts };
  await userEvent.click(screen.getByRole("button", { name: "Make clips" }));
  expect(await screen.findByText(/Transcribing the recording\. This takes a few minutes/)).toBeTruthy();
  expect(screen.queryByRole("button", { name: "Make clips" })).toBeNull();

  view = { recordings: [recording("done")], lastAccounts: setup.accounts };
  await poll();
  expect(await screen.findByRole("article", { name: "The hook" })).toBeTruthy();
  // The form is back for another recording, with the last one's account ticked.
  expect(await screen.findByText("Another recording")).toBeTruthy();
  expect((screen.getByRole("checkbox", { name: /YouTube: Acme/ }) as HTMLInputElement).checked).toBe(true);
});

test("a stopped recording says why, and Try again starts it with the same setup", async () => {
  let view: unknown = { recordings: [recording("failed")], lastAccounts: [] };
  const s = serve({ get: reads(() => view), put: (path) => (path.endsWith("/clips") ? reply(200, {}) : undefined) });
  show();
  expect(await screen.findByText(/Clipping stopped: the transcript came back empty\./)).toBeTruthy();
  view = { recordings: [recording("queued")], lastAccounts: [] };
  await userEvent.click(screen.getByRole("button", { name: "Try again" }));
  expect(s.put.mock.calls[0]![1]).toMatchObject({ body: setup });
  expect(await screen.findByText(/Waiting to start\./)).toBeTruthy();
  expect(screen.queryByRole("button", { name: "Try again" })).toBeNull();
});

test("Approve this clip approves its clean posts, then shows a refusal; moments left out are listed with why", async () => {
  const view = { recordings: [recording("done", { run: { id: "r1", state: "done", failure: null, dropped: [{ moment: { title: "The aside" }, reason: "too short" }] } })], lastAccounts: [] };
  const s = serve({ get: reads(() => view, [post()]), post: (path) => (path.endsWith("/approve-clean") ? reply(200, { results: [{ id: "i1", ok: false, reason: "stale" }] }) : undefined) });
  show({ edit: false, approve: true });
  await userEvent.click(await screen.findByRole("button", { name: "Approve this clip" }));
  expect(s.post.mock.calls[0]![1]).toMatchObject({ body: { items: [{ id: "i1", revision: 1 }] } });
  expect(await screen.findByRole("alert")).toBeTruthy();
  expect(screen.getByText("Moments left out (1)")).toBeTruthy();
  expect(screen.getByText("The aside: too short")).toBeTruthy();
});

test("a clip's caption saves only once it changes, and a refused save says why", async () => {
  const view = { recordings: [recording("done")], lastAccounts: [] };
  let answer = reply(409, { error: "posted" });
  const s = serve({ get: reads(() => view, [post()]), put: (path) => (path.endsWith("/caption") ? answer : undefined) });
  show();
  const save = await screen.findByRole("button", { name: "Save caption" });
  expect(save.hasAttribute("disabled")).toBe(true);
  const caption = screen.getByRole("textbox", { name: "Caption" });
  await userEvent.clear(caption);
  await userEvent.type(caption, "Launch day, in 30 seconds");
  await userEvent.click(save);
  expect(s.put.mock.calls[0]![1]).toMatchObject({ params: { path: { clipId: "c1" } }, body: { text: "Launch day, in 30 seconds" } });
  expect(await screen.findByRole("alert")).toBeTruthy();

  answer = reply(200, {});
  await userEvent.click(save);
  await vi.waitFor(() => expect(screen.queryByRole("alert")).toBeNull());
  expect(s.put).toHaveBeenCalledTimes(2);
});
