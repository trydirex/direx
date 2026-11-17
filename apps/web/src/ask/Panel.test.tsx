// SPDX-License-Identifier: AGPL-3.0-only
// The Ask panel: opened with Ctrl J or from Home, it shows the step a run is on, then the stored
// reply, and says plainly when a message didn't go.
import { afterEach, expect, test, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { api } from "../client";
import { withQueries, openDialog } from "../testing";
import type { AskMessage } from "./actions";
import { AskAbout, AskBox, AskButton, AskProvider } from "./Panel";

const W = "00000000-0000-4000-8000-0000000000aa";
const ok = (body: unknown) => Promise.resolve({ data: body, response: new Response(null, { status: 200 }) });
const refused = (status: number, error: string) => Promise.resolve({ error: { error }, response: new Response(null, { status }) });
const message = (o: Partial<AskMessage>): AskMessage => ({ id: crypto.randomUUID(), text: "What goes out this week?", itemId: null, agent: null, createdAt: new Date().toISOString(), status: "done", steps: [], reply: null, ...o });

let stored: AskMessage[] = [];
const posted: unknown[] = [];
const approved: unknown[] = [];
/** Items the cards read, by id. */
let held: Record<string, { id: string; kind: string; state: string; title: string; revision: number; content?: unknown; undo?: { ok: boolean; reason?: string } | null; timeline?: { reason: string | null }[] }> = {};
const undone: string[] = [];
/** What the undo route answers; null means it went. */
let undoRefusal: string | null = null;
/** Whether the API says Ask runs; left undefined, as an older API would, it counts as on. */
let on: boolean | undefined;
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  stored = [];
  posted.length = 0;
  approved.length = 0;
  held = {};
  on = undefined;
  undone.length = 0;
  undoRefusal = null;
});

const HELD = "00000000-0000-4000-8000-0000000000cc";
let role: "owner" | "viewer" | "contributor" = "owner";

function show(post: (body: { text: string }) => Promise<unknown> = (body) => (stored.push(message({ text: body.text, status: "working", steps: ["Reading the schedule"] })), ok({ ok: true, id: "x" })), path = "/") {
  vi.spyOn(api, "GET").mockImplementation(((path: string, o: { params: { path: { id?: string } } }) => {
    if (path === "/api/w/{workspaceId}/items/{id}") {
      const i = held[o.params.path.id!]!;
      const { content = {}, undo = null, timeline = [], ...rest } = i;
      return ok({ item: { ...rest, reason: null, warnings: [], clean: true, workArea: null, channel: null, groupKey: null, groupLabel: null, at: null, movable: true, decideBy: null, snoozedUntil: null, reasonCode: null, createdAt: new Date().toISOString() }, timeline, content, undo });
    }
    return ok({ messages: stored, on });
  }) as never);
  vi.spyOn(api, "POST").mockImplementation(((path: string, o: { body: { text: string }; params: { path: { id?: string } } }) => {
    if (path.endsWith("/undo")) return undoRefusal ? refused(409, undoRefusal) : (undone.push(o.params.path.id!), ok({ item: {} }));
    if (path.endsWith("/approve")) return (approved.push(o.body), Promise.resolve({ response: new Response(null, { status: 200 }) }));
    return (posted.push(o.body), post(o.body));
  }) as never);
  render(
    withQueries(
      <AskProvider workspaceId={W} role={role}>
        <AskButton />
        <AskBox />
        <AskAbout id={HELD} title="Spring post" />
      </AskProvider>,
      path,
    ),
  );
}

test("Ctrl J opens the panel; Enter sends, and the run's step shows until there is a reply", async () => {
  show();
  fireEvent.keyDown(window, { key: "j", ctrlKey: true });
  const panel = within(await screen.findByRole("dialog", { name: "Ask Direx" }));
  expect(within(panel.getByRole("group", { name: "Things to ask" })).getAllByRole("button").length).toBe(3);
  await userEvent.type(panel.getByLabelText("Your message"), "What goes out this week?{Enter}");
  expect(posted).toEqual([{ text: "What goes out this week?" }]);
  expect(await panel.findByText("Reading the schedule…")).toBeTruthy();
  expect((panel.getByLabelText("Your message") as HTMLTextAreaElement).value).toBe("");
  fireEvent.keyDown(window, { key: "j", metaKey: true });
  await waitFor(() => expect(openDialog("Ask Direx")).toBeNull());
});

