// SPDX-License-Identifier: AGPL-3.0-only
// Brand loads through the query layer: a loading state first, then the facts, and an error panel
// with Retry when the facts can't be read.
import { afterEach, expect, test, vi } from "vitest";
import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { api } from "../client";
import { withQueries } from "../testing";
import { Brand } from "./Brand";

const W = "00000000-0000-4000-8000-0000000000aa";
const reply = (status: number, body: unknown) => Promise.resolve({ ...(status < 400 ? { data: body } : { error: body }), response: new Response(null, { status }) });

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

/** The facts call answers with `facts`; Item lists are empty; anything else is not found. */
function serve(facts: () => Promise<unknown>) {
  vi.spyOn(api, "GET").mockImplementation(((path: string) => {
    if (path === "/api/w/{workspaceId}/facts") return facts();
    if (path === "/api/w/{workspaceId}/items") return reply(200, { items: [] });
    if (path === "/api/w/{workspaceId}/lessons") return reply(200, { lessons: [] });
    return reply(404, { error: "not_found" });
  }) as never);
}

test("Brand shows a loading state, then the facts with their source", async () => {
  serve(() => reply(200, { facts: [{ id: "f1", field: "tone", subject: "", value: "Plain and direct.", version: 1, source: { kind: "website", label: "/about" }, confidence: "high", usable: true }] }));
  render(withQueries(<Brand workspaceId={W} role="marketer" />));
  expect(screen.getAllByRole("status").some((s) => s.textContent === "Loading")).toBe(true);
  expect(await screen.findByText("Plain and direct.")).toBeTruthy();
  await userEvent.click(screen.getByRole("button", { name: "Open Tone" }));
  expect(screen.getByText("From /about")).toBeTruthy();
});

test("when the facts can't be read, Brand says so and Retry reads them again", async () => {
  let fail = true;
  serve(() => (fail ? reply(403, { error: "forbidden" }) : reply(200, { facts: [] })));
  render(withQueries(<Brand workspaceId={W} role="marketer" />));
  expect((await screen.findByRole("alert")).textContent).toContain("Your role doesn't allow that.");
  fail = false;
  await userEvent.click(screen.getByRole("button", { name: "Retry" }));
  // Six empty facts in the list, and the one open on the right says what to do.
  expect((await screen.findAllByText("Not set.")).length).toBe(6);
  expect(screen.getByText("Not set. Add it so drafts can use it.")).toBeTruthy();
});

const fact = (o: Record<string, unknown>) => ({ id: "f1", field: "tone", subject: "", value: "Plain and direct.", version: 4, source: { kind: "person", label: "Ana" }, confidence: "high", usable: true, ...o });
const item = (o: Record<string, unknown>) => ({ id: "i1", kind: "fact_proposal", revision: 2, title: "Tone: Warm", warnings: [], ...o });
const at = { params: { path: { workspaceId: W } } };

/** Facts, waiting Items and a fact's history answer from the lists given; POST answers `code` (null is OK). */
const v3 = { version: 3, value: "Old tone.", source: { kind: "website", label: "/home" }, at: "2026-10-01T00:00:00.000Z" };
const v4 = { version: 4, value: "Plain and direct.", source: { kind: "person", label: "Ana" }, at: "2026-10-02T00:00:00.000Z" };
function serveAll(o: { facts?: unknown[]; items?: unknown[]; code?: string | null; versions?: unknown[] }) {
  vi.spyOn(api, "GET").mockImplementation(((path: string) => {
    if (path === "/api/w/{workspaceId}/facts") return reply(200, { facts: o.facts ?? [] });
    if (path === "/api/w/{workspaceId}/items") return reply(200, { items: o.items ?? [] });
    if (path === "/api/w/{workspaceId}/facts/{id}/versions") return reply(200, { versions: o.versions ?? [v3, v4] });
    return reply(404, { error: "not_found" });
  }) as never);
  return vi.spyOn(api, "POST").mockImplementation((() => (o.code ? reply(409, { error: o.code }) : reply(200, {}))) as never);
}
const region = (name: string) => within(screen.getByRole("region", { name }));

