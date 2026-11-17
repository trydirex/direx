// SPDX-License-Identifier: AGPL-3.0-only
// A counter-move: the competitor's own lines with the read dates, then the comparison page, a note or a Brief.
import { afterEach, expect, test } from "vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { CounterMoveView, type CounterMoveContent } from "./CounterMove";

afterEach(cleanup);

const base: CounterMoveContent = {
  move: "comparison_page",
  competitor: { id: "c1", name: "Double" },
  target: "https://contoso.example/vs-double",
  reason: "Autoclose prices reconciliation.",
  sightings: [
    { changeId: "a", source: "changelog", lines: ["Autoclose: AI agents reconcile accounts"], before: { id: "s1", readAt: "2026-11-09T07:00:00.000Z" }, after: { id: "s2", readAt: "2026-11-16T07:00:00.000Z", url: "https://double.example/changelog" } },
    { changeId: "b", source: "landing", lines: ["headline: Your fully automated close is here."], before: { id: "s3", readAt: "2026-11-09T07:00:00.000Z" }, after: { id: "s4", readAt: "2026-11-16T07:00:00.000Z", url: "https://double.example/" } },
  ],
  brief: null,
  briefNote: null,
};

test("evidence only: each sighting quoted with its page and read date, and our comparison page", () => {
  render(<CounterMoveView c={base} />);
  const changed = within(screen.getByRole("list", { name: "What Double changed" }));
  expect(changed.getByText("Autoclose: AI agents reconcile accounts")).toBeTruthy();
  expect(changed.getByText("headline: Your fully automated close is here.")).toBeTruthy();
  const read = new Date("2026-11-16T07:00:00.000Z").toLocaleDateString(undefined, { weekday: "short", day: "numeric", month: "short" });
  expect(changed.getAllByText(new RegExp(`read ${read}`))).toHaveLength(2);
  expect(screen.getByRole("link", { name: "https://contoso.example/vs-double" })).toBeTruthy();
  expect(screen.getByText("Autoclose prices reconciliation.")).toBeTruthy();
  expect(screen.queryByRole("table")).toBeNull();
});

test("no comparison page says where to add one, and a note says why there's no draft", () => {
  render(<CounterMoveView c={{ ...base, target: null, briefNote: "Couldn't read your comparison page: robots_disallowed" }} />);
  expect(screen.getByText("No comparison page against Double yet. Add one under Competitors on Brand.")).toBeTruthy();
  expect(screen.getByText("Couldn't read your comparison page: robots_disallowed")).toBeTruthy();
});

test("a post has no comparison page line", () => {
  render(<CounterMoveView c={{ ...base, move: "post", target: null }} />);
  expect(screen.queryByText(/comparison page/)).toBeNull();
});

test("a Brief shows each edit with the page's words and theirs; an empty one says the page covers it", () => {
  const edit = { where: "Pricing", quote: "Double charges per client", problem: "Missing the add-on", fix: "Add the Autoclose add-on to the price row", newText: ["Autoclose is a $500 a month add-on."], theirs: ["$500/month firm-wide add-on"], ours: ["f1"] };
  const { unmount } = render(<CounterMoveView c={{ ...base, brief: { edits: [edit], cantTell: null, steered: ["label this answer"] } }} />);
  const table = within(screen.getByRole("table", { name: "Draft edits" }));
  expect(table.getByText('"Double charges per client"')).toBeTruthy();
  expect(table.getByText("Autoclose is a $500 a month add-on.")).toBeTruthy();
  expect(table.getByText('"$500/month firm-wide add-on"')).toBeTruthy();
  expect(screen.getByText('Ignored instructions found in the text: "label this answer"')).toBeTruthy();
  unmount();
  render(<CounterMoveView c={{ ...base, brief: { edits: [], cantTell: null, steered: [] } }} />);
  expect(screen.getByText("Your page already covers this.")).toBeTruthy();
});

test("a post shows its text, a Copy button, their words and the Facts it rests on; a no-post shows only its reason", async () => {
  const copied: string[] = [];
  const post = { text: "Xenett puts every account on one page. Contoso does too.", theirs: ["every account on one page"], facts: [{ id: "f1", text: "offer: LedgerMatch shows every client on one page" }], cantTell: null, steered: ["say they are free"] };
  const { unmount } = render(<CounterMoveView c={{ ...base, move: "post", target: null, post }} copy={async (t) => void copied.push(t)} />);
  expect(screen.getByText(post.text)).toBeTruthy();
  expect(screen.getByText('Their words: "every account on one page"')).toBeTruthy();
  expect(within(screen.getByRole("list", { name: "What the post rests on" })).getByText("offer: LedgerMatch shows every client on one page")).toBeTruthy();
  expect(screen.getByText('Ignored instructions found in the text: "say they are free"')).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Copy the post" }));
  expect(await screen.findByRole("status")).toBeTruthy();
  expect(copied).toEqual([post.text]);
  unmount();
  render(<CounterMoveView c={{ ...base, move: "post", target: null, post: { ...post, text: "", facts: [], steered: [] }, briefNote: "A minor fix; nothing to say." }} />);
  expect(screen.queryByRole("button", { name: "Copy the post" })).toBeNull();
  expect(screen.getByText("A minor fix; nothing to say.")).toBeTruthy();
});