const card = (o: { kind: string; state?: string; title: string; content?: unknown; undo?: { ok: boolean; reason?: string } }) => {
  const id = crypto.randomUUID();
  held[id] = { id, state: "needs_approval", revision: 3, ...o };
  return id;
};
const openPanel = async () => {
  await userEvent.click(screen.getByRole("button", { name: /Ask Direx/ }));
  return within(await screen.findByRole("dialog", { name: "Ask Direx" }));
};

test("a reply shows its words and a card for each Item it made or named, each opening its review", async () => {
  const send = card({ kind: "action", title: "Tuesday email" });
  const step = card({ kind: "next_step", title: "Draft the text for 2 steps" });
  stored = [message({ reply: { kind: "answer", text: "One email goes out on Tuesday.", cites: [send] } }), message({ text: "Draft the steps", reply: { kind: "next_step", text: "Here is a card to draft the steps.", itemId: step } })];
  show();
  const panel = await openPanel();
  expect(await panel.findByText("One email goes out on Tuesday.")).toBeTruthy();
  expect(await panel.findByText("Tuesday email")).toBeTruthy();
  expect(await panel.findByText("Draft the text for 2 steps")).toBeTruthy();
  // Neither has an Approve here: a send and a start each go through their own review.
  expect(panel.queryByRole("button", { name: "Approve" })).toBeNull();
  expect(panel.getAllByRole("link", { name: "Open" }).map((a) => a.getAttribute("href"))).toEqual([`/w/${W}/review/${send}`, `/w/${W}/review/${step}`]);
});

test("a move with no outside effect is approved on its card, with the revision it showed", async () => {
  const move = card({ kind: "reschedule", title: 'Move "Spring post" to 2026-11-12 09:00 UTC', content: { targetId: HELD, from: "2026-11-10T09:00:00.000Z", at: "2026-11-12T09:00:00.000Z" } });
  stored = [message({ text: "Move the spring post", reply: { kind: "reschedule", text: "Here is a card to move it.", itemId: move } })];
  show();
  const panel = await openPanel();
  // The card shows both times, so the yes is to a change the person can see.
  expect(await panel.findByText(/10 Nov/)).toBeTruthy();
  expect(panel.getByText(/12 Nov/)).toBeTruthy();
  // The title's own time, in the Workspace's zone, is left off so the card shows one zone only.
  expect(panel.getByText('Move "Spring post"')).toBeTruthy();
  expect(panel.queryByText(/2026-11-12 09:00 UTC/)).toBeNull();
  await userEvent.click(await panel.findByRole("button", { name: "Approve move" }));
  expect(approved).toEqual([{ revision: 3 }]);
});

test("someone who can't approve sees the card without Approve", async () => {
  role = "viewer";
  const move = card({ kind: "reschedule", title: "Move it" });
  stored = [message({ reply: { kind: "reschedule", text: "Card.", itemId: move } })];
  show();
  const panel = await openPanel();
  expect(await panel.findByText("Move it")).toBeTruthy();
  expect(panel.queryByRole("button", { name: "Approve move" })).toBeNull();
  role = "owner";
});

test("typing @ offers the Agents; the pick names the message's Agent", async () => {
  show();
  const panel = await openPanel();
  await userEvent.type(panel.getByLabelText("Your message"), "@ou");
  await userEvent.click(within(panel.getByRole("group", { name: "Name an Agent" })).getByRole("button", { name: "@Outreach" }));
  expect(panel.getByText("To: @Outreach")).toBeTruthy();
  await userEvent.type(panel.getByLabelText("Your message"), "Draft follow-ups{Enter}");
  expect(posted).toEqual([{ text: "Draft follow-ups", agent: "outreach" }]);
});

test("Enter or Tab on a half-typed @ picks the Agent instead of sending it", async () => {
  show();
  const panel = await openPanel();
  await userEvent.type(panel.getByLabelText("Your message"), "@so{Enter}");
  expect(posted).toEqual([]);
  expect(panel.getByText("To: @Social")).toBeTruthy();
  await userEvent.click(panel.getByRole("button", { name: "Remove Social Agent" }));
  await userEvent.type(panel.getByLabelText("Your message"), "@sa");
  await userEvent.tab();
  expect(panel.getByText("To: @Sales")).toBeTruthy();
  expect((panel.getByLabelText("Your message") as HTMLTextAreaElement).value).toBe("");
});

test("a sent message names the Item it was about, and keeps its line breaks", async () => {
  held[HELD] = { id: HELD, kind: "action", state: "needs_approval", title: "Spring post", revision: 1 };
  stored = [message({ text: "Shorter\nand warmer", itemId: HELD, reply: { kind: "answer", text: "Done.\nSee the card.", cites: [] } })];
  show();
  const panel = await openPanel();
  expect(await panel.findByText("About: Spring post")).toBeTruthy();
  expect(panel.getByText(/Shorter/).className).toContain("whitespace-pre-line");
  expect(panel.getByText(/See the card/).className).toContain("whitespace-pre-line");
});