test("a marketer edits a fact with its version, can cancel, and sees History", async () => {
  const post = serveAll({ facts: [fact({})] });
  render(withQueries(<Brand workspaceId={W} role="marketer" />));
  await screen.findByText("Plain and direct.");
  await userEvent.click(screen.getByRole("button", { name: "Open Tone" }));
  expect(screen.getByText("Added by Ana")).toBeTruthy();
  await userEvent.click(region("Tone").getByRole("button", { name: "Edit: Plain and direct." }));
  await userEvent.click(region("Tone").getByRole("button", { name: "Cancel" }));
  await userEvent.click(region("Tone").getByRole("button", { name: "Edit: Plain and direct." }));
  const box = region("Tone").getByLabelText("Tone");
  await userEvent.clear(box);
  await userEvent.type(box, "Warm.");
  await userEvent.click(region("Tone").getByRole("button", { name: "Save" }));
  expect(post).toHaveBeenCalledWith("/api/w/{workspaceId}/facts", { ...at, body: { field: "tone", subject: undefined, value: "Warm.", expectedVersion: 4 } });
  await userEvent.click(region("Tone").getByText("History"));
  expect(await region("Tone").findByText(/Old tone\. \(From \/home,/)).toBeTruthy();
  // The version shown above isn't listed again as an earlier one.
  expect(region("Tone").queryByText(/Plain and direct\. \(Added by Ana,/)).toBeNull();
});

test("History of a fact with one version says there are no earlier ones, and a long value wraps", async () => {
  serveAll({ facts: [fact({ value: "x".repeat(300) })], versions: [{ ...v4, value: "x".repeat(300) }] });
  render(withQueries(<Brand workspaceId={W} role="marketer" />));
  await userEvent.click(await screen.findByRole("button", { name: "Open Tone" }));
  expect(region("Tone").getByText("x".repeat(300)).className).toContain("wrap-break-word");
  await userEvent.click(region("Tone").getByText("History"));
  expect(await region("Tone").findByText("No earlier versions.")).toBeTruthy();
});

test("a value over the limit is refused with the limit", async () => {
  serveAll({ facts: [fact({})], code: "value_too_long" });
  render(withQueries(<Brand workspaceId={W} role="marketer" />));
  await userEvent.click(await screen.findByRole("button", { name: "Open Tone" }));
  await userEvent.click(region("Tone").getByRole("button", { name: "Edit: Plain and direct." }));
  await userEvent.click(region("Tone").getByRole("button", { name: "Save" }));
  expect(await region("Tone").findByText("That's too long. A fact takes up to 1,000 characters.")).toBeTruthy();
});

test("a fact that needs a decision opens the decision", async () => {
  serveAll({ facts: [fact({ usable: false })], items: [item({ id: "c1", kind: "fact_conflict", title: "Tone: needs a decision" })] });
  render(withQueries(<Brand workspaceId={W} role="marketer" />));
  await userEvent.click(await screen.findByRole("button", { name: "Open Tone" }));
  await userEvent.click(region("Tone").getByRole("button", { name: "See the decision" }));
  expect(screen.getByRole("button", { name: "Keep the current one for Tone: needs a decision" })).toBeTruthy();
});

test("a marketer retires a fact, and a refusal is shown", async () => {
  const post = serveAll({ facts: [fact({ usable: false })], code: "stale" });
  render(withQueries(<Brand workspaceId={W} role="marketer" />));
  expect(await screen.findByText("Needs a decision")).toBeTruthy();
  await userEvent.click(screen.getByRole("button", { name: "Open Tone" }));
  await userEvent.click(screen.getByRole("button", { name: "Remove Plain and direct." }));
  await userEvent.click(await screen.findByRole("button", { name: "Remove" }));
  expect(post).toHaveBeenCalledWith("/api/w/{workspaceId}/facts/{id}/retire", { params: { path: { workspaceId: W, id: "f1" } } });
  expect(await screen.findByText("Someone else changed this just now. Try again.")).toBeTruthy();
});

test("a marketer sets an empty field and adds a price for something", async () => {
  const post = serveAll({ facts: [fact({ id: "p1", field: "price", subject: "per audit", value: "$500" })] });
  render(withQueries(<Brand workspaceId={W} role="marketer" />));
  expect(await screen.findByText(/per audit: \$500/)).toBeTruthy();
  await userEvent.click(screen.getByRole("button", { name: "Open Who buys" }));
  await userEvent.type(region("Who buys").getByLabelText("Who buys"), "Shops");
  await userEvent.click(region("Who buys").getByRole("button", { name: "Save" }));
  expect(post).toHaveBeenCalledWith("/api/w/{workspaceId}/facts", { ...at, body: { field: "who_buys", value: "Shops" } });
  await userEvent.click(screen.getByRole("button", { name: "Open Prices" }));
  await userEvent.type(region("Prices").getByLabelText("For"), "per site");
  await userEvent.type(region("Prices").getByLabelText("Price"), "$900");
  await userEvent.click(region("Prices").getByRole("button", { name: "Add" }));
  expect(post).toHaveBeenLastCalledWith("/api/w/{workspaceId}/facts", { ...at, body: { field: "price", subject: "per site", value: "$900" } });
  await vi.waitFor(() => expect((region("Prices").getByLabelText("Price") as HTMLInputElement).value).toBe(""));
});

test("a Contributor's change is a suggestion, with no Remove", async () => {
  const post = serveAll({ facts: [fact({})] });
  render(withQueries(<Brand workspaceId={W} role="contributor" />));
  await screen.findByText("Plain and direct.");
  expect(screen.queryByRole("button", { name: /^Remove/ })).toBeNull();
  await userEvent.click(screen.getByRole("button", { name: "Open Approved claims" }));
  await userEvent.type(region("Approved claims").getByLabelText("New claim"), "Fast");
  await userEvent.click(region("Approved claims").getByRole("button", { name: "Add" }));
  expect(post).toHaveBeenCalledWith("/api/w/{workspaceId}/facts/proposals", { ...at, body: { field: "claim", subject: undefined, value: "Fast" } });
  await userEvent.click(screen.getByRole("button", { name: "Open Tone" }));
  await userEvent.click(region("Tone").getByRole("button", { name: "Suggest a change: Plain and direct." }));
  expect(region("Tone").getByLabelText("Tone")).toBeTruthy();
});

test("a Contributor is told every role that may decide a proposal", async () => {
  serveAll({ items: [item({})] });
  render(withQueries(<Brand workspaceId={W} role="contributor" />));
  expect(await screen.findByText("An Owner, Admin or Marketer decides this.")).toBeTruthy();
});

test("a conflict is settled with each choice, and a proposal is accepted or dismissed", async () => {
  const post = serveAll({
    items: [item({ id: "c1", kind: "fact_conflict", title: "Tone conflict", warnings: [{ text: "Two tones." }] }), item({ id: "p1", warnings: [{ text: "From /about" }] })],
  });
  render(withQueries(<Brand workspaceId={W} role="owner" />));
  const conflict = within(await screen.findByRole("group", { name: "Tone conflict" }));
  expect(conflict.getByText("Two tones.")).toBeTruthy();
  for (const [name, choice] of [["Keep the current one for Tone conflict", "keep"], ["Use the new one for Tone conflict", "use_new"], ["Don't mention Tone conflict", "remove"]]) {
    await userEvent.click(conflict.getByRole("button", { name }));
    expect(post).toHaveBeenLastCalledWith("/api/w/{workspaceId}/items/{id}/approve", { params: { path: { workspaceId: W, id: "c1" } }, body: { revision: 2, choice } });
  }
  await userEvent.click(screen.getByRole("button", { name: "Open Tone: Warm" }));
  const proposal = within(screen.getByRole("group", { name: "Tone: Warm" }));
  expect(proposal.getByRole("listitem").textContent).toBe("From /about");
  await userEvent.click(proposal.getByRole("button", { name: "Accept Tone: Warm" }));
  expect(post).toHaveBeenLastCalledWith("/api/w/{workspaceId}/items/{id}/approve", { params: { path: { workspaceId: W, id: "p1" } }, body: { revision: 2 } });
  await userEvent.click(proposal.getByRole("button", { name: "Dismiss Tone: Warm" }));
  expect(post).toHaveBeenLastCalledWith("/api/w/{workspaceId}/items/{id}/cancel", { params: { path: { workspaceId: W, id: "p1" } } });
});

test("each fact's buttons name the fact, so two rows can be told apart", async () => {
  serveAll({ facts: [fact({}), fact({ id: "f2", field: "claim", value: "Fast" })] });
  render(withQueries(<Brand workspaceId={W} role="owner" />));
  await userEvent.click(await screen.findByRole("button", { name: "Open Tone" }));
  expect(screen.getByRole("button", { name: "Remove Plain and direct." })).toBeTruthy();
  expect(screen.getByRole("button", { name: "Edit: Plain and direct." })).toBeTruthy();
  await userEvent.click(screen.getByRole("button", { name: "Open Approved claims" }));
  expect(screen.getByRole("button", { name: "Remove Fast" })).toBeTruthy();
  expect(screen.getByRole("button", { name: "Edit: Fast" })).toBeTruthy();
});

test("the list runs from what we say, to how we sound, to the market, and opens one part at a time", async () => {
  serve(() => reply(200, { facts: [] }));
  render(withQueries(<Brand workspaceId={W} role="marketer" />));
  await screen.findAllByText("Not set.");
  const order = screen.getAllByRole("region").map((r) => r.getAttribute("aria-label"));
  const at = (name: string) => order.indexOf(name);
  expect(at("How we sound")).toBeGreaterThan(at("What we say"));
  expect(at("Market")).toBeGreaterThan(at("How we sound"));
  expect(screen.getByRole("button", { name: "Open What you sell" }).getAttribute("aria-current")).toBe("true");
  expect(screen.queryByRole("region", { name: "Tone" })).toBeNull();
});

test("Lessons sit under How we sound, and their old link opens Brand on them", async () => {
  serve(() => reply(200, { facts: [] }));
  render(withQueries(<Brand workspaceId={W} role="marketer" open="lessons" />));
  await screen.findByText("No lessons yet");
  const sound = screen.getByRole("region", { name: "How we sound" });
  expect(within(sound).getByRole("button", { name: "Open Lessons" }).getAttribute("aria-current")).toBe("true");
  expect(screen.getByRole("heading", { name: "Lessons" })).toBeTruthy();
});

test("a refused edit keeps the form open with what was typed", async () => {
  serveAll({ facts: [fact({})], code: "stale" });
  render(withQueries(<Brand workspaceId={W} role="marketer" />));
  await userEvent.click(await screen.findByRole("button", { name: "Open Tone" }));
  await userEvent.click(region("Tone").getByRole("button", { name: "Edit: Plain and direct." }));
  const box = region("Tone").getByLabelText("Tone");
  await userEvent.clear(box);
  await userEvent.type(box, "Warm.");
  await userEvent.click(region("Tone").getByRole("button", { name: "Save" }));
  expect(await region("Tone").findByText("Someone else changed this just now. Try again.")).toBeTruthy();
  expect((region("Tone").getByLabelText("Tone") as HTMLTextAreaElement).value).toBe("Warm.");
});

test("a refused add keeps what was typed", async () => {
  serveAll({ facts: [], code: "stale" });
  render(withQueries(<Brand workspaceId={W} role="marketer" />));
  await userEvent.click(await screen.findByRole("button", { name: "Open Never say" }));
  await userEvent.type(region("Never say").getByLabelText("Word or phrase"), "cheap");
  await userEvent.click(region("Never say").getByRole("button", { name: "Add" }));
  expect(await region("Never say").findByText("Someone else changed this just now. Try again.")).toBeTruthy();
  expect((region("Never say").getByLabelText("Word or phrase") as HTMLInputElement).value).toBe("cheap");
});

test("What we say counts the parts that are set, and an empty one says what the gap costs", async () => {
  serveAll({ facts: [fact({ field: "what_you_sell", value: "Bookkeeping" }), fact({ id: "f2", field: "claim", value: "Fast" })] });
  render(withQueries(<Brand workspaceId={W} role="marketer" />));
  await screen.findByText("2 of 5 set");
  expect(region("What we say").getByText("2 of 5 set")).toBeTruthy();
  await userEvent.click(screen.getByRole("button", { name: "Open Prices" }));
  expect(region("Prices").getByText("Not set. Until you add one, Direx can't check a price in a draft against yours.")).toBeTruthy();
  await userEvent.click(screen.getByRole("button", { name: "Open Never say" }));
  expect(region("Never say").getByText("Not set. Until you add some, Direx flags no words in drafts.")).toBeTruthy();
});
