// SPDX-License-Identifier: AGPL-3.0-only
// The sign-in card and the reset page drive Better Auth over plain fetch: each test types and
// clicks as a person would, then checks the request sent and what the card says after.
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { api } from "../client";
import { withQueries } from "../testing";
import { AddPassword, ResetPassword, SignIn } from "./SignIn";

let fetchSpy: ReturnType<typeof vi.spyOn>;
let assign: ReturnType<typeof vi.fn>;
/** Answers every fetch with `status` and `body`. */
const answer = (status: number, body: unknown = {}) => fetchSpy.mockResolvedValue(new Response(JSON.stringify(body), { status }));
const sent = () => {
  const [path, init] = fetchSpy.mock.lastCall as [string, RequestInit];
  return { path, body: JSON.parse(init.body as string) as Record<string, unknown> };
};

beforeEach(() => {
  fetchSpy = vi.spyOn(globalThis, "fetch");
  assign = vi.fn();
  vi.spyOn(window, "location", "get").mockReturnValue({ ...window.location, assign } as Location);
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

async function fill(email: string, password?: string) {
  await userEvent.type(screen.getByLabelText("Email"), email);
  if (password !== undefined) await userEvent.type(screen.getByLabelText(/^Password/), password);
}

test("the sign-in page links to this server's source code", () => {
  render(<SignIn callbackURL="/" />);
  expect(screen.getByRole("link", { name: "Get the source code" }).getAttribute("href")).toBe("/api/source");
});

test("signing in with a password posts it and goes to the callback", async () => {
  answer(200);
  render(<SignIn callbackURL="/w/1" />);
  await fill("sam@example.com", "correct horse battery");
  await userEvent.click(screen.getByRole("button", { name: "Sign in" }));
  await vi.waitFor(() => expect(assign).toHaveBeenCalledWith("/w/1"));
  expect(sent()).toEqual({ path: "/api/auth/sign-in/email", body: { email: "sam@example.com", password: "correct horse battery", callbackURL: "/w/1" } });
});

test("a wrong password says so and stays on the card", async () => {
  answer(401);
  render(<SignIn callbackURL="/" />);
  await fill("sam@example.com", "nope");
  await userEvent.click(screen.getByRole("button", { name: "Sign in" }));
  expect((await screen.findByRole("alert")).textContent).toContain("That email and password don't match.");
  expect(assign).not.toHaveBeenCalled();
});

test("signing up asks to confirm the address when no session comes back", async () => {
  answer(200, { token: null });
  render(<SignIn callbackURL="/" />);
  await userEvent.click(screen.getByRole("button", { name: "New here? Sign up" }));
  expect(screen.getByRole("heading", { name: "Sign up for Direx" })).toBeTruthy();
  await fill("new@example.com", "twelve chars ok");
  await userEvent.click(screen.getByRole("button", { name: "Sign up" }));
  expect(await screen.findByText("Check new@example.com for a link to confirm your address, then sign in.")).toBeTruthy();
  expect(sent().path).toBe("/api/auth/sign-up/email");
});

test("signing up with a session goes straight to the callback", async () => {
  answer(200, { token: "t" });
  render(<SignIn callbackURL="/next" initialMode="sign_up" />);
  await fill("new@example.com", "twelve chars ok");
  await userEvent.click(screen.getByRole("button", { name: "Sign up" }));
  await vi.waitFor(() => expect(assign).toHaveBeenCalledWith("/next"));
});

test("an invite link's token is handed to the server before anyone signs in", async () => {
  answer(200, { ok: true });
  const token = "a".repeat(64);
  render(<SignIn callbackURL="/invite/w/t" inviteToken={token} />);
  await vi.waitFor(() => expect(sent()).toEqual({ path: "/api/admission/token", body: { token } }));
});

test("a refused password sign-up shows the server's reason", async () => {
  const message = "This server takes invited people only. Ask whoever runs it for an invite.";
  answer(400, { code: "SIGNUP_REFUSED", message });
  render(<SignIn callbackURL="/" initialMode="sign_up" />);
  await fill("new@example.com", "twelve chars ok");
  await userEvent.click(screen.getByRole("button", { name: "Sign up" }));
  expect(await screen.findByText(message)).toBeTruthy();
});

test("a refusal sent back by a magic link or Google shows on the card, in fixed words", () => {
  vi.spyOn(window, "location", "get").mockReturnValue({ ...window.location, search: "?error=SIGNUP_UNVERIFIED&error_description=Anything", assign } as Location);
  render(<SignIn callbackURL="/" />);
  expect(screen.getByText("Your sign-in provider didn't confirm this email address. Sign up with your email address instead.")).toBeTruthy();
  expect(screen.queryByText("Anything")).toBeNull();
});

test("a bad, expired or used email link says so and asks for a new one", () => {
  vi.spyOn(window, "location", "get").mockReturnValue({ ...window.location, search: "?error=INVALID_TOKEN", assign } as Location);
  render(<SignIn callbackURL="/" />);
  expect(screen.getByText("That sign-in link has expired or was already used. Ask for a new one below.")).toBeTruthy();
});

test("an error code Direx doesn't know shows nothing", () => {
  vi.spyOn(window, "location", "get").mockReturnValue({ ...window.location, search: "?error=SOMETHING_ELSE", assign } as Location);
  render(<SignIn callbackURL="/" />);
  expect(screen.queryByRole("alert")).toBeNull();
});

test("Forgot your password sends a reset link, and Back to sign in returns", async () => {
  answer(200);
  render(<SignIn callbackURL="/" />);
  await userEvent.click(screen.getByRole("button", { name: "Forgot your password?" }));
  expect(screen.getByRole("heading", { name: "Reset your password" })).toBeTruthy();
  expect(screen.queryByLabelText(/^Password/)).toBeNull();
  await userEvent.click(screen.getByRole("button", { name: "Back to sign in" }));
  await userEvent.click(screen.getByRole("button", { name: "Forgot your password?" }));
  await fill("sam@example.com");
  await userEvent.click(screen.getByRole("button", { name: "Email me a reset link" }));
  expect(await screen.findByText(/If sam@example.com has a sign-in here, we sent it a reset link/)).toBeTruthy();
  expect(sent()).toEqual({ path: "/api/auth/request-password-reset", body: { email: "sam@example.com", redirectTo: "/reset-password" } });
});

test("the email link needs an address first, then sends one", async () => {
  answer(200);
  render(<SignIn callbackURL="/" />);
  await userEvent.click(screen.getByRole("button", { name: "Email me a sign-in link" }));
  expect((await screen.findByRole("alert")).textContent).toContain("Enter your email address first.");
  expect(fetchSpy).not.toHaveBeenCalled();
  await fill("sam@example.com");
  await userEvent.click(screen.getByRole("button", { name: "Email me a sign-in link" }));
  expect(await screen.findByText(/Check sam@example.com for a sign-in link/)).toBeTruthy();
  expect(sent().path).toBe("/api/auth/sign-in/magic-link");
});

test("Google goes to the provider's page; Microsoft not set up says so", async () => {
  answer(200, { url: "https://accounts.google.com/o" });
  render(<SignIn callbackURL="/" />);
  await userEvent.click(screen.getByRole("button", { name: "Continue with Google" }));
  await vi.waitFor(() => expect(assign).toHaveBeenCalledWith("https://accounts.google.com/o"));
  expect(sent().body).toEqual({ provider: "google", callbackURL: "/", errorCallbackURL: "/" });
  answer(404);
  await userEvent.click(screen.getByRole("button", { name: "Continue with Microsoft" }));
  expect((await screen.findByRole("alert")).textContent).toContain("That sign-in option isn't set up on this server.");
});

test("ResetPassword without a token says the link is spent", () => {
  render(<ResetPassword token={null} />);
  expect(screen.getByText(/This reset link has expired or was already used/)).toBeTruthy();
});

test("an expired reset link offers a new one, and a sent screen goes back to the form", async () => {
  answer(200);
  render(<ResetPassword token={null} />);
  await userEvent.click(screen.getByRole("button", { name: "Send me a new link" }));
  expect(screen.getByRole("heading", { name: "Reset your password" })).toBeTruthy();
  await fill("sam@example.com");
  await userEvent.click(screen.getByRole("button", { name: "Email me a reset link" }));
  await userEvent.click(await screen.findByRole("button", { name: "Use a different email" }));
  expect(screen.getByRole("button", { name: "Email me a reset link" })).toBeTruthy();
});

test("ResetPassword changes the password, or says why not", async () => {
  answer(400);
  render(<ResetPassword token="tok" />);
  await userEvent.type(screen.getByLabelText(/^New password/), "a brand new password");
  await userEvent.click(screen.getByRole("button", { name: "Change password" }));
  expect((await screen.findByRole("alert")).textContent).toContain("If the link has expired, ask for a new one.");
  expect(sent()).toEqual({ path: "/api/auth/reset-password", body: { token: "tok", newPassword: "a brand new password" } });
  answer(200);
  await userEvent.click(screen.getByRole("button", { name: "Change password" }));
  expect(await screen.findByText(/Your password is changed/)).toBeTruthy();
});

test("adding a password posts it, says it is set, and a stale sign-in or an existing password is explained", async () => {
  const post = vi.spyOn(api, "POST");
  const reply = (status: number, body: unknown) => Promise.resolve({ ...(status < 400 ? { data: body } : { error: body }), response: new Response(null, { status }) });
  const submit = async () => {
    await userEvent.type(screen.getByLabelText(/^Password/), "correct horse battery");
    await userEvent.click(screen.getByRole("button", { name: "Add password" }));
  };

  post.mockImplementationOnce((() => reply(409, { error: "password_already_set" })) as never);
  render(withQueries(<AddPassword />));
  await submit();
  expect(await screen.findByText(/already has a password/)).toBeTruthy();
  expect(post).toHaveBeenLastCalledWith("/api/account/password", { body: { password: "correct horse battery" } });
  cleanup();

  post.mockImplementationOnce((() => reply(200, { ok: true })) as never);
  render(withQueries(<AddPassword />));
  await submit();
  expect(await screen.findByText(/Your password is set/)).toBeTruthy();
  cleanup();

  post.mockImplementationOnce((() => reply(403, { error: "step_up_required" })) as never);
  render(withQueries(<AddPassword />));
  await submit();
  expect(await screen.findByText("Confirm it's you")).toBeTruthy();  cleanup();

  // The API's length check, for a browser that let a short one through.
  post.mockImplementationOnce((() => reply(400, { error: "password: Too small: expected string to have >=12 characters" })) as never);
  render(withQueries(<AddPassword />));
  await submit();
  expect((await screen.findByRole("alert")).textContent).toBe("Use at least 12 characters.");
});
