// SPDX-License-Identifier: AGPL-3.0-only
// Lessons load through the query layer: a loading state first, then the lessons by writer, and an
// error panel with Retry when they can't be read.
import { afterEach, expect, test, vi } from "vitest";
import { createMemoryHistory, createRootRoute, createRouter, RouterContextProvider } from "@tanstack/react-router";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { api } from "../client";
import { withQueries, choose } from "../testing";
import { FACT_SUGGESTED, Lessons } from "./Lessons";
import { dayWords } from "../campaigns/actions";

const W = "00000000-0000-4000-8000-0000000000aa";
const reply = (status: number, body: unknown) => Promise.resolve({ ...(status < 400 ? { data: body } : { error: body }), response: new Response(null, { status }) });
const lesson = { id: "00000000-0000-4000-8000-0000000000bb", agent: "recipient_writer", version: 1, text: "First emails here run under 90 words.", createdAt: "2026-11-07T00:00:00.000Z", origin: { itemId: null, sourceRef: null, proposedBy: null } };

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

test("Lessons shows a loading state, then each writer's lessons", async () => {
  vi.spyOn(api, "GET").mockImplementation((() => reply(200, { lessons: [lesson] })) as never);
  render(withQueries(<Lessons workspaceId={W} role="owner" />));
  expect(screen.getAllByRole("status").some((s) => s.textContent === "Loading")).toBe(true);
  expect(await screen.findByText(lesson.text)).toBeTruthy();
  expect(screen.getByRole("heading", { name: "For the email writer" })).toBeTruthy();
  expect(screen.getByText(`Added ${dayWords(lesson.createdAt.slice(0, 10))}`)).toBeTruthy();
});

test("when the lessons can't be read, Lessons says so and Retry reads them again", async () => {
  let fail = true;
  vi.spyOn(api, "GET").mockImplementation((() => (fail ? reply(403, { error: "forbidden" }) : reply(200, { lessons: [] }))) as never);
  render(withQueries(<Lessons workspaceId={W} role="viewer" />));
  expect((await screen.findByRole("alert")).textContent).toContain("Your role doesn't allow that.");
  fail = false;
  await userEvent.click(screen.getByRole("button", { name: "Retry" }));
  expect(await screen.findByText("No lessons yet")).toBeTruthy();
});

const on = { params: { path: { workspaceId: W, id: lesson.id } } };

test("an Owner retires a lesson, and a refusal says why", async () => {
  vi.spyOn(api, "GET").mockImplementation((() => reply(200, { lessons: [lesson] })) as never);
  const post = vi.spyOn(api, "POST").mockImplementation((() => reply(403, { error: "step_up_required" })) as never);
  render(withQueries(<Lessons workspaceId={W} role="owner" initial={[lesson]} />));
  await userEvent.click(screen.getByRole("button", { name: `Remove ${lesson.text}` }));
  await userEvent.click(await screen.findByRole("button", { name: "Remove" }));
  expect(post).toHaveBeenCalledWith("/api/w/{workspaceId}/lessons/{id}/retire", { ...on, body: { version: 1 } });
  expect((await screen.findByRole("alert")).textContent).toContain("This needs a sign-in from the last 10 minutes.");
});

test("an Owner rewrites a lesson, and a refused rewrite lists the reasons", async () => {
  vi.spyOn(api, "GET").mockImplementation((() => reply(200, { lessons: [lesson] })) as never);
  const post = vi.spyOn(api, "POST").mockImplementation((() => reply(422, { error: "lesson_check_refused", reasons: ["names_person", "odd"] })) as never);
  render(withQueries(<Lessons workspaceId={W} role="admin" initial={[lesson]} />));
  await userEvent.click(screen.getByText("Rewrite"));
  const box = screen.getByLabelText("New words");
  await userEvent.clear(box);
  await userEvent.type(box, "Ana likes short emails.");
  await userEvent.click(screen.getByRole("button", { name: "Save" }));
  expect(post).toHaveBeenCalledWith("/api/w/{workspaceId}/lessons/{id}/rewrite", { ...on, body: { version: 1, text: "Ana likes short emails." } });
  expect((await screen.findByRole("alert")).textContent).toBe("Direx can't keep that one. (it names a person; odd)");
});

