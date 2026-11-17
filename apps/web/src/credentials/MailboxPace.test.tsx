// SPDX-License-Identifier: AGPL-3.0-only
// A Mailbox's pace in words, changed with a small form; a refusal says who may change it.
import { afterEach, expect, test, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { api } from "../client";
import { choose, withQueries } from "../testing";
import { clock, MailboxPace, minutes, WorkspaceZone } from "./MailboxPace";

const W = "00000000-0000-4000-8000-0000000000aa";
const M = "00000000-0000-4000-8000-0000000000c1";
const reply = (status: number, body: unknown) => Promise.resolve({ ...(status < 400 ? { data: body } : { error: body }), response: new Response(null, { status }) });
const pace = { dailyLimit: 50, sendFrom: 540, sendUntil: 1020, sendWeekends: false };

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

test("times read and write as HH:MM", () => {
  expect(clock(540)).toBe("09:00");
  expect(minutes("17:30")).toBe(1050);
});

test("a Mailbox's pace reads in words; Change saves the new values, and a refusal says who may change it", async () => {
  vi.spyOn(api, "GET").mockImplementation((() => reply(200, { pace, timeZone: "Europe/Berlin" })) as never);
  const put = vi.spyOn(api, "PUT").mockImplementationOnce((() => reply(403, { error: "forbidden" })) as never).mockImplementationOnce((() => reply(200, { ok: true })) as never);
  render(withQueries(<MailboxPace workspaceId={W} credentialId={M} name="me@acme.test" mayEdit />));
  expect(await screen.findByText(/^Sends up to 50 a day, 09:00 to 17:00 on weekdays, Europe\/Berlin time\./)).toBeTruthy();
  await userEvent.click(screen.getByRole("button", { name: "Change pace: me@acme.test" }));
  const perDay = screen.getByLabelText("Emails a day");
  await userEvent.clear(perDay);
  await userEvent.type(perDay, "120");
  await userEvent.click(screen.getByLabelText("Weekends too"));
  await userEvent.click(screen.getByRole("button", { name: "Save" }));
  expect(await screen.findByRole("alert")).toHaveProperty("textContent", "Only whoever connected this email account can set its first pace. After that, an Owner or Admin changes it.");
  await userEvent.click(screen.getByRole("button", { name: "Save" }));
  expect(put).toHaveBeenLastCalledWith("/api/w/{workspaceId}/mailboxes/{credentialId}/pace", { params: { path: { workspaceId: W, credentialId: M } }, body: { ...pace, dailyLimit: 120, sendWeekends: true } });
  expect(screen.queryByRole("button", { name: "Save" })).toBeNull();
});

test("an Admin picks the Workspace's time zone from a list; a refused name is answered in words; others only read it", async () => {
  vi.spyOn(api, "GET").mockImplementation((() => reply(200, { timeZone: "UTC" })) as never);
  const put = vi.spyOn(api, "PUT").mockImplementationOnce((() => reply(400, { error: "bad_time_zone" })) as never).mockImplementationOnce((() => reply(200, { ok: true })) as never);
  render(withQueries(<WorkspaceZone workspaceId={W} mayEdit />));
  await choose("Time zone", "America/New_York");
  await userEvent.click(screen.getByRole("button", { name: "Save time zone" }));
  expect(await screen.findByRole("alert")).toHaveProperty("textContent", "That isn't a time zone Direx knows. Pick one from the list, such as Europe/Berlin.");
  await choose("Time zone", "Europe/Berlin");
  await userEvent.click(screen.getByRole("button", { name: "Save time zone" }));
  expect(put).toHaveBeenLastCalledWith("/api/w/{workspaceId}/time-zone", { params: { path: { workspaceId: W } }, body: { timeZone: "Europe/Berlin" } });
  cleanup();
  render(withQueries(<WorkspaceZone workspaceId={W} mayEdit={false} />));
  expect(await screen.findByText("Days and sending hours are in UTC time.")).toBeTruthy();
}, 15_000);

test("someone who may not change it sees the pace and no Change button", async () => {
  vi.spyOn(api, "GET").mockImplementation((() => reply(200, { pace: { ...pace, sendUntil: 1440, sendWeekends: true }, timeZone: "UTC" })) as never);
  render(withQueries(<MailboxPace workspaceId={W} credentialId={M} name="me@acme.test" mayEdit={false} />));
  expect(await screen.findByText(/09:00 to midnight every day, UTC time\./)).toBeTruthy();
  expect(screen.queryByRole("button", { name: /Change pace/ })).toBeNull();
});