test("Ask about this opens the panel on that Item and sends it with the message", async () => {
  show();
  await userEvent.click(screen.getByRole("button", { name: "Ask about this" }));
  const panel = within(await screen.findByRole("dialog", { name: "Ask Direx" }));
  expect(panel.getByText("About: Spring post")).toBeTruthy();
  await userEvent.type(panel.getByLabelText("Your message"), "Make it shorter{Enter}");
  expect(posted).toEqual([{ text: "Make it shorter", itemId: HELD }]);
});

test("a message that didn't go says so and keeps the words", async () => {
  show(() => refused(500, "failed"));
  fireEvent.keyDown(window, { key: "j", ctrlKey: true });
  const panel = within(await screen.findByRole("dialog", { name: "Ask Direx" }));
  await userEvent.type(panel.getByLabelText("Your message"), "Hello{Enter}");
  expect((await panel.findByRole("alert")).textContent).toBe("Ask couldn't answer that. Try rephrasing, or try again in a minute.");
  expect((panel.getByLabelText("Your message") as HTMLTextAreaElement).value).toBe("Hello");
});

test("the box on Home sends the message and opens the panel on it", async () => {
  show();
  await userEvent.type(screen.getByLabelText("Ask Direx", { selector: "textarea" }), "Why is Dana held?");
  await userEvent.click(screen.getByRole("button", { name: "Ask" }));
  const panel = within(await screen.findByRole("dialog", { name: "Ask Direx" }));
  expect(await panel.findByText("Why is Dana held?")).toBeTruthy();
  expect(posted).toEqual([{ text: "Why is Dana held?" }]);
});

test("Enter in the box on Home asks; a refusal shows in the panel and the words come back", async () => {
  show(() => refused(500, "failed"));
  const box = screen.getByLabelText("Ask Direx", { selector: "textarea" }) as HTMLTextAreaElement;
  await userEvent.type(box, "Why is Dana held?{Enter}");
  const panel = within(await screen.findByRole("dialog", { name: "Ask Direx" }));
  expect(posted).toEqual([{ text: "Why is Dana held?" }]);
  expect((await panel.findByRole("alert")).textContent).toBe("Ask couldn't answer that. Try rephrasing, or try again in a minute.");
  await waitFor(() => expect(box.value).toBe("Why is Dana held?"));
});

test("a Fact card shows the words it would add, and adds them on the card", async () => {
  const fact = card({ kind: "fact_proposal", title: "New Brand Fact", content: { field: "audience", value: "We don't work with agencies." } });
  stored = [message({ text: "Remember we don't work with agencies", reply: { kind: "fact", text: "Here it is for Brand.", itemId: fact } })];
  show();
  const panel = await openPanel();
  expect(await panel.findByText("We don't work with agencies.")).toBeTruthy();
  await userEvent.click(panel.getByRole("button", { name: "Add Fact" }));
  expect(approved).toEqual([{ revision: 3 }]);
});

test("a run shows every step so far; a reply says what it looked at; a refusal looks different", async () => {
  stored = [
    message({ text: "Why is it held?", reply: { kind: "answer", text: "It waits on you.", cites: [], looked: ["the schedule", "what needs you"] } }),
    message({ text: "Move the sent one", reply: { kind: "cannot", text: "That went out already, so it can't move." } }),
    message({ text: "And now?", status: "working", steps: ["Reading what needs you", "Reading the schedule"] }),
  ];
  show();
  const panel = await openPanel();
  expect(await panel.findByText("Looked at the schedule and what needs you")).toBeTruthy();
  expect(panel.getByText("That went out already, so it can't move.").className).toContain("bg-warning-tint");
  expect(panel.getByText("It waits on you.").className).not.toContain("bg-warning-tint");
  const steps = within(panel.getByRole("list", { name: "What Ask is doing" }));
  expect(steps.getAllByRole("listitem").map((li) => li.textContent)).toEqual(["✓ Reading what needs you", "Reading the schedule…"]);
});

test("a starter fills the box for the person to change or send; an Agent chip names the Agent", async () => {
  show();
  const panel = await openPanel();
  await userEvent.click(within(panel.getByRole("group", { name: "Things to ask" })).getByRole("button", { name: "What goes out this week?" }));
  expect((panel.getByLabelText("Your message") as HTMLTextAreaElement).value).toBe("What goes out this week?");
  expect(posted).toEqual([]);
  await userEvent.click(within(panel.getByRole("group", { name: "Agents" })).getByRole("button", { name: "Outreach" }));
  expect(panel.getByText("To: @Outreach")).toBeTruthy();
});

