// SPDX-License-Identifier: AGPL-3.0-only
// Import from Notion on the Calendar: offered once Notion is connected, set up by mapping columns and
// accounts, previewed row by row, then imported; a set-up database goes straight to Check again. Its
// status write-back: columns and the yes or no for an Owner or Admin only, Stop with a reason for anyone,
// and held or Blocked writes with their reasons.
import { afterEach, expect, test, vi } from "vitest";
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { api } from "../client";
import { pick, withQueries } from "../testing";
import { DocsImport, DocsWriteBack } from "./DocsImport";

const W = "00000000-0000-4000-8000-0000000000aa";
const DB = "33333333-3333-4333-8333-333333333333";
const SRC = "00000000-0000-4000-8000-0000000000ee";
const ACC = "55555555-5555-4555-8555-555555555551";
const reply = (status: number, body: unknown) => Promise.resolve({ ...(status < 400 ? { data: body } : { error: body }), response: new Response(null, { status }) });
const columns = [
  { name: "Name", type: "title", options: null },
  { name: "Date", type: "date", options: null },
  { name: "Channel", type: "select", options: ["LinkedIn", "TikTok"] },
  { name: "Caption", type: "rich_text", options: null },
  { name: "Status", id: "p-status", type: "status", options: ["Planned", "Published", "Dropped"], choices: [{ id: "o-plan", name: "Planned" }, { id: "o-pub", name: "Published" }, { id: "o-drop", name: "Dropped" }] },
  { name: "Link", id: "p-link", type: "url", options: null },
];
const plan = { rows: [{ id: "r1", title: "Launch post", outcome: "make" }, { id: "r2", title: "Teaser", outcome: "skip", reason: "no_date" }], cut: false };

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

function serve(o: { connected?: boolean; signIn?: string | null; sourceId?: string | null; mapping?: unknown; writeBack?: unknown } = {}) {
  vi.spyOn(api, "GET").mockImplementation(((path: string) => {
    if (path === "/api/w/{workspaceId}/docs") return reply(200, { provider: "Notion", connected: o.connected ?? true, imports: true, signIn: o.signIn ?? null });
    if (path === "/api/w/{workspaceId}/social/accounts") return reply(200, { accounts: [{ id: ACC, name: "Sam", network: "LinkedIn" }] });
    if (path === "/api/w/{workspaceId}/docs/databases") return reply(200, { databases: [{ id: DB, title: "Content calendar", editedAt: null, sourceId: o.sourceId ?? null }] });
    if (path === "/api/w/{workspaceId}/docs/databases/{databaseId}") return reply(200, { title: "Content calendar", columns, sourceId: o.sourceId ?? null, mapping: o.mapping ?? null });
    if (path === "/api/w/{workspaceId}/docs/sources/{sourceId}/write-back") return reply(200, o.writeBack);
    return reply(404, { error: "not_found" });
  }) as never);
  const put = vi.spyOn(api, "PUT").mockImplementation((() => reply(200, { sourceId: SRC })) as never);
  const post = vi.spyOn(api, "POST").mockImplementation(((path: string) => reply(200, path.endsWith("/preview") ? plan : { made: 1, updated: 0, changed: 0, skipped: [{ id: "r2", title: "Teaser", reason: "no_date" }], cut: false })) as never);
  return { put, post };
}

test("not connected, there is no Import from Notion", async () => {
  serve({ connected: false });
  render(withQueries(<DocsImport workspaceId={W} onDone={() => {}} />));
  await waitFor(() => expect(vi.mocked(api.GET)).toHaveBeenCalled());
  expect(screen.queryByRole("button", { name: "Import from Notion" })).toBeNull();
});

test("not connected where Notion connects by signing in, Connect Notion opens Notion's consent page, or says why not", async () => {
  const { post } = serve({ connected: false, signIn: "notion_oauth" });
  const assign = vi.spyOn(window.location, "assign").mockImplementation(() => {});
  post.mockImplementation((() => reply(200, { url: "https://api.notion.com/v1/oauth/authorize?owner=user" })) as never);
  render(withQueries(<DocsImport workspaceId={W} onDone={() => {}} />));
  await userEvent.click(await screen.findByRole("button", { name: "Connect Notion" }));
  expect(post).toHaveBeenCalledWith("/api/w/{workspaceId}/connections/{connection}/start", { params: { path: { workspaceId: W, connection: "notion_oauth" } } });
  await waitFor(() => expect(assign).toHaveBeenCalledWith("https://api.notion.com/v1/oauth/authorize?owner=user"));
  expect(screen.queryByRole("button", { name: "Import from Notion" })).toBeNull();
  post.mockImplementation((() => reply(404, { error: "unknown_connection" })) as never);
  await userEvent.click(screen.getByRole("button", { name: "Connect Notion" }));
  expect((await screen.findByRole("alert")).textContent).toMatch(/\S/);
  expect(assign).toHaveBeenCalledTimes(1);
});

