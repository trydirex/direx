// SPDX-License-Identifier: AGPL-3.0-only
// A Social account's posting hours in words; an Owner or Admin changes them or puts them back on the network's.
import { afterEach, expect, test, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { api } from "../client";
import { withQueries } from "../testing";
import { AccountPace } from "./Pace";

const W = "00000000-0000-4000-8000-0000000000aa";
const A = "00000000-0000-4000-8000-0000000000b1";
const reply = (status: number, body: unknown) => Promise.resolve({ ...(status < 400 ? { data: body } : { error: body }), response: new Response(null, { status }) });
const network = { from: 480, until: 1260, weekends: true, gapMinutes: 60 };
const none = { postingFrom: null, postingUntil: null, postingWeekends: null, gapMinutes: null };
const path = "/api/w/{workspaceId}/social/accounts/{accountId}/pace";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

test("anyone reads an account's posting hours in words; only an Owner or Admin gets Change", async () => {
  vi.spyOn(api, "GET").mockImplementation((() => reply(200, { own: none, defaults: network, pace: network, timeZone: "Europe/Berlin" })) as never);
  render(withQueries(<AccountPace workspaceId={W} accountId={A} name="Acme" mayEdit={false} />));
  expect(await screen.findByText("Posts go out 08:00 to 21:00 every day, at least 60 minutes apart, Europe/Berlin time. This is the network's pace. An Owner or Admin can change it.")).toBeTruthy();
  expect(screen.queryByRole("button", { name: "Change posting hours: Acme" })).toBeNull();
});

test("Change saves the account's own hours, a refusal says why, and they can go back to the network's", async () => {
  const own = { postingFrom: 540, postingUntil: 1020, postingWeekends: false, gapMinutes: 90 };
  const mine = { from: 540, until: 1020, weekends: false, gapMinutes: 90 };
  const get = vi.spyOn(api, "GET").mockImplementation((() => reply(200, { own: none, defaults: network, pace: network, timeZone: "UTC" })) as never);
  const put = vi.spyOn(api, "PUT").mockImplementationOnce((() => reply(400, { error: "bad_pace" })) as never).mockImplementation((() => reply(200, { ok: true })) as never);
  render(withQueries(<AccountPace workspaceId={W} accountId={A} name="Acme" mayEdit />));
  await userEvent.click(await screen.findByRole("button", { name: "Change posting hours: Acme" }));
  for (const [label, value] of [["From", "09:00"], ["Until", "17:00"], ["Minutes apart", "90"]] as const) {
    const field = screen.getByLabelText(label);
    await userEvent.clear(field);
    await userEvent.type(field, value);
  }
  await userEvent.click(screen.getByLabelText("Weekends too"));
  await userEvent.click(screen.getByRole("button", { name: "Save" }));
  expect(await screen.findByRole("alert")).toHaveProperty("textContent", "Pick an end time after the start time, and a gap of 0 to 720 minutes.");
  get.mockImplementation((() => reply(200, { own, defaults: network, pace: mine, timeZone: "UTC" })) as never);
  await userEvent.click(screen.getByRole("button", { name: "Save" }));
  expect(put).toHaveBeenLastCalledWith(path, { params: { path: { workspaceId: W, accountId: A } }, body: own });
  expect(await screen.findByText("Posts go out 09:00 to 17:00 on weekdays, at least 90 minutes apart, UTC time.")).toBeTruthy();
  await userEvent.click(screen.getByRole("button", { name: "Change posting hours: Acme" }));
  await userEvent.click(screen.getByRole("button", { name: "Use the network's pace" }));
  expect(put).toHaveBeenLastCalledWith(path, { params: { path: { workspaceId: W, accountId: A } }, body: none });
});

test("a failed first read explains what happened and can be retried", async () => {
  vi.spyOn(api, "GET")
    .mockImplementationOnce((() => reply(502, undefined)) as never)
    .mockImplementation((() => reply(200, { own: none, defaults: network, pace: network, timeZone: "UTC" })) as never);
  render(withQueries(<AccountPace workspaceId={W} accountId={A} name="Acme" mayEdit />));
  expect(await screen.findByRole("alert")).toHaveProperty("textContent", "Couldn't load posting hours.");
  await userEvent.click(screen.getByRole("button", { name: "Retry" }));
  expect(await screen.findByRole("button", { name: "Change posting hours: Acme" })).toBeTruthy();
});

test("an in-flight save blocks Cancel and Reset; network and empty HTTP failures keep the draft", async () => {
  const pending = Promise.withResolvers<never>();
  vi.spyOn(api, "GET").mockImplementation((() => reply(200, { own: { ...none, gapMinutes: 60 }, defaults: network, pace: network, timeZone: "UTC" })) as never);
  const put = vi.spyOn(api, "PUT")
    .mockImplementationOnce(() => pending.promise)
    .mockImplementationOnce((() => reply(502, undefined)) as never);
  render(withQueries(<AccountPace workspaceId={W} accountId={A} name="Acme" mayEdit />));
  await userEvent.click(await screen.findByRole("button", { name: "Change posting hours: Acme" }));
  const gap = screen.getByLabelText("Minutes apart");
  await userEvent.clear(gap);
  await userEvent.type(gap, "90");
  const save = screen.getByRole("button", { name: "Save" });
  await userEvent.click(save);
  await userEvent.click(screen.getByRole("button", { name: "Cancel" }));
  await userEvent.click(screen.getByRole("button", { name: "Use the network's pace" }));
  expect(put).toHaveBeenCalledTimes(1);
  expect(screen.queryByRole("button", { name: "Change posting hours: Acme" })).toBeNull();
  pending.reject(new TypeError("Connection failed"));
  expect(await screen.findByRole("alert")).toHaveProperty("textContent", "That didn't save. Try again.");
  expect(screen.getByLabelText("Minutes apart")).toHaveProperty("value", "90");
  await userEvent.click(save);
  expect(put).toHaveBeenCalledTimes(2);
  expect(await screen.findByRole("alert")).toHaveProperty("textContent", "That didn't save. Try again.");
  expect(screen.getByLabelText("Minutes apart")).toHaveProperty("value", "90");
});
