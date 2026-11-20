// SPDX-License-Identifier: AGPL-3.0-only
// The write-up card in each of its states, Write it again for those who may edit, and the suggestions
// Item's body: all ticked to begin with, edits sent as the choice, and its refusals in words.
import { QueryClient } from "@tanstack/react-query";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, test, vi } from "vitest";
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import { api } from "../client";
import { withQueries } from "../testing";
import type { WriteUp as Data } from "./actions";
import { AssumptionsChoice, failureWords, WriteUp } from "./WriteUp";
import { ItemPanel } from "../items/ItemPanel";
import { itemQuery, type Item } from "../items/actions";

const W = "00000000-0000-4000-8000-0000000000aa";
const ID = "00000000-0000-4000-8000-0000000000bb";
const ITEM = "00000000-0000-4000-8000-0000000000cc";
const READING = "00000000-0000-4000-8000-000000000001";
const reply = (status: number, body: unknown) => Promise.resolve({ ...(status < 400 ? { data: body } : { error: body }), response: new Response(null, { status }) });

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const suggestions = [
  { assumption: "People who get email and a LinkedIn DM reply more.", because: "10 of 30 reached both ways were interested.", readingIds: [READING] },
  { assumption: "Meetings come within a week of the first reply.", because: "6 meetings were counted.", readingIds: [READING] },
];
const written: Data = {
  status: "written",
  paragraph: "The Campaign reached 60 People by email and 30 by LinkedIn DM.",
  cites: [
    { readingId: READING, label: "Meetings", value: "6", source: "system", observedOn: "2026-11-12" },
    { readingId: "00000000-0000-4000-8000-000000000002", label: "Signups", value: "142", source: "person", observedOn: "2026-11-10" },
  ],
  suggestions,
  failure: null,
  itemId: ITEM,
  writtenAt: "2026-11-13T06:00:00.000Z",
  corrected: false,
};

function serve(writeUp: Data | null, again: () => ReturnType<typeof reply> = () => reply(202, { writeUp: { ...writeUp, status: "writing" } })) {
  vi.spyOn(api, "GET").mockImplementation(((path: string) => (path === "/api/w/{workspaceId}/campaigns/{id}/write-up" ? reply(200, { writeUp }) : reply(404, { error: "not_found" }))) as never);
  return vi.spyOn(api, "POST").mockImplementation((() => again()) as never);
}
async function show(writeUp: Data | null, o: { edit?: boolean; status?: "ended" | "running"; again?: () => ReturnType<typeof reply> } = {}) {
  const post = serve(writeUp, o.again);
  render(withQueries(<WriteUp workspaceId={W} campaign={{ id: ID, status: o.status ?? "ended" }} edit={o.edit ?? true} />));
  return { card: within(await screen.findByRole("region", { name: "Write-up" })), post };
}

test("before it exists, it says when Direx writes it", async () => {
  const { card } = await show(null);
  expect(card.getByText("Direx writes this up once every step is settled.")).toBeTruthy();
  expect(card.queryByRole("button")).toBeNull();
});

test("while it's being written, it says so and offers nothing", async () => {
  const { card } = await show({ ...written, status: "writing", paragraph: null, cites: [], suggestions: [] });
  expect(card.getByRole("status").textContent).toBe("Writing the write-up…");
  expect(card.queryByRole("button")).toBeNull();
});

test("written: the paragraph, each number with where it came from, and each suggestion with its because line", async () => {
  const { card } = await show(written);
  expect(card.getByText(written.paragraph!)).toBeTruthy();
  expect(card.getByRole("heading", { name: "Based on" })).toBeTruthy();
  expect(card.getByText("Meetings: 6")).toBeTruthy();
  expect(card.getByText("As of Thu 12 Nov, counted by Direx")).toBeTruthy();
  expect(card.getByText("Signups: 142")).toBeTruthy();
  expect(card.getByText("As of Tue 10 Nov, entered by a person")).toBeTruthy();
  expect(card.getByRole("heading", { name: "Suggested for your Strategy" })).toBeTruthy();
  expect(card.getByText(suggestions[0]!.because)).toBeTruthy();
  expect(card.getByRole("link", { name: "Choose which to add in Review" }).getAttribute("href")).toBe(`/w/${W}/review/${ITEM}`);
  expect(card.queryByRole("button", { name: "Write it again" })).toBeNull();
});

test("once decided, each suggestion says whether it was added, and the link goes", async () => {
  const { card } = await show({ ...written, suggestions: [{ ...suggestions[0]!, outcome: "added" }, { ...suggestions[1]!, outcome: "not_added" }] });
  expect(card.getByText("Added to the Strategy")).toBeTruthy();
  expect(card.getByText("Not added")).toBeTruthy();
  expect(card.queryByRole("link")).toBeNull();
});