test("a database is set up by its columns and accounts, previewed, then imported", async () => {
  const { put, post } = serve();
  const done = vi.fn();
  render(withQueries(<DocsImport workspaceId={W} onDone={done} />));
  await userEvent.click(await screen.findByRole("button", { name: "Import from Notion" }));
  const dialog = within(await screen.findByRole("dialog", { name: "Import from Notion" }));
  await userEvent.click(await dialog.findByRole("button", { name: "Set up" }));
  await pick(await dialog.findByRole("combobox", { name: "LinkedIn posts as" }), "Sam (LinkedIn)");
  await userEvent.click(dialog.getByRole("button", { name: "Save and preview" }));
  expect(put).toHaveBeenCalledWith("/api/w/{workspaceId}/docs/databases/{databaseId}/mapping", { params: { path: { workspaceId: W, databaseId: DB } }, body: { date: "Date", channel: "Channel", text: { column: "Caption" }, accounts: { LinkedIn: ACC } } });
  expect(await dialog.findByText("1 post to make, 0 to update, 0 changed after you edited them here, 1 skipped.")).toBeTruthy();
  expect(dialog.getByText("Teaser: No date")).toBeTruthy();
  await userEvent.click(dialog.getByRole("button", { name: "Import" }));
  expect(post).toHaveBeenCalledWith("/api/w/{workspaceId}/docs/sources/{sourceId}/import", { params: { path: { workspaceId: W, sourceId: SRC } } });
  expect(await dialog.findByText(/1 post made, 0 updated, 0 changed in Notion/)).toBeTruthy();
  expect(done).toHaveBeenCalled();
});

test("a set-up database goes straight to Check again; a refused mapping says why and keeps the form", async () => {
  serve({ sourceId: SRC, mapping: { date: "Date", channel: "Channel", text: { page: true }, accounts: { LinkedIn: ACC } } });
  render(withQueries(<DocsImport workspaceId={W} onDone={() => {}} />));
  await userEvent.click(await screen.findByRole("button", { name: "Import from Notion" }));
  const dialog = within(await screen.findByRole("dialog", { name: "Import from Notion" }));
  await userEvent.click(await dialog.findByRole("button", { name: "Check again" }));
  expect(await dialog.findByText(/1 post to make/)).toBeTruthy();
  cleanup();

  serve({ sourceId: SRC, mapping: { date: "Date", channel: "Channel", text: { page: true }, accounts: {} } });
  vi.mocked(api.PUT).mockImplementation((() => reply(409, { error: "unknown_account" })) as never);
  render(withQueries(<DocsImport workspaceId={W} onDone={() => {}} />));
  await userEvent.click(await screen.findByRole("button", { name: "Import from Notion" }));
  const again = within(await screen.findByRole("dialog", { name: "Import from Notion" }));
  await userEvent.click(await again.findByRole("button", { name: "Change columns" }));
  await pick(await again.findByRole("combobox", { name: "Post text" }), "Caption");
  await userEvent.click(again.getByRole("button", { name: "Save and preview" }));
  expect(await again.findByText("An account isn't connected any more. Pick the accounts again.")).toBeTruthy();
  expect(again.getByRole("button", { name: "Save and preview" })).toBeTruthy();
});

const WB = { statusPropertyId: "p-status", statusType: "status", options: { scheduled: "o-plan", sent: "o-pub" }, urlPropertyId: "p-link" };
const WORDING = "Let Direx update these rows' status in your docs tool?\n\nWrites reach everyone who uses this database.";
const YES = { id: "00000000-0000-4000-8000-0000000000f1", answer: "yes", wordingVersion: "2026-11-14", answeredBy: "00000000-0000-4000-8000-0000000000f2", answeredAt: "2026-11-14T10:00:00.000Z", stoppedBy: null, stoppedAt: null, stopReason: null };
const wb = (o: Record<string, unknown> = {}) => ({ status: "unanswered", wordingVersion: "2026-11-14", wording: WORDING, mayAnswer: true, writeBack: null, grant: null, writes: [], ...o });
const wbPath = "/api/w/{workspaceId}/docs/sources/{sourceId}/write-back";
const at = { params: { path: { workspaceId: W, sourceId: SRC } } };

async function openWriteBack(state: unknown) {
  const calls = serve({ sourceId: SRC, writeBack: state });
  render(withQueries(<DocsImport workspaceId={W} onDone={() => {}} />));
  await userEvent.click(await screen.findByRole("button", { name: "Import from Notion" }));
  const dialog = within(await screen.findByRole("dialog", { name: "Import from Notion" }));
  await userEvent.click(await dialog.findByRole("button", { name: "Status write-back" }));
  return { ...calls, panel: within(await dialog.findByRole("region", { name: "Status write-back" })) };
}