test("a Marketer suggests a lesson as a Fact, and is told where it waits", async () => {
  vi.spyOn(api, "GET").mockImplementation((() => reply(200, { lessons: [lesson] })) as never);
  const post = vi.spyOn(api, "POST").mockImplementation((() => reply(200, {})) as never);
  render(withQueries(<Lessons workspaceId={W} role="marketer" initial={[lesson]} />));
  expect(screen.queryByRole("button", { name: /^Remove/ })).toBeNull();
  await userEvent.click(screen.getByText("Make this a brand fact"));
  await choose("Where it goes", "Tone");
  await userEvent.type(screen.getByLabelText("Where it came from"), "Edit on 7 Nov");
  await userEvent.click(screen.getByRole("button", { name: "Suggest the brand fact" }));
  expect(post).toHaveBeenCalledWith("/api/w/{workspaceId}/lessons/{id}/to-fact", { ...on, body: { version: 1, field: "tone", sourceLabel: "Edit on 7 Nov" } });
  expect(await screen.findByText(FACT_SUGGESTED)).toBeTruthy();
  expect(screen.queryByRole("alert")).toBeNull();
});

test("each lesson's Remove button names its lesson", async () => {
  const other = { ...lesson, id: "00000000-0000-4000-8000-0000000000cc", text: "Mention the audit price." };
  vi.spyOn(api, "GET").mockImplementation((() => reply(200, { lessons: [lesson, other] })) as never);
  render(withQueries(<Lessons workspaceId={W} role="owner" initial={[lesson, other]} />));
  expect(screen.getByRole("button", { name: "Remove First emails here run under 90 words." })).toBeTruthy();
  expect(screen.getByRole("button", { name: "Remove Mention the audit price." })).toBeTruthy();
});

test("each lesson says who proposed it, links the Campaign edit and the accepted proposal, and says nothing it doesn't know", async () => {
  const C = "00000000-0000-4000-8000-0000000000cc";
  const I = "00000000-0000-4000-8000-0000000000dd";
  const known = { ...lesson, origin: { itemId: I, sourceRef: `campaign:${C}/intro/p1`, proposedBy: "Ana" } };
  const router = createRouter({ routeTree: createRootRoute(), history: createMemoryHistory() });
  render(withQueries(<RouterContextProvider router={router}><Lessons workspaceId={W} role="viewer" initial={[known, { ...lesson, id: "00000000-0000-4000-8000-0000000000ee", text: "Older one." }]} /></RouterContextProvider>));
  expect(screen.getByText(/Proposed by Ana after an edit in/)).toBeTruthy();
  expect(screen.getByRole("link", { name: "this Campaign" }).getAttribute("href")).toBe(`/w/${W}/campaigns/${C}?tab=drafts`);
  expect(screen.getByRole("link", { name: "See the proposal" }).getAttribute("href")).toBe(`/w/${W}/review/${I}`);
  expect(screen.getAllByText(/Proposed/)).toHaveLength(1);
});

test("a lesson waiting in Needs you shows with a link to its Item, in place of No lessons yet", async () => {
  const I = "00000000-0000-4000-8000-0000000000dd";
  vi.spyOn(api, "GET").mockImplementation(((path: string) =>
    path === "/api/w/{workspaceId}/items" ? reply(200, { items: [{ id: I, kind: "lesson_proposal", title: 'Remember this: "Short emails."' }, { id: "x", kind: "fact_proposal", title: "Tone" }] }) : reply(200, { lessons: [] })) as never);
  const router = createRouter({ routeTree: createRootRoute(), history: createMemoryHistory() });
  render(withQueries(<RouterContextProvider router={router}><Lessons workspaceId={W} role="owner" /></RouterContextProvider>));
  const link = await screen.findByRole("link", { name: 'Remember this: "Short emails."' });
  expect(link.getAttribute("href")).toBe(`/w/${W}/review/${I}`);
  expect(screen.queryByText("Tone")).toBeNull();
  expect(screen.queryByText("No lessons yet")).toBeNull();
});
