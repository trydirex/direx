// SPDX-License-Identifier: AGPL-3.0-only
import { afterEach, expect, test } from "vitest";
import { QueryClientProvider, useQuery } from "@tanstack/react-query";
import { act, cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryBoundary } from "@/components/QueryBoundary";
import { messageFor } from "./messages";
import { ApiError, call, inWorkspace, makeQueryClient, ME } from "./query";

afterEach(cleanup);

const res = (status: number) => new Response(null, { status });
const ok = <T,>(data: T) => Promise.resolve({ data, response: res(200) });
const refused = (status: number, error: string) => Promise.resolve({ error: { error }, response: res(status) });

function Name(p: { workspaceId: string; load: (w: string) => Promise<string> }) {
  const query = useQuery({ queryKey: inWorkspace(p.workspaceId, "name"), queryFn: () => p.load(p.workspaceId) });
  return <QueryBoundary query={query}>{(name) => <h1>{name}</h1>}</QueryBoundary>;
}
function setup(ui: React.ReactNode) {
  const client = makeQueryClient();
  client.setDefaultOptions({ queries: { retry: false } });
  const view = render(<QueryClientProvider client={client}>{ui}</QueryClientProvider>);
  return { client, ...view, rerender: (next: React.ReactNode) => view.rerender(<QueryClientProvider client={client}>{next}</QueryClientProvider>) };
}

test("call returns the data, or throws the API's error code with its status", async () => {
  expect(await call(ok({ a: 1 }))).toEqual({ a: 1 });
  await expect(call(refused(403, "forbidden"))).rejects.toMatchObject({ status: 403, code: "forbidden" });
  await expect(call(Promise.resolve({ response: res(500) }))).rejects.toMatchObject({ status: 500, code: "failed" });
});

test("first load shows a loading state, then the data", async () => {
  let resolve!: (v: string) => void;
  setup(<Name workspaceId="w1" load={() => new Promise((r) => (resolve = r))} />);
  expect(screen.getByRole("status").textContent).toBe("Loading");
  act(() => resolve("Contoso"));
  expect(await screen.findByRole("heading", { name: "Contoso" })).toBeTruthy();
});

test("a failed first load says why and Retry loads again", async () => {
  let fail = true;
  setup(<Name workspaceId="w1" load={() => (fail ? call(refused(403, "forbidden")) : Promise.resolve("Contoso"))} />);
  expect((await screen.findByRole("alert")).textContent).toContain("Your role doesn't allow that.");
  fail = false;
  await userEvent.click(screen.getByRole("button", { name: "Retry" }));
  expect(await screen.findByRole("heading", { name: "Contoso" })).toBeTruthy();
});

test("a read that can't exist says so with no Retry: a 404, or a 400 for a malformed id", async () => {
  for (const [status, code] of [[404, "not_found"], [400, "id: Invalid UUID"]] as const) {
    setup(<Name workspaceId="w1" load={() => call(refused(status, code))} />);
    expect((await screen.findByRole("alert")).textContent).toBe("We couldn't find that. It may have been removed.");
    expect(screen.queryByRole("button", { name: "Retry" })).toBeNull();
    cleanup();
  }
});

test("a failed refresh keeps what was loaded and says so quietly", async () => {
  let fail = false;
  const { client } = setup(<Name workspaceId="w1" load={() => (fail ? Promise.reject(new TypeError("fetch failed")) : Promise.resolve("Contoso"))} />);
  await screen.findByRole("heading", { name: "Contoso" });
  fail = true;
  await act(() => client.refetchQueries());
  expect((await screen.findByRole("status")).textContent).toContain("Direx couldn't be reached");
  expect(screen.getByRole("heading", { name: "Contoso" })).toBeTruthy();
});

test("switching Workspace never shows the previous Workspace's data", async () => {
  const pending: Record<string, (v: string) => void> = {};
  const load = (w: string) => (w === "w1" ? Promise.resolve("Contoso") : new Promise<string>((r) => (pending[w] = r)));
  const { rerender } = setup(<Name workspaceId="w1" load={load} />);
  await screen.findByRole("heading", { name: "Contoso" });
  rerender(<Name workspaceId="w2" load={load} />);
  expect(screen.queryByRole("heading", { name: "Contoso" })).toBeNull();
  expect(screen.getByRole("status").textContent).toBe("Loading");
  act(() => pending.w2!("Direx"));
  expect(await screen.findByRole("heading", { name: "Direx" })).toBeTruthy();
});

test("a 401 drops everything cached and marks the person signed out", async () => {
  const { client } = setup(<Name workspaceId="w1" load={() => Promise.resolve("Contoso")} />);
  client.setQueryData(ME, { id: "u1" });
  await screen.findByRole("heading", { name: "Contoso" });
  await expect(client.fetchQuery({ queryKey: inWorkspace("w1", "x"), queryFn: () => call(refused(401, "unauthorized")) })).rejects.toBeInstanceOf(ApiError);
  expect(client.getQueryData(ME)).toBeNull();
  expect(client.getQueryData(inWorkspace("w1", "name"))).toBeUndefined();
});

test("a 401 keeps what is the same for anyone, such as the sign-in buttons", async () => {
  const client = makeQueryClient();
  await client.fetchQuery({ queryKey: ["sign-in-options"], queryFn: () => ({ google: true }), meta: { sameForAnyone: true } });
  await expect(client.fetchQuery({ queryKey: [...ME, "workspaces"], queryFn: () => call(refused(401, "unauthorized")) })).rejects.toBeInstanceOf(ApiError);
  expect(client.getQueryData(["sign-in-options"])).toEqual({ google: true });
});

test("a 404 inside a Workspace reads the person's Workspaces again, in case they were removed", async () => {
  const { client } = setup(<Name workspaceId="w1" load={() => Promise.resolve("Contoso")} />);
  client.setQueryData([...ME, "workspaces"], [{ id: "w1" }]);
  await expect(client.fetchQuery({ queryKey: inWorkspace("w1", "x"), queryFn: () => call(refused(404, "not_found")) })).rejects.toBeInstanceOf(ApiError);
  expect(client.getQueryState([...ME, "workspaces"])?.isInvalidated).toBe(true);
  client.setQueryData([...ME, "workspaces"], [{ id: "w1" }]);
  await expect(client.fetchQuery({ queryKey: ["server", "x"], queryFn: () => call(refused(404, "not_found")) })).rejects.toBeInstanceOf(ApiError);
  expect(client.getQueryState([...ME, "workspaces"])?.isInvalidated).toBe(false);
});

test("messages: a screen's own codes win, common codes are shared, anything else is generic", () => {
  expect(messageFor(new ApiError(404, "not_found"), { not_found: "That lesson is gone." })).toBe("That lesson is gone.");
  expect(messageFor(new ApiError(403, "forbidden"))).toBe("Your role doesn't allow that.");
  expect(messageFor(new ApiError(400, "something_new"))).toBe("That didn't work. Try again.");
  expect(messageFor(new TypeError("fetch failed"))).toContain("couldn't be reached");
  expect(messageFor("odd")).toBe("That didn't work. Try again.");
  expect(messageFor(new ApiError(502, "failed"))).toContain("couldn't be reached");
  expect(messageFor(new ApiError(500, "failed"))).toBe("That didn't work. Try again.");
});