test("an Owner or Admin saves the status columns by id, then answers yes; neither answer starts chosen", async () => {
  const { put, post, panel } = await openWriteBack(wb());
  put.mockImplementation((() => reply(200, wb({ writeBack: WB }))) as never);
  post.mockImplementation((() => reply(200, wb({ status: "on", writeBack: WB, grant: YES }))) as never);
  expect(panel.getByText("Status write-back is off. No one has answered yet.")).toBeTruthy();
  // No columns saved yet, so no question.
  expect(panel.queryByRole("radio")).toBeNull();
  await pick(panel.getByRole("combobox", { name: "Status column" }), "Status");
  await pick(await panel.findByRole("combobox", { name: "Scheduled shows as" }), "Planned");
  await pick(panel.getByRole("combobox", { name: "Sent shows as" }), "Published");
  await pick(panel.getByRole("combobox", { name: "Post link column" }), "Link");
  await userEvent.click(panel.getByRole("button", { name: "Save status columns" }));
  expect(put).toHaveBeenCalledWith(wbPath, { ...at, body: WB });

  expect(await panel.findByText("Writes reach everyone who uses this database.")).toBeTruthy();
  const [yes, no] = [panel.getByRole("radio", { name: "Yes" }), panel.getByRole("radio", { name: "No" })];
  expect([(yes as HTMLInputElement).checked, (no as HTMLInputElement).checked]).toEqual([false, false]);
  expect(panel.getByRole("button", { name: "Save answer" }).hasAttribute("disabled")).toBe(true);
  await userEvent.click(yes);
  await userEvent.click(panel.getByRole("button", { name: "Save answer" }));
  expect(post).toHaveBeenCalledWith(`${wbPath}/grant`, { ...at, body: { answer: "yes", wordingVersion: "2026-11-14" } });
  expect(await panel.findByText("Status write-back is on.")).toBeTruthy();
  expect(panel.queryByRole("radio")).toBeNull();
});

test("a member without rule.grant reads the columns, with no question and nothing to save", async () => {
  const { put, post, panel } = await openWriteBack(wb({ mayAnswer: false, writeBack: WB }));
  expect(panel.getByText("Writes to Status: Scheduled as Planned, Sent as Published, Cancelled as not written. Post link: Link. Only an Owner or Admin can change this.")).toBeTruthy();
  expect(panel.queryByRole("combobox")).toBeNull();
  expect(panel.queryByRole("radio")).toBeNull();
  expect(panel.queryByText("Writes reach everyone who uses this database.")).toBeNull();
  expect(panel.queryByRole("button", { name: "Save status columns" })).toBeNull();
  expect(panel.queryByRole("button", { name: "Stop status write-back" })).toBeNull();
  expect(put).not.toHaveBeenCalledWith(wbPath, expect.anything());
  expect(post).not.toHaveBeenCalled();
});

test("anyone stops a yes, and only with a reason", async () => {
  const { post, panel } = await openWriteBack(wb({ status: "on", mayAnswer: false, writeBack: WB, grant: YES }));
  post.mockImplementation((() => reply(200, { cancelled: 2, state: wb({ status: "stopped", mayAnswer: false, writeBack: WB, grant: { ...YES, stoppedAt: "2026-11-14T11:00:00.000Z", stopReason: "Wrong database" } }) })) as never);
  const stop = panel.getByRole("button", { name: "Stop status write-back" });
  expect(stop.hasAttribute("disabled")).toBe(true);
  await userEvent.type(panel.getByRole("textbox", { name: "Why stop it?" }), "   ");
  expect(stop.hasAttribute("disabled")).toBe(true);
  await userEvent.type(panel.getByRole("textbox", { name: "Why stop it?" }), "Wrong database");
  await userEvent.click(stop);
  expect(post).toHaveBeenCalledWith(`${wbPath}/stop`, { ...at, body: { reason: "Wrong database" } });
  expect(await panel.findByText('Status write-back is off: stopped, "Wrong database".')).toBeTruthy();
});

