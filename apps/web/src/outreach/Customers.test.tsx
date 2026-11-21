// SPDX-License-Identifier: AGPL-3.0-only
// Customers: the import is for editors only and posts the CSV, its result names every row left out
// and why, a refusal reads in plain words, and the list or its empty state shows for every role.
import { afterEach, expect, test, vi } from "vitest";
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { api } from "../client";
import { withQueries } from "../testing";
import { dayWords } from "../campaigns/actions";
import { Customers } from "./Customers";

const W = "00000000-0000-4000-8000-0000000000aa";
const reply = (status: number, body: unknown) => Promise.resolve({ ...(status < 400 ? { data: body } : { error: body }), response: new Response(null, { status }) });
const kim = { personId: "00000000-0000-4000-8000-000000000001", email: "kim@example.com", name: "Kim", company: "Acme", addedAt: "2026-11-20T10:00:00.000Z", basis: "consent", evidence: "Customer import: opted in on 2026-01-02", basisRecordedAt: "2026-11-20T10:00:00.000Z" };
const REASONS: [string, string][] = [
  ["no_opt_in", "Not added: no opt-in recorded"],
  ["invalid_email", "Not added: not a valid email address"],
  ["suppressed", "Not added: this address asked not to be contacted"],
  ["bad_opt_in_date", "Not added: the opt-in date isn't a date (use YYYY-MM-DD)"],
  ["no_country", "Not added: no country, and none on record"],
  ["bad_country", "Not added: the country isn't a two-letter code"],
  ["too_long", "Not added: a value is too long"],
  ["wrong_column_count", "Not added: this row has the wrong number of columns"],
];

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

function serve(customers: unknown[], post: () => Promise<unknown> = () => reply(200, { added: [], updated: [], skipped: [] })) {
  vi.spyOn(api, "GET").mockImplementation(((path: string) => (path === "/api/w/{workspaceId}/customers" ? reply(200, { customers }) : reply(404, { error: "not_found" }))) as never);
  return vi.spyOn(api, "POST").mockImplementation(post as never);
}

test("a Viewer sees the Customers and what they are, but no import", async () => {
  serve([kim]);
  render(withQueries(<Customers workspaceId={W} canEdit={false} />));
  const row = within(await screen.findByRole("table", { name: "Customers" })).getByText("kim@example.com").closest("tr")!;
  expect(row.textContent).toBe(`Kimkim@example.comAcme${dayWords("2026-11-20")}`);
  expect(screen.getByRole("heading", { level: 2, name: "Customers" })).toBeTruthy();
  expect(screen.getByText("People who pay you and opted in to hear from you. They get your release emails, never cold email.")).toBeTruthy();
  expect(screen.queryByRole("form", { name: "Import Customers" })).toBeNull();
  expect(screen.queryByRole("button", { name: "Import Customers" })).toBeNull();
});

test("with no Customers the list says so", async () => {
  serve([]);
  render(withQueries(<Customers workspaceId={W} canEdit />));
  expect((await screen.findByText("No Customers yet.")).closest("[role=status]")?.textContent).toContain("Import a CSV of them above.");
  expect(screen.queryByRole("table", { name: "Customers" })).toBeNull();
});

test("an editor imports a pasted CSV and sees what was added, updated and left out, each with its reason", async () => {
  const post = serve([], () =>
    reply(200, {
      added: [{ personId: kim.personId, email: kim.email }],
      updated: [{ personId: "00000000-0000-4000-8000-000000000002", email: "lee@example.com" }],
      skipped: [...REASONS.map(([reason], i) => ({ row: i + 4, email: `p${i}@example.com`, reason })), { row: 20, reason: "invalid_email" }],
    }),
  );
  render(withQueries(<Customers workspaceId={W} canEdit />));
  expect(screen.getByText(/name, email, company, opted_in, opted_in_on and country\. Only rows with opted_in set to yes are added\./)).toBeTruthy();
  const button = screen.getByRole("button", { name: "Import Customers" });
  expect((button as HTMLButtonElement).disabled).toBe(true);
  const csv = "name,email,opted_in\nKim,kim@example.com,yes";
  await userEvent.click(screen.getByLabelText("Or paste the CSV"));
  await userEvent.paste(csv);
  await userEvent.click(button);
  expect(post).toHaveBeenCalledWith("/api/w/{workspaceId}/customers/import", { params: { path: { workspaceId: W } }, body: { csv } });
  const result = await screen.findByText("Added 1 · Updated 1");
  const items = within(result.closest("[role=status]") as HTMLElement)
    .getAllByRole("listitem")
    .map((li) => li.textContent);
  expect(items).toEqual([...REASONS.map(([, words], i) => `Row ${i + 4}, p${i}@example.com. ${words}.`), "Row 20. Not added: not a valid email address."]);
  expect((screen.getByLabelText("Or paste the CSV") as HTMLTextAreaElement).value).toBe("");
});

test("an editor imports a CSV file", async () => {
  const post = serve([kim], () => reply(200, { added: [], updated: [{ personId: kim.personId, email: kim.email }], skipped: [] }));
  render(withQueries(<Customers workspaceId={W} canEdit />));
  const csv = "name,email,opted_in,country\nKim,kim@example.com,yes,US\n";
  await userEvent.upload(screen.getByLabelText(/A CSV file/, { selector: "input" }), new File([csv], "customers.csv", { type: "text/csv" }));
  await waitFor(() => expect((screen.getByLabelText("Or paste the CSV") as HTMLTextAreaElement).value).toBe(csv));
  await userEvent.click(screen.getByRole("button", { name: "Import Customers" }));
  expect(post).toHaveBeenCalledWith("/api/w/{workspaceId}/customers/import", { params: { path: { workspaceId: W } }, body: { csv } });
  expect(await screen.findByText("Added 0 · Updated 1")).toBeTruthy();
  expect(screen.queryByRole("list", { name: "Not added" })).toBeNull();
});

test.each([
  ["no_email_column", "The first row needs a column called email."],
  ["bad_quote", "A quote mark in this list isn't closed. Check the list and try again."],
])("a refused CSV (%s) says why in plain words", async (error, words) => {
  serve([], () => reply(400, { error }));
  render(withQueries(<Customers workspaceId={W} canEdit />));
  await userEvent.click(screen.getByLabelText("Or paste the CSV"));
  await userEvent.paste("name\nKim");
  await userEvent.click(screen.getByRole("button", { name: "Import Customers" }));
  expect((await screen.findByRole("alert")).textContent).toBe(words);
  expect(screen.queryByText(/^Added/)).toBeNull();
});