test("while Ask is off the panel says so up front and nothing can be sent", async () => {
  on = false;
  show();
  const panel = await openPanel();
  expect(await panel.findByText(/Ask is off until Direx finishes checking it/)).toBeTruthy();
  // Astryx disables a field with aria-disabled and read-only rather than the native attribute.
  expect(panel.getByLabelText("Your message").getAttribute("aria-disabled")).toBe("true");
  expect(panel.getByRole("button", { name: "Send" }).hasAttribute("disabled") || panel.getByRole("button", { name: "Send" }).getAttribute("aria-disabled") === "true").toBe(true);
  expect(panel.queryByRole("group", { name: "Things to ask" })).toBeNull();
});

test("outside a Workspace there is no way into Ask", () => {
  render(withQueries(<AskButton />));
  expect(screen.queryByRole("button", { name: /Ask Direx/ })).toBeNull();
});

test("a rewrite card waits for the new words, then shows what changed and the length before and after", async () => {
  const before = { subject: "Spring sale", text: "Hi Ana, our big spring sale starts Monday with twenty percent off." };
  const email = card({ kind: "action", title: "Email to Ana", content: before });
  stored = [message({ text: "Make it shorter", itemId: email, reply: { kind: "rewrite", text: "A shorter version will wait for your approval.", itemId: email, before } })];
  show();
  const panel = await openPanel();
  expect(await panel.findByText("The new version shows here once it's written.")).toBeTruthy();
  // The rewrite lands on the same Item, and the card asks again until it sees it.
  held[email]!.content = { subject: "Spring sale", text: "Hi Ana, spring sale Monday: twenty percent off." };
  expect(await panel.findByText("12 → 8 words", {}, { timeout: 5000 })).toBeTruthy();
  const changed = panel.getByLabelText("What the rewrite changed");
  expect(Array.from(changed.querySelectorAll("del")).map((d) => d.textContent?.trim())).toEqual(["our", "big", "starts", "Monday", "with"]);
  expect(Array.from(changed.querySelectorAll("ins")).map((d) => d.textContent?.trim())).toEqual(["Monday:"]);
}, 10_000);

test("a move of an approved send says it will need approval again", async () => {
  held[HELD] = { id: HELD, kind: "action", state: "scheduled", title: "Spring post", revision: 1 };
  const move = card({ kind: "reschedule", title: 'Move "Spring post" to 2026-11-12 09:00 UTC', content: { targetId: HELD, from: "2026-11-10T09:00:00.000Z", at: "2026-11-12T09:00:00.000Z" } });
  stored = [message({ text: "Move the spring post", reply: { kind: "reschedule", text: "Here is a card to move it.", itemId: move } })];
  show();
  const panel = await openPanel();
  expect(await panel.findByText("It's approved to go at its current time. It will need approval again.")).toBeTruthy();
});

test("an applied move offers Undo, asks first, moves it back, then says so", async () => {
  held[HELD] = { id: HELD, kind: "action", state: "needs_approval", title: "Spring post", revision: 1 };
  const move = card({ kind: "reschedule", state: "applied", title: 'Move "Spring post" to 2026-11-12 09:00 UTC', content: { targetId: HELD, from: "2026-11-10T09:00:00.000Z", at: "2026-11-12T09:00:00.000Z" }, undo: { ok: true } });
  stored = [message({ text: "Move the spring post", reply: { kind: "reschedule", text: "Here is a card to move it.", itemId: move } })];
  show();
  const panel = await openPanel();
  await userEvent.click(await panel.findByRole("button", { name: "Undo" }));
  // Nothing moves until the person says so, and the question names the old time.
  expect(undone).toEqual([]);
  expect(panel.getByText(/^Move it back to .*10 Nov/)).toBeTruthy();
  held[move] = { ...held[move]!, undo: { ok: false, reason: "moved_since" }, timeline: [{ reason: "Undone" }] };
  await userEvent.click(panel.getByRole("button", { name: "Move it back" }));
  expect(undone).toEqual([move]);
  expect(await panel.findByText("Moved back")).toBeTruthy();
  expect(panel.queryByRole("button", { name: "Undo" })).toBeNull();
});