test("a failure says why in plain words, and offers Write it again", async () => {
  const { card } = await show({ ...written, status: "failed", failure: "number_not_in_brief:37" });
  expect(card.getByText("Direx couldn't write this up: its draft used a number it wasn't given.")).toBeTruthy();
  // The last write-up that passed stays.
  expect(card.getByText(written.paragraph!)).toBeTruthy();
  expect(card.getByRole("button", { name: "Write it again" })).toBeTruthy();
  expect(failureWords("not_started:no_route")).toBe("Direx couldn't start writing this up.");
  expect(failureWords("credit:thanks to")).toBe("Direx couldn't write this up: its draft gave the Campaign credit for a result, which the numbers can't show.");
  expect(failureWords("repeats_assumption")).toBe("Direx couldn't write this up: its draft suggested an assumption your Strategy already has.");
  expect(failureWords("something_new")).toBe("Direx couldn't write this up.");
});

test("a corrected number says so; Write it again calls the API and shows it being written", async () => {
  const { card, post } = await show({ ...written, corrected: true });
  expect(card.getByText("A number here was corrected after this was written.")).toBeTruthy();
  serve({ ...written, status: "writing" });
  await userEvent.click(card.getByRole("button", { name: "Write it again" }));
  expect(post).toHaveBeenCalledWith("/api/w/{workspaceId}/campaigns/{id}/write-up", { params: { path: { workspaceId: W, id: ID } } });
  expect((await card.findByRole("status")).textContent).toBe("Writing the write-up…");
  expect(card.queryByRole("alert")).toBeNull();
});

test("a lost write-again response says to retry, refreshes, and lets the editor retry", async () => {
  const { card, post } = await show({ ...written, status: "failed" });
  post.mockRejectedValueOnce(new TypeError("Network error"));
  const again = card.getByRole("button", { name: "Write it again" });
  await userEvent.click(again);
  expect((await card.findByRole("alert")).textContent).toContain("Try again");
  expect(api.GET).toHaveBeenCalledTimes(2);

  serve({ ...written, status: "writing" });
  await userEvent.click(again);
  expect((await card.findByRole("status")).textContent).toBe("Writing the write-up…");
  expect(card.queryByRole("alert")).toBeNull();
});

test("a Viewer sees no Write it again", async () => {
  const { card } = await show({ ...written, corrected: true }, { edit: false });
  expect(card.getByText("A number here was corrected after this was written.")).toBeTruthy();
  expect(card.queryByRole("button")).toBeNull();
});

test("already being written is quiet; not ended is a sentence", async () => {
  const quiet = await show({ ...written, status: "failed", failure: "too_long:300" }, { again: () => reply(409, { error: "writing" }) });
  await userEvent.click(quiet.card.getByRole("button", { name: "Write it again" }));
  await waitFor(() => expect(quiet.post).toHaveBeenCalled());
  expect(quiet.card.queryByRole("alert")).toBeNull();
  cleanup();
  const ended = await show({ ...written, status: "failed", failure: "too_long:300" }, { again: () => reply(409, { error: "not_ended" }) });
  await userEvent.click(ended.card.getByRole("button", { name: "Write it again" }));
  expect((await ended.card.findByRole("alert")).textContent).toBe("This Campaign hasn't ended, so it can't be written up again yet.");
});

test("a Campaign that hasn't Ended shows no card and reads nothing", async () => {
  serve(written);
  render(withQueries(<WriteUp workspaceId={W} campaign={{ id: ID, status: "running" }} edit />));
  await new Promise((r) => setTimeout(r, 20));
  expect(screen.queryByRole("region", { name: "Write-up" })).toBeNull();
  expect(api.GET).not.toHaveBeenCalled();
});

const item = { id: ITEM, revision: 3, state: "needs_approval" as const };
function choose(approve = true) {
  const post = vi.spyOn(api, "POST").mockImplementation((() => reply(200, {})) as never);
  const done = vi.fn();
  render(withQueries(<AssumptionsChoice workspaceId={W} item={item} suggestions={suggestions} approve={approve} onDone={done} />));
  return { post, done };
}

