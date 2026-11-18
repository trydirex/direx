// SPDX-License-Identifier: AGPL-3.0-only
// An Item's History names who did each step: a member by name, an agent by what it is. A draft also says what it was written from.
import { afterEach, expect, test, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { api } from "../client";
import { withQueries } from "../testing";
import { ItemPanel } from "./ItemPanel";

const W = "00000000-0000-4000-8000-0000000000aa";
const at = new Date().toISOString();
const item = { id: "i1", kind: "action", state: "needs_approval", reason: null, reasonCode: null, revision: 1, title: "First post", workArea: null, channel: "post", groupKey: null, groupLabel: null, at, warnings: [], clean: true, movable: true, decideBy: null, snoozedUntil: null, createdAt: at };
const timeline = [
  { at, from: null, to: "draft", reason: null, actor: { kind: "agent", id: "brand_reader" } },
  { at, from: "draft", to: "needs_approval", reason: null, actor: { kind: "person", id: "u1" } },
  { at, from: "needs_approval", to: "needs_approval", reason: null, actor: { kind: "person", id: "gone" } },
];

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

test("History names a member, falls back for someone who left, and names an agent", async () => {
  vi.spyOn(api, "GET").mockImplementation(((path: string) =>
    Promise.resolve({
      data: path === "/api/w/{workspaceId}/members" ? { members: [{ userId: "u1", email: "dom@acme.test", name: "Dominik", role: "owner", createdAt: at }] } : { item, content: { body: "Hi" }, timeline, ruleGrantedBy: null },
      response: new Response(null, { status: 200 }),
    })) as never);
  render(withQueries(<ItemPanel workspaceId={W} id="i1" role="owner" />));
  expect(await screen.findByText(/Needs approval, by Dominik/)).toBeTruthy();
  expect(screen.getByText(/Needs approval, by a person/)).toBeTruthy();
  expect(screen.getByText(/Draft, by Brand reader/)).toBeTruthy();
});

test("a draft shows what it was written from: its step, plan and Facts as links, and its Run by name", async () => {
  const writtenFrom = {
    run: { id: "00000000-0000-4000-8000-000000000001", agent: "recipient_writer", at: "2026-12-10T14:02:00Z" },
    planId: "p1",
    step: { campaignId: "c1", stepKey: "s3" },
    facts: [{ id: "f1", version: 2, text: "Reviewers are free" }],
    lessons: [{ id: "00000000-0000-4000-8000-000000000002", text: "Under 90 words" }],
    voice: true,
  };
  vi.spyOn(api, "GET").mockImplementation(((path: string) =>
    Promise.resolve({
      data: path === "/api/w/{workspaceId}/members" ? { members: [] } : { item: { ...item, groupLabel: "Launch email" }, content: { body: "Hi" }, timeline, ruleGrantedBy: null, writtenFrom },
      response: new Response(null, { status: 200 }),
    })) as never);
  render(withQueries(<ItemPanel workspaceId={W} id="i1" role="owner" />));
  const line = await screen.findByLabelText("Written from");
  expect(screen.getByRole("link", { name: "Launch email" }).getAttribute("href")).toBe(`/w/${W}/campaigns/c1?tab=drafts`);
  expect(screen.getByRole("link", { name: "Plan" }).getAttribute("href")).toBe(`/w/${W}/plans/p1`);
  expect(screen.getByRole("link", { name: "Fact: Reviewers are free" }).getAttribute("href")).toBe(`/w/${W}/brand`);
  expect(screen.getByRole("link", { name: "Your Tone" }).getAttribute("href")).toBe(`/w/${W}/brand`);
  expect(screen.getByRole("link", { name: "Lesson: Under 90 words" }).getAttribute("href")).toBe(`/w/${W}/brand/lessons`);
  expect(line.textContent).toContain("Email drafter, ");
  expect(line.querySelector("time")?.getAttribute("dateTime")).toBe("2026-12-10T14:02:00Z");
});

test("an Item with nothing recorded shows no Written from line", async () => {
  vi.spyOn(api, "GET").mockImplementation(((path: string) =>
    Promise.resolve({
      data: path === "/api/w/{workspaceId}/members" ? { members: [] } : { item, content: { body: "Hi" }, timeline, ruleGrantedBy: null, writtenFrom: null },
      response: new Response(null, { status: 200 }),
    })) as never);
  render(withQueries(<ItemPanel workspaceId={W} id="i1" role="owner" />));
  await screen.findByText(/Draft, by Brand reader/);
  expect(screen.queryByLabelText("Written from")).toBeNull();
});

test("History names the External token a proposal came through, and says External token for one it can't find", async () => {
  const T = "00000000-0000-4000-8000-0000000000bb";
  const fromTokens = [
    { at, from: null, to: "needs_approval", reason: null, actor: { kind: "system", id: `external_token:${T}` } },
    { at, from: "needs_approval", to: "needs_approval", reason: null, actor: { kind: "system", id: "external_token:00000000-0000-4000-8000-0000000000cc" } },
  ];
  vi.spyOn(api, "GET").mockImplementation(((path: string) =>
    Promise.resolve({
      data:
        path === "/api/w/{workspaceId}/members"
          ? { members: [] }
          : path === "/api/w/{workspaceId}/external-tokens"
            ? { tokens: [{ id: T, name: "Zapier" }], choices: { lifetimes: [], readers: [], kinds: [] } }
            : { item, content: { body: "Hi" }, timeline: fromTokens, ruleGrantedBy: null },
      response: new Response(null, { status: 200 }),
    })) as never);
  render(withQueries(<ItemPanel workspaceId={W} id="i1" role="viewer" />));
  expect(await screen.findByText(/Needs approval, by External token "Zapier"/)).toBeTruthy();
  expect(screen.getByText(/Needs approval, by External token$/)).toBeTruthy();
});

test("History doesn't ask for the tokens when no step came through one", async () => {
  const get = vi.spyOn(api, "GET").mockImplementation(((path: string) =>
    Promise.resolve({
      data: path === "/api/w/{workspaceId}/members" ? { members: [] } : { item, content: { body: "Hi" }, timeline, ruleGrantedBy: null },
      response: new Response(null, { status: 200 }),
    })) as never);
  render(withQueries(<ItemPanel workspaceId={W} id="i1" role="owner" />));
  await screen.findByText(/Draft, by Brand reader/);
  expect(get.mock.calls.map((c) => c[0])).not.toContain("/api/w/{workspaceId}/external-tokens");
});

