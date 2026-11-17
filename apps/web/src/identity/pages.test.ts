// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment happy-dom
// Smoke test for the identity pages: each renders with a mocked client, the copy uses the
// glossary's terms, and a role change that needs step-up waits and then runs once.
import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { expect, test, vi } from "vitest";
import { api } from "../client";
import { AcceptInvite } from "./AcceptInvite";
import { CreateOrg } from "./CreateOrg";
import { Members } from "./Members";
import { signInWithPassword, signUpWithPassword } from "./auth";
import { ResetPassword, SignIn } from "./SignIn";
import { applyChange, savePending, takePending } from "./step-up";
import { WorkspaceSwitcher } from "./WorkspaceSwitcher";
import { withQueries, selectOptions } from "../testing";

// Rendering to a string runs no effects, so only the step-up test reaches the client.
const patch = vi.spyOn(api, "PATCH");

const W = "00000000-0000-4000-8000-0000000000aa";
const render = (el: Parameters<typeof renderToString>[0]) => renderToString(el).replaceAll("<!-- -->", "");
const ws = (id: string, name: string, org: string) => ({ id, name, role: "owner" as const, organization: { id: `org-${org}`, name: org } });

test("every page renders, in Organization and Workspace terms", () => {
  const switcher = createElement(WorkspaceSwitcher, { workspaces: [ws(W, "Shop", "Acme"), ws("w2", "Blog", "Acme"), ws("w3", "Cafe", "Beta")], current: W, onSwitch: () => {} });
  const pages = {
    signIn: render(withQueries(createElement(SignIn, { callbackURL: "/" }))),
    createOrg: render(createElement(CreateOrg, { onCreated: () => {} })),
    switcher: render(switcher),
    members: render(withQueries(createElement(Members, { workspace: ws(W, "Shop", "Acme") }))),
    accept: render(withQueries(createElement(AcceptInvite, { workspaceId: W, token: "t", onJoined: () => {} }))),
  };
  expect(pages.signIn).toContain("Continue with Google");
  expect(pages.signIn).toContain("Continue with Microsoft");
  expect(pages.createOrg).toContain("Business name");
  expect(pages.createOrg).toContain("Setting up for clients?");
  // One group per Organization.
  expect(selectOptions(switcher).Workspace?.groups).toBe(2);
  expect(selectOptions(switcher).Workspace?.options).toContain("New organization or client…");
  // The Workspace's name is in the top bar, so the title doesn't repeat it.
  expect(pages.members).toMatch(/<h1[^>]*>Members<\/h1>/);
  expect(pages.members).toContain("Send invite");
  expect(pages.accept).toContain("Join a Workspace");
  for (const html of Object.values(pages)) expect(html).not.toMatch(/\b(tenant|account|project)\b/i);
});

test("the sign-in page leads with Google and Microsoft, then a password, in each mode, and keeps the other ways in", () => {
  const page = (initialMode: "sign_in" | "sign_up" | "forgot") => render(withQueries(createElement(SignIn, { callbackURL: "/", initialMode })));
  const signIn = page("sign_in");
  expect(signIn.indexOf("Continue with Google")).toBeLessThan(signIn.indexOf('type="password"'));
  expect(signIn).toContain("Nothing goes out until you approve it.");
  expect(signIn.indexOf('type="password"')).toBeGreaterThan(-1);
  expect(signIn.indexOf('type="password"')).toBeLessThan(signIn.indexOf("Email me a sign-in link"));
  expect(signIn).toContain("current-password");
  expect(signIn).toContain("Forgot your password?");
  expect(signIn).toContain("Sign up");

  const signUp = page("sign_up");
  expect(signUp).toMatch(/minlength="12"/i);
  expect(signUp).toContain("new-password");
  expect(signUp).toContain("Back to sign in");
  expect(signUp).toContain("Sign up for Direx");

  const forgot = page("forgot");
  expect(forgot).not.toContain('type="password"');
  expect(forgot).toContain("Email me a reset link");

  for (const html of [signIn, signUp, forgot]) {
    expect(html).toContain("Continue with Google");
    expect(html).not.toMatch(/\b(tenant|account|project)\b/i);
  }
  const stepUp = render(withQueries(createElement(SignIn, { title: "Confirm it's you", callbackURL: "/x" })));
  expect(stepUp).toContain('type="password"');
});

test("the reset page asks for a password, and says so when the link is bad", () => {
  expect(render(createElement(ResetPassword, { token: "t" }))).toContain("New password");
  expect(render(createElement(ResetPassword, { token: null }))).toContain("expired");
});

test.each([
  [401, "don't match"],
  [403, "Confirm your email"],
  [429, "too many tries"],
])("a %i from password sign-in explains itself", async (status, text) => {
  const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("{}", { status }));
  await expect(signInWithPassword("a@b.c", "p", "/")).rejects.toThrow(text);
  fetchMock.mockRestore();
});

test("sign-up tells a ready session from one that needs the email link, and explains a taken address", async () => {
  const fetchMock = vi.spyOn(globalThis, "fetch");
  fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ token: "t" })));
  expect(await signUpWithPassword("a@b.c", "p".repeat(12), "/")).toBe("signed_in");
  fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ token: null })));
  expect(await signUpWithPassword("a@b.c", "p".repeat(12), "/")).toBe("confirm");
  fetchMock.mockResolvedValueOnce(new Response("{}", { status: 422 }));
  await expect(signUpWithPassword("a@b.c", "p".repeat(12), "/")).rejects.toThrow("already has a sign-in");
  fetchMock.mockRestore();
});

test("a change refused for step-up waits in storage and is taken once, for its Workspace only", async () => {
  patch.mockResolvedValueOnce({ error: { error: "step_up_required" } } as never).mockResolvedValueOnce({ data: { ok: true } } as never);
  const change = { workspaceId: W, userId: "u1", role: "viewer" as const };
  expect(await applyChange(change)).toBe("step_up_required");

  const store = new Map<string, string>();
  const storage = { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v), removeItem: (k: string) => void store.delete(k) } as Storage;
  savePending(change, storage);
  expect(takePending("another-workspace", storage)).toBeNull();
  savePending(change, storage);
  const pending = takePending(W, storage);
  expect(pending).toEqual(change);
  expect(takePending(W, storage)).toBeNull();
  expect(await applyChange(pending!)).toBeNull();
  expect(patch).toHaveBeenLastCalledWith("/api/w/{workspaceId}/members/{userId}", { params: { path: { workspaceId: W, userId: "u1" } }, body: { role: "viewer" } });
});