test("held and Blocked write-backs show on the source with their reasons in words", async () => {
  const item = "00000000-0000-4000-8000-0000000000c1";
  const writes = [
    { rowId: "r1", itemId: item, state: "held", reason: "docs_write_not_granted", detail: null },
    { rowId: "r2", itemId: item, state: "blocked", reason: "provider_refused_permanently", detail: "changed_in_source" },
    { rowId: "r3", itemId: item, state: "blocked", reason: "superseded", detail: null },
  ];
  const { panel } = await openWriteBack(wb({ status: "mapping_changed", writeBack: WB, grant: YES, writes }));
  expect(panel.getByText(/paused: the status columns or the Notion connection changed/)).toBeTruthy();
  const list = within(panel.getByRole("list", { name: "Write-backs not written" }));
  expect(list.getAllByRole("listitem").map((li) => li.textContent)).toEqual([
    "Held: status write-back is off for this database. Open the post",
    "Blocked: someone changed the status in Notion, so Direx left it. Open the post",
    "Blocked: a newer status replaced it. Open the post",
  ]);
  expect(list.getAllByRole("link", { name: "Open the post" })[0]!.getAttribute("href")).toBe(`/w/${W}/review/${item}`);
});

test("refusals say why and keep the step", async () => {
  const { put, post, panel } = await openWriteBack(wb({ writeBack: WB, status: "no", grant: { ...YES, answer: "no" } }));
  expect(panel.getByText("Status write-back is off: the answer was no.")).toBeTruthy();
  post.mockImplementation((() => reply(409, { error: "stale_wording" })) as never);
  await userEvent.click(panel.getByRole("radio", { name: "No" }));
  await userEvent.click(panel.getByRole("button", { name: "Save answer" }));
  expect(await screen.findByText("The question changed. Read it again and answer.")).toBeTruthy();
  expect(panel.getByRole("button", { name: "Save answer" })).toBeTruthy();

  put.mockImplementation((() => reply(409, { error: "unknown_option" })) as never);
  await pick(panel.getByRole("combobox", { name: "Sent shows as" }), "Dropped");
  await userEvent.click(panel.getByRole("button", { name: "Save status columns" }));
  expect(await screen.findByText("An option isn't in the status column any more. Pick the options again.")).toBeTruthy();

  put.mockImplementation((() => reply(403, { error: "forbidden" })) as never);
  await userEvent.click(panel.getByRole("button", { name: "Save status columns" }));
  expect(await screen.findByText("Only an Owner or Admin can do that.")).toBeTruthy();
});

test("a viewer reaches each source's state from the Calendar and stops a yes with a reason; no columns, question or import", async () => {
  const on = { id: SRC, title: "Content calendar", state: wb({ status: "on", mayAnswer: false, writeBack: WB, grant: YES }) };
  vi.spyOn(api, "GET").mockImplementation(((path: string) => (path === "/api/w/{workspaceId}/docs/sources" ? reply(200, { sources: [on] }) : reply(404, { error: "not_found" }))) as never);
  const post = vi.spyOn(api, "POST").mockImplementation((() => reply(200, { cancelled: 1, state: wb({ status: "stopped", mayAnswer: false, writeBack: WB, grant: { ...YES, stoppedAt: "2026-11-14T11:00:00.000Z", stopReason: "Wrong database" } }) })) as never);
  render(withQueries(<DocsWriteBack workspaceId={W} />));
  await userEvent.click(await screen.findByRole("button", { name: "Status write-back" }));
  const dialog = within(await screen.findByRole("dialog", { name: "Status write-back" }));
  await userEvent.click(dialog.getByRole("button", { name: "Open" }));
  const panel = within(dialog.getByRole("region", { name: "Status write-back" }));
  expect(panel.getByText("Status write-back is on.")).toBeTruthy();
  expect(panel.queryByRole("combobox")).toBeNull();
  expect(panel.queryByRole("radio")).toBeNull();
  expect(panel.queryByText("Writes reach everyone who uses this database.")).toBeNull();
  expect(screen.queryByRole("button", { name: /Import|Check again|Set up/ })).toBeNull();
  const stop = panel.getByRole("button", { name: "Stop status write-back" });
  expect(stop.hasAttribute("disabled")).toBe(true);
  await userEvent.type(panel.getByRole("textbox", { name: "Why stop it?" }), "Wrong database");
  await userEvent.click(stop);
  expect(post).toHaveBeenCalledWith(`${wbPath}/stop`, { ...at, body: { reason: "Wrong database" } });
  expect(await panel.findByText('Status write-back is off: stopped, "Wrong database".')).toBeTruthy();
  // Only the Direx list was read: nothing reached Notion's databases.
  expect(vi.mocked(api.GET)).not.toHaveBeenCalledWith("/api/w/{workspaceId}/docs/databases", expect.anything());
});

test("with no yes on, there is no Status write-back button", async () => {
  vi.spyOn(api, "GET").mockImplementation((() => reply(200, { sources: [{ id: SRC, title: "Content calendar", state: wb({ mayAnswer: false }) }] })) as never);
  render(withQueries(<DocsWriteBack workspaceId={W} />));
  await waitFor(() => expect(vi.mocked(api.GET)).toHaveBeenCalled());
  expect(screen.queryByRole("button", { name: "Status write-back" })).toBeNull();
});