test("the Item ticks every suggestion to begin with, and approving sends each by its place", async () => {
  const { post, done } = choose();
  expect(screen.getAllByRole("checkbox").map((c) => (c as HTMLInputElement).checked)).toEqual([true, true]);
  expect((screen.getByRole("textbox", { name: "Suggestion 1" }) as HTMLTextAreaElement).value).toBe(suggestions[0]!.assumption);
  expect(screen.getByText(suggestions[1]!.because)).toBeTruthy();
  await userEvent.click(screen.getByRole("button", { name: "Add 2 to the Strategy" }));
  expect(post).toHaveBeenCalledWith("/api/w/{workspaceId}/items/{id}/approve", { params: { path: { workspaceId: W, id: ITEM } }, body: { revision: 3, choice: JSON.stringify({ add: [{ index: 0 }, { index: 1 }] }) } });
  expect(done).toHaveBeenCalled();
});

test("a lost approval response refreshes the Item and lets the reviewer retry", async () => {
  const refresh = vi.spyOn(QueryClient.prototype, "invalidateQueries");
  const { post, done } = choose();
  post.mockRejectedValueOnce(new TypeError("Network error"));
  const add = screen.getByRole("button", { name: "Add 2 to the Strategy" });
  await userEvent.click(add);
  expect((await screen.findByRole("alert")).textContent).toContain("Try again");
  expect(refresh).toHaveBeenCalledWith({ queryKey: itemQuery(W, ITEM).queryKey });
  expect(done).not.toHaveBeenCalled();

  await userEvent.click(add);
  expect(post).toHaveBeenCalledTimes(2);
  expect(done).toHaveBeenCalledOnce();
  expect(screen.queryByRole("alert")).toBeNull();
});

test("unticking one and editing the other sends only the ticked one, with its new text", async () => {
  const { post } = choose();
  await userEvent.click(screen.getByRole("checkbox", { name: "Add suggestion 1" }));
  const text = screen.getByRole("textbox", { name: "Suggestion 2" });
  await userEvent.clear(text);
  await userEvent.type(text, "Meetings come within ten days.");
  await userEvent.click(screen.getByRole("button", { name: "Add 1 to the Strategy" }));
  expect(post.mock.calls[0]![1]).toMatchObject({ body: { choice: JSON.stringify({ add: [{ index: 1, text: "Meetings come within ten days." }] }) } });
});

test("with none ticked, approving is off and says why", async () => {
  const { post } = choose();
  for (const box of screen.getAllByRole("checkbox")) await userEvent.click(box);
  const add = screen.getByRole("button", { name: "Add to the Strategy" });
  expect(add.hasAttribute("disabled") || add.getAttribute("aria-disabled") === "true").toBe(true);
  expect(screen.getByText("Tick at least one suggestion.")).toBeTruthy();
  await userEvent.click(add);
  expect(post).not.toHaveBeenCalled();
});

test("a refusal shows in words, and the Item stays open", async () => {
  for (const [code, words] of [
    ["too_many_assumptions:19", "Your Strategy already has 19 assumptions. Remove some first, or add fewer."],
    ["no_strategy", "There's no approved Strategy to add to yet."],
    ["choice_required", "Tick at least one suggestion."],
  ] as const) {
    const done = vi.fn();
    vi.spyOn(api, "POST").mockImplementation((() => reply(409, { error: code })) as never);
    render(withQueries(<AssumptionsChoice workspaceId={W} item={item} suggestions={suggestions} approve onDone={done} />));
    await userEvent.click(screen.getByRole("button", { name: "Add 2 to the Strategy" }));
    expect((await screen.findByRole("alert")).textContent).toBe(words);
    expect(done).not.toHaveBeenCalled();
    cleanup();
  }
});

test("someone who can't approve reads the suggestions without boxes to tick", () => {
  choose(false);
  expect(screen.queryByRole("checkbox")).toBeNull();
  expect(screen.queryByRole("button")).toBeNull();
  expect(screen.getByText(suggestions[0]!.assumption)).toBeTruthy();
});

test("the Item panel shows the suggestions to tick in place of a plain Accept", async () => {
  serve(null);
  const at = "2026-11-13T06:00:00.000Z";
  const i: Item = { ...item, kind: "strategy_assumptions", reason: null, reasonCode: null, title: "Add 2 assumptions to your Strategy?", workArea: "Plans", channel: null, groupKey: `strategy_assumptions:${ID}`, groupLabel: "Spring launch", at: null, warnings: [], clean: true, movable: false, decideBy: null, snoozedUntil: null, createdAt: at };
  render(withQueries(<ItemPanel workspaceId={W} id={ITEM} role="owner" initial={{ item: i, content: { campaignId: ID, suggestions }, timeline: [], ruleGrantedBy: null }} />));
  expect(await screen.findByRole("checkbox", { name: "Add suggestion 2" })).toBeTruthy();
  expect(screen.getByRole("button", { name: "Add 2 to the Strategy" })).toBeTruthy();
  expect(screen.queryByRole("button", { name: "Accept" })).toBeNull();
});