test("a Fact Undo says why when it can't, and someone who can't approve gets no Undo", async () => {
  const fact = card({ kind: "fact_proposal", state: "applied", title: "New Brand Fact", content: { field: "audience", value: "We don't work with agencies." }, undo: { ok: true } });
  stored = [message({ text: "Remember this", reply: { kind: "fact", text: "Here is a card to add it.", itemId: fact } })];
  undoRefusal = "edited_since";
  show();
  const panel = await openPanel();
  await userEvent.click(await panel.findByRole("button", { name: "Undo" }));
  expect(panel.getByText(/^Remove this from Brand\?/)).toBeTruthy();
  await userEvent.click(panel.getByRole("button", { name: "Remove" }));
  expect(await panel.findByText("It has been edited on Brand since, so it stays.")).toBeTruthy();
  cleanup();
  role = "viewer";
  try {
    show();
    const viewer = await openPanel();
    expect(await viewer.findByText("We don't work with agencies.")).toBeTruthy();
    expect(viewer.queryByRole("button", { name: "Undo" })).toBeNull();
  } finally {
    role = "owner";
  }
});

test("the screen goes with a message as a line the person can remove, and nothing on Home", async () => {
  const campaign = "00000000-0000-4000-8000-0000000000dd";
  show(undefined, `/w/${W}/campaigns/${campaign}`);
  const panel = await openPanel();
  expect(panel.getByText("Looking at: this Campaign")).toBeTruthy();
  await userEvent.type(panel.getByLabelText("Your message"), "Draft the text for this{Enter}");
  expect(posted).toEqual([{ text: "Draft the text for this", looking: { screen: "campaigns", campaignId: campaign } }]);
  // Removed, it stays off for the next message on this screen.
  await userEvent.click(panel.getByRole("button", { name: "Remove Looking at: this Campaign" }));
  expect(panel.queryByText(/^Looking at/)).toBeNull();
  await userEvent.type(panel.getByLabelText("Your message"), "And the other one{Enter}");
  expect(posted.at(-1)).toEqual({ text: "And the other one" });
  cleanup();
  show();
  expect((await openPanel()).queryByText(/^Looking at/)).toBeNull();
});

test("a message over the limit can't be sent, and Enter says why instead of asking the API", async () => {
  show();
  const panel = await openPanel();
  const box = panel.getByLabelText("Your message");
  // A change event, as a paste can be, isn't held to the box's maxLength.
  fireEvent.change(box, { target: { value: "x".repeat(4001) } });
  expect((panel.getByRole("button", { name: "Send" }) as HTMLButtonElement).disabled).toBe(true);
  fireEvent.keyDown(box, { key: "Enter" });
  expect(await panel.findByText("That message is too long for Ask. Keep it under 4,000 characters.")).toBeTruthy();
  expect(posted).toEqual([]);
  expect((box as HTMLTextAreaElement).value).toHaveLength(4001);
});

test("a start's card is started by someone who may edit, and the done line under it says where the work stands", async () => {
  role = "contributor";
  const start = card({ kind: "ask_start", title: 'Draft the plan "Spring"' });
  const made = card({ kind: "plan_proposal", title: "Spring plan draft", state: "needs_approval" });
  stored = [
    message({ text: "Draft the Spring plan", reply: { kind: "start", text: "Here is a card to draft it.", itemId: start } }),
    message({ text: "Brief the pricing page", reply: { kind: "start", text: "Here is a card.", itemId: crypto.randomUUID() }, done: { state: "refused", text: "It didn't start: that page and search aren't worth a brief now.", itemIds: [] } }),
    message({ text: "Read the site again", reply: { kind: "start", text: "Here is a card.", itemId: crypto.randomUUID() }, done: { state: "done", text: "Done.", itemIds: [made] } }),
  ];
  show();
  const panel = await openPanel();
  await userEvent.click(await panel.findByRole("button", { name: "Start" }));
  expect(approved).toEqual([{ revision: 3 }]);
  expect(panel.getByText("It didn't start: that page and search aren't worth a brief now.")).toBeTruthy();
  const done = panel.getAllByLabelText("Where the work stands").at(-1)!;
  expect(within(done).getByText("Done.")).toBeTruthy();
  expect(await within(done).findByText("Spring plan draft")).toBeTruthy();
  role = "owner";
});

test("typing @ offers SEO as an Agent", async () => {
  show();
  const panel = await openPanel();
  await userEvent.type(panel.getByLabelText("Your message"), "@se");
  await userEvent.click(within(panel.getByRole("group", { name: "Name an Agent" })).getByRole("button", { name: "@SEO" }));
  await userEvent.type(panel.getByLabelText("Your message"), "Brief the pricing page{Enter}");
  expect(posted).toEqual([{ text: "Brief the pricing page", agent: "seo" }]);
});
